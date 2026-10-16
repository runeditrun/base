import { cp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { imageFolder } from './container.mjs';
import { missing, invalid } from './errors.mjs';
import { DEMO_FILES } from '../modules/demo-host/plan.mjs';
import { prepareNative } from '../modules/demo-host/native/prepare.mjs';
import { TESTING_SECRET } from '../modules/demo-host/measurement.mjs';
import { awaitCertificates } from '../modules/demo-host/certificate.mjs';

export async function nativeDemoCommand(project, options, store, signal, out, operation, app, plan) {
  const folder = join(project.root, '.rer/demo-host');
  await rm(folder, { recursive: true, force: true });
  await mkdir(join(folder, 'modules/demo-host/native'), { recursive: true, mode: 0o700 });
  await store.step('Building the native demo Worker bundle and static assets');
  await imageFolder(project, operation, app, { output: join(folder, 'image'), engine: 'workerd' });
  for (const file of DEMO_FILES) await cp(new URL(`../modules/demo-host/${file}`, import.meta.url), join(folder, 'modules/demo-host', file));
  for (const file of ['worker', 'visitor', 'loader', 'd1', 'sql']) await cp(new URL(`../modules/demo-host/native/${file}.mjs`, import.meta.url), join(folder, `modules/demo-host/native/${file}.mjs`));
  for (const directory of ['container', 'deploy-kit']) await cp(new URL(`../modules/${directory}/`, import.meta.url), join(folder, 'modules', directory), { recursive: true });
  // Runtime imports use the same module topology as the maintained source.
  const bundle = await prepareNative(folder);
  const config = { ...plan.wrangler, main: 'modules/demo-host/native/worker.mjs', compatibility_flags: ['nodejs_compat'],
    assets: { directory: './assets', binding: 'ASSETS', run_worker_first: true }, worker_loaders: [{ binding: 'LOADER' }],
    durable_objects: { bindings: [{ name: 'DEMO', class_name: 'NativeDemo' }, { name: 'CAPACITY', class_name: 'DemoCapacity' }] },
    migrations: [{ tag: 'native-v1', new_sqlite_classes: ['NativeDemo', 'DemoCapacity'] }] };
  delete config.containers;
  config.vars.NATIVE_SOURCE_DIGEST = bundle.digest;
  if (process.env.RER_NATIVE_TEST_TTL_MS && TESTING_SECRET.test(process.env.TURNSTILE_SECRET_KEY ?? '')) {
    if (!/^[1-9][0-9]{2,6}$/.test(process.env.RER_NATIVE_TEST_TTL_MS)) throw invalid('RER_NATIVE_TEST_TTL_MS must be positive milliseconds');
    config.vars.NATIVE_TEST_TTL_MS = process.env.RER_NATIVE_TEST_TTL_MS;
  }
  await writeFile(join(folder, 'wrangler.json'), JSON.stringify(config, null, 2) + '\n');
  const summary = { worker: plan.worker, origin: plan.origin, mode: 'loader', digest: bundle.digest, modules: Object.keys(bundle.modules).length, minutes: 60, idleMinutes: 15 };
  if (options.dryRun) return { dryRun: true, deployed: false, demo: summary };
  const required = ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY'];
  if (required.some(name => !process.env[name]?.trim())) throw missing(`${required.join(', ')} are required`);
  const testing = TESTING_SECRET.test(process.env.TURNSTILE_SECRET_KEY);
  const measurement = testing ? process.env.RER_DEMO_MEASUREMENT_TOKEN || randomBytes(32).toString('base64url') : undefined;
  const secrets = { TURNSTILE_SECRET_KEY: process.env.TURNSTILE_SECRET_KEY, ...(measurement ? { RER_DEMO_MEASUREMENT_TOKEN: measurement } : {}),
    ...(process.env.RER_DEMO_OPERATOR_TOKEN ? { RER_DEMO_OPERATOR_TOKEN: process.env.RER_DEMO_OPERATOR_TOKEN } : {}) };
  const secretFile = join(folder, '.secrets.json');
  await writeFile(secretFile, JSON.stringify(secrets), { mode: 0o600 });
  try {
    const require = createRequire(join(project.root, 'package.json')), manifest = require.resolve('wrangler/package.json');
    const wrangler = join(dirname(manifest), JSON.parse(await readFile(manifest, 'utf8')).bin.wrangler);
    await store.run('Deploying the native demo host', process.execPath, [wrangler, 'deploy', '--config', 'wrangler.json', '--secrets-file', '.secrets.json', '--message', plan.record], { cwd: folder, signal });
  } finally { await rm(secretFile, { force: true }); }
  if (measurement) await writeFile(join(folder, 'measurement-token'), measurement, { mode: 0o600 });
  await awaitCertificates({ hostnames: plan.hostnames, report: line => store.report(line) });
  out.human(`Native demo deployed: ${plan.origin} (Worker Loader, one SQLite Durable Object per visitor; edge static assets).`);
  return { deployed: true, demo: summary };
}
