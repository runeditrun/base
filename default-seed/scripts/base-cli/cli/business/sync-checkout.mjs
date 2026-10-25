import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveProject } from '../project.mjs';
import { selectedOrigin } from '../local.mjs';
import { heldDeployments } from '../deployment-record.mjs';
import { routeRunning } from '../door-mode.mjs';
import { serverRegistry, stopInstruction } from '../server-registry.mjs';
import { originUrl, pause } from './api.mjs';
import { failed } from './sync-app.mjs';

export async function checkout(root) {
 let project;
 try { project = await resolveProject(root); }
 catch { throw Object.assign(Error('This checkout is not a runnable Base seed. Run rer business sync inside the app checkout.'), { code: 'business_checkout_not_seed' }); }
 if (project.profile !== 'first-party' || !project.adapter?.hooks?.secrets) throw Object.assign(Error('This checkout is not a runnable Base seed. Run rer business sync inside the app checkout.'), { code: 'business_checkout_not_seed' });
 let edition;
 try { edition = JSON.parse(await readFile(join(root, 'edition.json'), 'utf8')).id; }
 catch (error) { if (error.code !== 'ENOENT') throw Error('The checkout edition.json could not be read.'); }
 const seed = edition ?? project.descriptor.project;
 if (typeof seed !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(seed)) throw Error('This checkout does not declare its edition.');
 return { project, seed };
}

export function sameSeed(remote, local) {
 // The catalogue uses a slug; edition manifests use publisher/slug.
 return remote === local || remote === local.split('/').at(-1);
}

// This checkout's registered server, whatever its verb: the registry answers
// for one verb at a time and refuses a server of another. A dev server that
// is still starting has no origin yet; it is waited for within the budget.
async function registeredServer(project, signal) {
 if (!(await selectedOrigin(project, {})).savedOrigin) return null;
 const registry = await serverRegistry(project.root);
 try {
  for (;;) {
   const record = await registered(registry);
   if (record?.mode !== 'dev' || record.url) return record;
   try { await pause(250, signal); } catch { throw failed('The app is still starting, so nothing was changed. Run rer business sync again once it answers.'); }
  }
 } finally { await registry.close(); }
}
async function registered(registry) {
 for (const mode of ['dev', 'preview', 'demo']) {
  try { return await registry.existing(mode, { supplied: new Set() }); }
  catch (error) { if (error.code !== 'safety_refusal' || mode === 'demo') throw error; }
 }
}

// On loopback the document goes only to this checkout's registered dev server,
// at the origin it registered: once the app stops, an unrelated process may
// hold its saved port.
async function devOrigin(record) {
 if (record?.mode !== 'dev' || !record.url) return undefined;
 await routeRunning(record);
 return record.url;
}
// --leave is also the recovery path: a saved origin, registry or server it
// cannot check means no restart to wait for, not a refusal.
export const runningApp = (project, signal) => registeredServer(project, signal).then(devOrigin).catch(error => { if (error.code !== 'safety_refusal') throw error; });

// A preview or demo of this checkout takes no settings: that is said before
// anything is written.
export async function appOrigins(project, signal) {
 const record = await registeredServer(project, signal);
 if (record && record.mode !== 'dev') throw failed(`This checkout is running rer ${record.mode}, which does not take Business settings, so nothing was saved. Stop it with ${stopInstruction(record)}, then run rer business sync.`, 'business_checkout_busy');
 const running = await devOrigin(record), origins = running ? [running] : [];
 const deployed = await heldDeployments(project.root);
 const production = deployed.find(item => item.environment === 'production');
 if (production?.record.receipt?.origin) origins.push(originUrl(production.record.receipt.origin));
 return { origins: [...new Set(origins)], running };
}
