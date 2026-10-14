import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { contained } from './project.mjs';
import { invalid, missing, refuse, RerError } from './errors.mjs';
import { imageFolder } from './container.mjs';
import { DEMO_FILES, demoPlan } from '../modules/demo-host/plan.mjs';

// `rer deploy --demo [--dry-run]`: the seed's hosted demo at demo.<domain>
// (modules/demo-host), from deploy-demo.json. It writes .rer/demo-host/: the
// front Worker, its wrangler.json and the container image folder (workerd
// engine). --dry-run stops there, so `wrangler dev` can serve that folder with
// Docker; a deploy runs `wrangler deploy` on it with the Turnstile secret.
export async function demoHostCommand(project, options, store, signal, out, operation) {
 const read = async path => { try { return JSON.parse(await readFile(await contained(project.root, path), 'utf8')); } catch (error) { if (error instanceof RerError) throw error; throw invalid(`Missing or malformed ${path}.`); } };
 const app = await read(project.adapter.deploy?.declaration ?? 'deploy.json'), declaration = await read('deploy-demo.json');
 if (!(app.platforms ?? ['workers']).includes('container')) throw refuse('A hosted demo runs the seed\'s container image: declare "container" in deploy.json platforms first.');
 let plan;
 try { plan = demoPlan({ project: app.project, environment: options.environment ?? 'production', compatibilityDate: app.compatibilityDate, originVar: app.originVar, declaration, turnstileSiteKey: process.env.TURNSTILE_SITE_KEY?.trim() }); }
 catch (error) { throw invalid(`The demo deploy declaration is invalid (${error.message}). deploy-demo.json holds {"version": 1, "domain": "<run site apex>", "name": "<product name>"}, optionally "maxInstances" and plain "settings".`); }
 const folder = join(project.root, '.rer', 'demo-host');
 await rm(folder, { recursive: true, force: true });
 await mkdir(folder, { recursive: true, mode: 0o700 });
 await store.step('Building the demo container image (workerd engine)');
 await imageFolder(project, operation, app, { output: join(folder, 'image'), engine: 'workerd' });
 for (const file of DEMO_FILES) await cp(new URL(`../modules/demo-host/${file}`, import.meta.url), join(folder, file));
 await writeFile(join(folder, 'wrangler.json'), JSON.stringify(plan.wrangler, null, 2) + '\n');
 const summary = { worker: plan.worker, origin: plan.origin, hostname: plan.hostname, folder: '.rer/demo-host', maxInstances: plan.maxInstances, settings: plan.settings, instanceType: 'basic', startsPerIpPerMinute: 3, minutes: 60, idleMinutes: 15, enableInternet: false };
 const human = [`Demo plan: Worker ${summary.worker} on ${summary.hostname} (custom domain; workers.dev off), written to ${summary.folder}`,
  `  one container per visitor (basic, at most ${summary.maxInstances} at once, no internet, RER_DEMO=1), 3 starts per IP per minute behind Turnstile`,
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
 await writeFile(secrets, JSON.stringify({ TURNSTILE_SECRET_KEY: process.env.TURNSTILE_SECRET_KEY.trim() }), { mode: 0o600 });
 try {
  const wrangler = createRequire(join(project.root, 'package.json')).resolve('wrangler/bin/wrangler.js');
  await store.run('Deploying the demo Worker and its container image', process.execPath, [wrangler, 'deploy', '--config', 'wrangler.json', '--secrets-file', '.secrets.json'], { cwd: folder, signal });
 } finally { await rm(secrets, { force: true }); }
 return { dryRun: false, deployed: true, origin: plan.origin, demo: summary };
}
