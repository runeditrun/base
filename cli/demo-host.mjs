import { readFile } from 'node:fs/promises';
import { contained } from './project.mjs';
import { invalid, missing, RerError } from './errors.mjs';
import { demoPlan } from '../modules/demo-host/plan.mjs';
import { demoRunDeclaration } from '../modules/demo/declaration.mjs';

export async function demoHostCommand(project, options, store, signal, out, operation) {
 const read = async path => { try { return JSON.parse(await readFile(await contained(project.root, path), 'utf8')); } catch (error) { if (error instanceof RerError) throw error; throw invalid(`Missing or malformed ${path}.`); } };
 const app = await read(project.adapter.deploy?.declaration ?? 'deploy.json'), declaration = await read('deploy-demo.json');
 // Old releases wrote sizing and mode selectors. Consume their removal here
 // so pinning this release needs no per-seed declaration edit.
 const { instanceType: retiredSize, mode: retiredMode, ...nativeInput } = declaration;
 const nativeDeclaration = await demoRunDeclaration(nativeInput, { root: project.root, adapter: project.adapter, read });
 if (retiredSize !== undefined || retiredMode !== undefined) store.report('Hosted demos now use the native Loader host; remove the retired instanceType and mode keys from deploy-demo.json.');
 let plan;
 try { plan = demoPlan({ project: app.project, environment: options.environment ?? 'production', compatibilityDate: app.compatibilityDate, originVar: app.originVar, hostVariables: app.container?.hostVariables, declaration: nativeDeclaration, turnstileSiteKey: process.env.TURNSTILE_SITE_KEY?.trim() }); }
 catch (error) { throw invalid(`The demo deploy declaration is invalid (${error.message}). deploy-demo.json holds version, domain, name, and optionally maxInstances, ownerEmail, runUrl and plain settings.`); }
 if (options.remove) return removeDemo(plan, store, signal);
 if (process.env.RER_DEMO_OPERATOR_TOKEN && (process.env.RER_DEMO_OPERATOR_TOKEN.length < 32 || process.env.RER_DEMO_OPERATOR_TOKEN.length > 512)) throw invalid('RER_DEMO_OPERATOR_TOKEN must contain 32 to 512 characters.');
 const supplied = process.env.RER_DEMO_MEASUREMENT_TOKEN?.trim();
 if (supplied && (supplied.length < 32 || supplied.length > 512 || /[\s;,]/.test(supplied))) throw invalid('RER_DEMO_MEASUREMENT_TOKEN must contain 32 to 512 characters, with no spaces, semicolons or commas.');
 return (await import('./demo-native.mjs')).nativeDemoCommand(project, options, store, signal, out, operation, app, plan);
}

async function removeDemo(plan, store, signal) {
 const names = ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'];
 if (names.some(name => !process.env[name]?.trim())) throw missing(`${names.join(' and ')} are required to remove the demo; see DEMO.md "Removing a hosted demo".`);
 const { cloudflare } = await import('../modules/deploy-kit/provider.mjs');
 const { providerRefusal } = await import('../modules/deploy-kit/diagnostics.mjs');
 const { demoRemove } = await import('../modules/demo-host/remove.mjs');
 const { demoRemovalFetch } = await import('./demo-removal-provider.mjs');
 await store.step(`Removing the demo Worker ${plan.worker} on ${plan.hostnames.join(', ')}`);
 let result;
 try { result = await demoRemove({ api: cloudflare({ accountId: process.env.CLOUDFLARE_ACCOUNT_ID, token: process.env.CLOUDFLARE_API_TOKEN, fetch: demoRemovalFetch(signal) }), plan }); }
 catch (error) {
  if (error instanceof RerError) throw error;
  const code = /^[a-z0-9-]{1,80}$/.test(error.message) ? error.message : 'demo-remove-failed';
  const detail = [error.resource && `(${error.resource})`, error.remaining?.length && `still listed: ${error.remaining.join(', ')}`, providerRefusal(error)].filter(Boolean).join('; ');
  throw new RerError('deploy_refused', `Demo remove stopped: ${code}${detail ? ` ${detail}` : ''}. Nothing that is not the demo's was touched; run it again once the cause is fixed.`, 1);
 }
 store.report(result.alreadyRemoved ? `deploy --demo --remove: no demo Worker ${plan.worker} exists; nothing to remove.` : `Removed ${result.removed.join(', ')} and read back that each is gone.`);
 return { removed: true, demo: { worker: plan.worker, hostname: plan.hostname, hostnames: plan.hostnames }, deleted: result.removed, alreadyRemoved: Boolean(result.alreadyRemoved) };
}
