import { cp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { demoBundle } from './demo-build.mjs';
import { upgradeDemo } from '../modules/demo-host/upgrade.mjs';
import { missing, invalid, RerError } from './errors.mjs';
import { DEMO_FILES } from '../modules/demo-host/plan.mjs';
import { cloudflare } from '../modules/deploy-kit/provider.mjs';
import { RUNTIME_FILES } from '../modules/demo-host/native/config.mjs';
import { prepareNative } from '../modules/demo-host/native/prepare.mjs';
import { TESTING_SECRET } from '../modules/demo-host/measurement.mjs';
import { awaitCertificates } from '../modules/demo-host/certificate.mjs';

export async function nativeDemoCommand(project, options, store, signal, out, operation, app, plan) {
  const folder = join(project.root, '.rer/demo-host');
  await rm(folder, { recursive: true, force: true });
  await mkdir(join(folder, 'modules/demo-host/native'), { recursive: true, mode: 0o700 });
  const label = 'Building the native demo Worker bundle and static assets';
  await store.step(label);
  await demoBundle(project, operation, app, join(folder, 'bundle'), store, label, signal);
  for (const file of DEMO_FILES) await cp(new URL(`../modules/demo-host/${file}`, import.meta.url), join(folder, 'modules/demo-host', file));
  for (const file of RUNTIME_FILES) await cp(new URL(`../modules/demo-host/native/${file}.mjs`, import.meta.url), join(folder, `modules/demo-host/native/${file}.mjs`));
  for (const directory of ['deploy-kit']) await cp(new URL(`../modules/${directory}/`, import.meta.url), join(folder, 'modules', directory), { recursive: true });
  await mkdir(join(folder, 'modules/container'), { recursive: true });
  for (const file of ['migrations.mjs', 'demo-egress.mjs']) await cp(new URL(`../modules/container/${file}`, import.meta.url), join(folder, 'modules/container', file));
  // Runtime imports use the same module topology as the maintained source.
  let bundle;
  try { bundle = await prepareNative(folder); }
  catch (error) {
    // The reason (a refused module names its file) goes to the output and the capture log.
    const reason = store.redact(`${label} failed: ${error.message}`);
    store.report(reason);
    throw new RerError('command_failed', reason, 1);
  }
  const config = { ...plan.wrangler, main: 'modules/demo-host/native/worker.mjs', compatibility_flags: ['nodejs_compat'],
    assets: { directory: './assets', binding: 'ASSETS', run_worker_first: true }, worker_loaders: [{ binding: 'LOADER' }],
  };
  config.vars.NATIVE_SOURCE_DIGEST = bundle.digest;
  if (process.env.RER_NATIVE_TEST_TTL_MS && TESTING_SECRET.test(process.env.TURNSTILE_SECRET_KEY ?? '')) {
    if (!/^[1-9][0-9]{2,6}$/.test(process.env.RER_NATIVE_TEST_TTL_MS)) throw invalid('RER_NATIVE_TEST_TTL_MS must be positive milliseconds');
    config.vars.NATIVE_TEST_TTL_MS = process.env.RER_NATIVE_TEST_TTL_MS;
  }
  await writeFile(join(folder, 'wrangler.json'), JSON.stringify(config, null, 2) + '\n');
  const summary = { worker: plan.worker, origin: plan.origin, mode: 'loader', digest: bundle.digest, modules: Object.keys(bundle.modules).length, minutes: 60, idleMinutes: 15 };
  if (options.dryRun) {
    if (options.json) out.event('demo', { ...summary, hostnames: plan.hostnames, routes: config.routes });
    else out.human(`Native demo plan: ${plan.origin} (Worker Loader), written to .rer/demo-host`);
    return { dryRun: true, deployed: false, demo: summary };
  }
  const required = ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY'];
  if (required.some(name => !process.env[name]?.trim())) throw missing(`${required.join(', ')} are required`);
  const api = cloudflare({ accountId: process.env.CLOUDFLARE_ACCOUNT_ID, token: process.env.CLOUDFLARE_API_TOKEN });
  config.migrations = await upgradeDemo({ api, plan, report: line => store.report(line) });
  await writeFile(join(folder, 'wrangler.json'), JSON.stringify(config, null, 2) + '\n');
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
