import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveProject } from '../project.mjs';
import { selectedOrigin } from '../local.mjs';
import { heldDeployments } from '../deployment-record.mjs';
import { routeRunning } from '../door-mode.mjs';
import { serverRegistry } from '../server-registry.mjs';
import { originUrl } from './api.mjs';

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

// On loopback the document goes only to this checkout's registered dev server,
// at the origin it registered: once the app stops, an unrelated process may
// hold its saved port.
export async function appOrigins(project) {
 const origins = [];
 let running;
 if ((await selectedOrigin(project, {})).savedOrigin) {
  const registry = await serverRegistry(project.root);
  try {
   const record = await registry.existing('dev', { supplied: new Set() });
   if (record?.url) { await routeRunning(record); running = record.url; }
  }
  finally { await registry.close(); }
 }
 if (running) origins.push(running);
 const deployed = await heldDeployments(project.root);
 const production = deployed.find(item => item.environment === 'production');
 if (production?.record.receipt?.origin) origins.push(originUrl(production.record.receipt.origin));
 return { origins: [...new Set(origins)], running };
}
