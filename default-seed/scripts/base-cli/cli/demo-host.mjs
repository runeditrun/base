import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { contained } from './project.mjs';
import { invalid, missing, refuse, RerError } from './errors.mjs';
import { imageFolder } from './container.mjs';
import { prepareDemoImage } from '../modules/demo-host/image.mjs';
import { DEMO_FILES, INSTANCE_TYPES, demoPlan } from '../modules/demo-host/plan.mjs';

// `rer deploy --demo [--dry-run]`: the seed's hosted demo at demo.<domain>
// (modules/demo-host), from deploy-demo.json. It writes .rer/demo-host/: the
// front Worker, its wrangler.json and the container image folder (workerd
// engine). --dry-run stops there, so `wrangler dev` can serve that folder with
// Docker; a deploy runs `wrangler deploy` on it with the Turnstile secret and
// the demo's record as the version message. `--remove --yes` removes what that
// record proves is the demo's (modules/demo-host/remove.mjs).
export async function demoHostCommand(project, options, store, signal, out, operation) {
 const read = async path => { try { return JSON.parse(await readFile(await contained(project.root, path), 'utf8')); } catch (error) { if (error instanceof RerError) throw error; throw invalid(`Missing or malformed ${path}.`); } };
 const app = await read(project.adapter.deploy?.declaration ?? 'deploy.json'), declaration = await read('deploy-demo.json');
 if (!(app.platforms ?? ['workers']).includes('container')) throw refuse('A hosted demo runs the seed\'s container image: declare "container" in deploy.json platforms first.');
 let plan;
 try { plan = demoPlan({ project: app.project, environment: options.environment ?? 'production', compatibilityDate: app.compatibilityDate, originVar: app.originVar, declaration, turnstileSiteKey: process.env.TURNSTILE_SITE_KEY?.trim() }); }
 catch (error) { throw invalid(`The demo deploy declaration is invalid (${error.message}). deploy-demo.json holds {"version": 1, "domain": "<run site apex>", "name": "<product name>"}, optionally "maxInstances", "instanceType" (${INSTANCE_TYPES.join(', ')}; default basic) and plain "settings".`); }
 if (options.remove) return removeDemo(plan, store);
 if (process.env.RER_DEMO_OPERATOR_TOKEN && (process.env.RER_DEMO_OPERATOR_TOKEN.length < 32 || process.env.RER_DEMO_OPERATOR_TOKEN.length > 512)) throw invalid('RER_DEMO_OPERATOR_TOKEN must contain 32 to 512 characters.');
 const folder = join(project.root, '.rer', 'demo-host');
 await rm(folder, { recursive: true, force: true });
 await mkdir(folder, { recursive: true, mode: 0o700 });
 await store.step('Building the demo container image (workerd engine)');
 await imageFolder(project, operation, { ...app, secrets: [...(app.secrets ?? []), { binding: 'RER_DEMO_OPERATOR_TOKEN' }, { binding: 'TURNSTILE_SECRET_KEY' }] }, { output: join(folder, 'image'), engine: 'workerd' });
 await prepareDemoImage(join(folder, 'image'));
 for (const file of DEMO_FILES) await cp(new URL(`../modules/demo-host/${file}`, import.meta.url), join(folder, file));
 await writeFile(join(folder, 'wrangler.json'), JSON.stringify(plan.wrangler, null, 2) + '\n');
 const summary = { worker: plan.worker, origin: plan.origin, hostname: plan.hostname, folder: '.rer/demo-host', maxInstances: plan.maxInstances, settings: plan.settings, instanceType: plan.instanceType, startsPerIpPerMinute: 3, minutes: 60, idleMinutes: 15, enableInternet: true };
 const human = [`Demo plan: Worker ${summary.worker} on ${summary.hostname} (custom domain; workers.dev off), written to ${summary.folder}`,
  `  one container per visitor (${summary.instanceType}, at most ${summary.maxInstances} at once, public internet, RER_DEMO=1), 3 starts per IP per minute behind Turnstile`,
  `  each demo ends after 60 minutes or 15 idle minutes; its container is destroyed and its state deleted`];
 if (options.dryRun) {
  if (options.json) out.event('demo', summary); else for (const line of human) out.human(line);
  store.report('deploy --demo: dry run complete; no deployment occurred and no provider request was made.');
  return { dryRun: true, deployed: false, demo: summary };
 }
 const names = ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY'];
 if (names.some(name => !process.env[name]?.trim())) throw missing(`${names.join(', ')} are required; see DEMO.md "Hosting the demo".`);
 if (!options.json) for (const line of human) out.human(line);
 const secrets = join(folder, '.secrets.json');
 await writeFile(secrets, JSON.stringify({ TURNSTILE_SECRET_KEY: process.env.TURNSTILE_SECRET_KEY.trim(), ...(process.env.RER_DEMO_OPERATOR_TOKEN ? { RER_DEMO_OPERATOR_TOKEN: process.env.RER_DEMO_OPERATOR_TOKEN } : {}) }), { mode: 0o600 });
 try {
  const require = createRequire(join(project.root, 'package.json'));
  const manifest = require.resolve('wrangler/package.json');
  const wrangler = join(dirname(manifest), JSON.parse(await readFile(manifest, 'utf8')).bin.wrangler);
  await store.run('Deploying the demo Worker and its container image', process.execPath, [wrangler, 'deploy', '--config', 'wrangler.json', '--secrets-file', '.secrets.json', '--message', plan.record], { cwd: folder, signal });
 } finally { await rm(secrets, { force: true }); }
 return { dryRun: false, deployed: true, origin: plan.origin, demo: summary };
}

async function removeDemo(plan, store) {
 const names = ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'];
 if (names.some(name => !process.env[name]?.trim())) throw missing(`${names.join(' and ')} are required to remove the demo; see DEMO.md "Removing a hosted demo".`);
 const { cloudflare } = await import('../modules/deploy-kit/provider.mjs');
 const { providerRefusal } = await import('../modules/deploy-kit/diagnostics.mjs');
 const { demoRemove } = await import('../modules/demo-host/remove.mjs');
 await store.step(`Removing the demo Worker ${plan.worker} on ${plan.hostname}`);
 let result;
 try { result = await demoRemove({ api: cloudflare({ accountId: process.env.CLOUDFLARE_ACCOUNT_ID, token: process.env.CLOUDFLARE_API_TOKEN }), plan }); }
 catch (error) {
  if (error instanceof RerError) throw error;
  const code = /^[a-z0-9-]{1,80}$/.test(error.message) ? error.message : 'demo-remove-failed';
  const detail = [error.resource && `(${error.resource})`, error.remaining?.length && `still listed: ${error.remaining.join(', ')}`, providerRefusal(error)].filter(Boolean).join('; ');
  throw new RerError('deploy_refused', `Demo remove stopped: ${code}${detail ? ` ${detail}` : ''}. Nothing that is not the demo's was touched; run it again once the cause is fixed.`, 1);
 }
 store.report(result.alreadyRemoved ? `deploy --demo --remove: no demo Worker ${plan.worker} exists; nothing to remove.` : `Removed ${result.removed.join(', ')} and read back that each is gone.`);
 return { removed: true, demo: { worker: plan.worker, hostname: plan.hostname }, deleted: result.removed, alreadyRemoved: Boolean(result.alreadyRemoved) };
}
