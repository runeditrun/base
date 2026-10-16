import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { DEMO_FILES } from '../plan.mjs';

test('Loader demos claim and seed two isolated native apps, serve edge assets, and erase on expiry', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'rer-native-demo-'));
  const base = resolve(import.meta.dirname, '../../..');
  let mf;
  try {
    await cp(join(base, 'modules'), join(folder, 'modules'), { recursive: true });
    await mkdir(join(folder, 'cli'));
    await cp(join(base, 'cli/scheduled.mjs'), join(folder, 'cli/scheduled.mjs'));
    const source = name => readFile(join(base, name), 'utf8');
    const sql = 'CREATE TABLE owner(email TEXT PRIMARY KEY); CREATE TABLE items(name TEXT PRIMARY KEY);';
    const bundle = { digest: 'fixture-native-app', compatibilityDate: '2026-09-08', compatibilityFlags: ['nodejs_compat'], database: 'DB', vars: {}, crons: [], assetPaths: ['/assets/fixture-12345678.js'],
      migrations: [{ name: '0001_items.sql', sql, sha256: createHash('sha256').update(sql).digest('hex'), statements: sql.split(';').filter(Boolean) }],
      modules: {
        '_rer/isolate.js': { js: (await source('modules/demo-host/native/isolate.mjs')).replace('__RER_APP_ENTRY__', '../app/modules/demo-host/tests/native-app.mjs') },
        '_rer/d1.js': { js: await source('modules/demo-host/native/d1.mjs') },
        '_rer/sql.js': { js: await source('modules/demo-host/native/sql.mjs') },
        'app/modules/demo-host/tests/native-app.mjs': { js: await source('modules/demo-host/tests/native-app.mjs') },
        'app/modules/owner-claim/verify.mjs': { js: await source('modules/owner-claim/verify.mjs') },
        'app/modules/operator-auth/loopback.mjs': { js: await source('modules/operator-auth/loopback.mjs') },
      } };
    await writeFile(join(folder, 'modules/demo-host/native/bundle.mjs'), `export default ${JSON.stringify(bundle)};`);
    const origin = 'https://demo.example.test', measurement = 'fixture-measurement-token-1234567890123456';
    const files = ['modules/demo-host/native/worker.mjs', ...['visitor', 'loader', 'd1', 'sql', 'bundle'].map(file => `modules/demo-host/native/${file}.mjs`),
      ...DEMO_FILES.map(file => `modules/demo-host/${file}`), 'modules/container/migrations.mjs', ...['sql-safety', 'sql-tokens', 'migration-ledger', 'validation'].map(file => `modules/deploy-kit/${file}.mjs`)];
    mf = new Miniflare(convertV4MiniflareOptions({ modulesRoot: folder, modules: files.map(path => ({ type: 'ESModule', path: join(folder, path) })),
      compatibilityDate: '2026-09-08', compatibilityFlags: ['nodejs_compat'], workerLoaders: { LOADER: {} },
      durableObjects: { DEMO: { className: 'NativeDemo', useSQLite: true }, CAPACITY: { className: 'DemoCapacity', useSQLite: true } },
      ratelimits: { STARTS: { namespace_id: '1001', simple: { limit: 3, period: 60 } } },
      bindings: { DEMO_ORIGIN: origin, DEMO_SITE: 'https://example.test', DEMO_NAME: 'Test', DEMO_ORIGIN_VAR: 'AUTH_ORIGIN', DEMO_MAX_INSTANCES: '10', DEMO_SETTINGS: '{}',
        TURNSTILE_SITE_KEY: 'fixture-site-key', TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA', RER_DEMO_MEASUREMENT_TOKEN: measurement, NATIVE_TEST_TTL_MS: '6000' },
      serviceBindings: { ASSETS: () => new Response('fixture-asset') },
      outboundService: request => { assert.equal(request.url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify'); return Response.json({ success: true }); },
    }));
    const fetch = (path, cookies = '', init = {}) => mf.dispatchFetch(origin + path, { redirect: 'manual', ...init, headers: { cookie: cookies, origin, ...init.headers } });
    const start = async ip => {
      const jar = new Map([['rer_demo_measure', measurement]]);
      let response = await fetch('/__demo/start', [...jar].map(([k,v]) => `${k}=${v}`).join('; '), { method: 'POST', body: new URLSearchParams({ 'cf-turnstile-response': 'passed' }), headers: { 'cf-connecting-ip': ip } });
      for (let attempt = 0; attempt < 30; attempt++) {
        for (const cookie of response.headers.getSetCookie()) { const [name, ...value] = cookie.split(';')[0].split('='); jar.set(name, value.join('=')); }
        if (response.status !== 202) break;
        response = await fetch('/__demo/status', [...jar].map(([k,v]) => `${k}=${v}`).join('; '));
      }
      assert.equal(response.status, 303, await response.text());
      return [...jar].map(([k,v]) => `${k}=${v}`).join('; ');
    };
    assert.equal((await fetch('/')).status, 200);
    const [a, b] = await Promise.all([start('203.0.113.1'), start('203.0.113.2')]);
    assert.equal((await fetch('/items', a, { method: 'POST', body: 'visitor-a' })).status, 200);
    assert.deepEqual(await (await fetch('/items', b)).json(), [{ name: 'sample' }]);
    const replay = b.replace(/rer_demo=[^;]+/, a.match(/rer_demo=[^;]+/)[0]);
    assert.equal((await fetch('/items', replay)).status, 401);
    assert.equal((await fetch('/items', 'rer_demo=forged')).status, 303);
    const asset = await fetch('/assets/fixture-12345678.js');
    assert.equal(await asset.text(), 'fixture-asset');
    assert.ok(asset.headers.get('cache-control').includes('immutable'));
    await new Promise(resolve => setTimeout(resolve, 6500));
    assert.equal((await fetch('/items', a)).status, 410);
    assert.equal((await fetch('/items', b)).status, 410);
  } finally { await mf?.dispose(); await rm(folder, { recursive: true, force: true }); }
});
