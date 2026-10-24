import { cp, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { RUNTIME_FILES } from '../native/config.mjs';
import { prepareNative } from '../native/prepare.mjs';
import { DEMO_FILES } from '../plan.mjs';

export const declarations = [{ name: 'ENVELOPE_RECORD_KEY', generate: 'base64' }, { name: 'RECORD_AUDIT_KEY', generate: 'hex' }];
export const origin = 'https://demo.example.test';
export async function secretHost(folder, { baselineVisitor, generatedSecrets = declarations, log, handleStructuredLogs, persist } = {}) {
  const base = resolve(import.meta.dirname, '../../..');
  await cp(join(base, 'modules'), join(folder, 'modules'), { recursive: true });
  if (baselineVisitor) await writeFile(join(folder, 'modules/demo-host/native/visitor.mjs'), baselineVisitor);
  const app = join(folder, 'bundle/app'), server = join(app, 'dist/server');
  for (const file of ['modules/demo-host/tests/secret-app.mjs', 'modules/owner-claim/verify.mjs', 'modules/operator-auth/loopback.mjs']) await cp(join(base, file), join(server, file));
  await mkdir(join(app, 'dist/client'), { recursive: true });
  const sql = 'CREATE TABLE company(id INTEGER PRIMARY KEY, iv TEXT, data TEXT);';
  const config = { main: 'modules/demo-host/tests/secret-app.mjs', compatibility_date: '2026-09-08', no_bundle: true,
    rules: [{ type: 'ESModule', globs: ['**/*.js', '**/*.mjs'] }], d1_databases: [{ binding: 'DB' }] };
  const migrations = { DB: [{ name: '0001.sql', sql, sha256: createHash('sha256').update(sql).digest('hex'), statements: [sql] }] };
  await writeFile(join(app, 'demo.json'), JSON.stringify({ config, migrations, generatedSecrets }));
  await prepareNative(folder);
  const files = ['modules/demo-host/native/worker.mjs', ...[...RUNTIME_FILES.filter(file => file !== 'worker'), 'bundle'].map(file => `modules/demo-host/native/${file}.mjs`),
    ...DEMO_FILES.map(file => `modules/demo-host/${file}`), ...['migrations', 'demo-egress'].map(file => `modules/container/${file}.mjs`),
    ...['sql-safety', 'sql-tokens', 'migration-ledger', 'validation'].map(file => `modules/deploy-kit/${file}.mjs`)];
  const options = convertV4MiniflareOptions({ name: 'secret-test', unsafeInspectDurableObjects: true, modulesRoot: folder,
    modules: files.map(path => ({ type: 'ESModule', path: join(folder, path) })),
    compatibilityDate: '2026-09-08', compatibilityFlags: ['nodejs_compat'], workerLoaders: { LOADER: {} },
    durableObjects: { DEMO: { className: 'NativeDemo', useSQLite: true }, CAPACITY: { className: 'DemoCapacity', useSQLite: true } },
    ratelimits: { STARTS: { namespace_id: '1002', simple: { limit: 3, period: 60 } } },
    bindings: { DEMO_ORIGIN: origin, DEMO_SITE: 'https://example.test', DEMO_NAME: 'Payroll', DEMO_ORIGIN_VAR: 'AUTH_ORIGIN', DEMO_MAX_INSTANCES: '10', DEMO_SETTINGS: '{}',
      TURNSTILE_SITE_KEY: 'fixture-site-key', TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA', RER_DEMO_MEASUREMENT_TOKEN: 'fixture-measurement-token-1234567890123456' },
    serviceBindings: { ASSETS: () => new Response('asset') },
    outboundService: request => { if (request.url !== 'https://challenges.cloudflare.com/turnstile/v0/siteverify') throw new Error('Unexpected network request'); return Response.json({ success: true }); },
    ...(persist ? { isolatedResourcePersistencePath: persist } : {}), ...(log ? { log } : {}), ...(handleStructuredLogs ? { handleStructuredLogs } : {}),
  });
  return { options, mf: new Miniflare(options) };
}
export const fetchCopy = (mf, path, cookie = '', init = {}) => mf.dispatchFetch(origin + path, { redirect: 'manual', ...init, headers: { cookie, origin, ...init.headers } });
export async function startCopy(mf, ip) {
  let cookie = 'rer_demo_measure=fixture-measurement-token-1234567890123456';
  let response = await fetchCopy(mf, '/__demo/start', cookie, { method: 'POST', body: new URLSearchParams({ 'cf-turnstile-response': 'passed' }), headers: { 'cf-connecting-ip': ip } });
  for (let attempt = 0; attempt < 100; attempt++) {
    const visitor = response.headers.getSetCookie().find(value => value.startsWith('rer_demo='));
    if (visitor) cookie = `${cookie.split(';')[0]}; ${visitor.split(';')[0]}`;
    if (response.status !== 202) return { cookie, response };
    await response.body?.cancel();
    response = await fetchCopy(mf, '/__demo/status', cookie);
  }
  throw new Error('Demo start did not settle');
}
