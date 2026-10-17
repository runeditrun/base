import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { RUNTIME_FILES } from '../native/config.mjs';
import { prepareNative } from '../native/prepare.mjs';
import { DEMO_FILES } from '../plan.mjs';

test('Loader demos claim and seed two isolated native apps, serve edge assets, and erase on expiry', async () => {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'rer-native-demo-')));
  const base = resolve(import.meta.dirname, '../../..');
  let mf;
  try {
    await cp(join(base, 'modules'), join(folder, 'modules'), { recursive: true });
    // The seed's Worker build as rer deploy --demo receives it, including a tiny
    // WebAssembly module (add) and a data module the app imports.
    const app = join(folder, 'bundle/app'), server = join(app, 'dist/server');
    for (const file of ['modules/demo-host/tests/native-app.mjs', 'modules/owner-claim/verify.mjs', 'modules/operator-auth/loopback.mjs']) await cp(join(base, file), join(server, file));
    await writeFile(join(server, 'modules/demo-host/tests/native-add.wasm'), Buffer.from('0061736d0100000001070160027f7f017f030201000707010361646400000a09010700200020016a0b', 'hex'));
    await writeFile(join(server, 'modules/demo-host/tests/native-data.bin'), Buffer.from([7, 8, 9]));
    await mkdir(join(app, 'dist/client/assets'), { recursive: true });
    await writeFile(join(app, 'dist/client/assets/fixture-12345678.js'), 'fixture');
    const sql = 'CREATE TABLE owner(email TEXT PRIMARY KEY); CREATE TABLE items(name TEXT PRIMARY KEY); CREATE TABLE jobs(name TEXT PRIMARY KEY);';
    const config = { main: 'modules/demo-host/tests/native-app.mjs', compatibility_date: '2026-09-08', no_bundle: true, rules: [{ type: 'ESModule', globs: ['**/*.js', '**/*.mjs'] }],
      d1_databases: [{ binding: 'DB' }, { binding: 'SECOND' }], r2_buckets: [{ binding: 'FILES' }],
      durable_objects: { bindings: [{ name: 'COUNTER', class_name: 'Counter' }, { name: 'LEGACY', class_name: 'LegacyCounter' }] },
      queues: { producers: [{ binding: 'JOBS', queue: 'work' }], consumers: [{ queue: 'work', max_retries: 2 }] } };
    const migrations = Object.fromEntries(['DB', 'SECOND'].map(binding => [binding, [{ name: '0001_items.sql', sql, sha256: createHash('sha256').update(sql).digest('hex'), statements: sql.split(';').filter(Boolean) }]]));
    await writeFile(join(app, 'demo.json'), JSON.stringify({ config, migrations }));
    await prepareNative(folder);
    const origin = 'https://demo.example.test', measurement = 'fixture-measurement-token-1234567890123456';
    const files = ['modules/demo-host/native/worker.mjs', ...[...RUNTIME_FILES.filter(file => file !== 'worker'), 'bundle'].map(file => `modules/demo-host/native/${file}.mjs`),
      ...DEMO_FILES.map(file => `modules/demo-host/${file}`), ...['migrations', 'demo-egress'].map(file => `modules/container/${file}.mjs`), ...['sql-safety', 'sql-tokens', 'migration-ledger', 'validation'].map(file => `modules/deploy-kit/${file}.mjs`)];
    mf = new Miniflare(convertV4MiniflareOptions({ name: 'native-test', unsafeInspectDurableObjects: true, modulesRoot: folder, modules: files.map(path => ({ type: 'ESModule', path: join(folder, path) })),
      compatibilityDate: '2026-09-08', compatibilityFlags: ['nodejs_compat'], workerLoaders: { LOADER: {} },
      durableObjects: { DEMO: { className: 'NativeDemo', useSQLite: true }, CAPACITY: { className: 'DemoCapacity', useSQLite: true } },
      ratelimits: { STARTS: { namespace_id: '1001', simple: { limit: 3, period: 60 } } },
      bindings: { DEMO_ORIGIN: origin, DEMO_SITE: 'https://example.test', DEMO_NAME: 'Test', DEMO_ORIGIN_VAR: 'AUTH_ORIGIN', DEMO_MAX_INSTANCES: '10', DEMO_SETTINGS: '{}', DEMO_SECONDARY_ORIGINS: '["https://page.demo.example.test"]',
        TURNSTILE_SITE_KEY: 'fixture-site-key', TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA', RER_DEMO_MEASUREMENT_TOKEN: measurement, NATIVE_TEST_TTL_MS: '12000' },
      serviceBindings: { ASSETS: () => new Response('fixture-asset') },
      outboundService: request => { if (request.url === 'https://network.example.test/') return new Response('network'); assert.equal(request.url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify'); return Response.json({ success: true }); },
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
    // A full old demo host can leave reservations for a retired namespace.
    // New visitors must still enter through the public start door immediately.
    const capacityNamespace = await mf.getDurableObjectNamespace('CAPACITY');
    const capacity = capacityNamespace.get(capacityNamespace.idFromName('capacity'));
    for (let i = 0; i < 10; i++) await capacity.acquire(capacityNamespace.newUniqueId().toString(), Date.now() + 60_000, 100, 'retired-visitor');
    const home = await fetch('/');
    assert.equal(home.status, 200);
    assert.match(await home.text(), /<link rel="prefetch" href="\/assets\/fixture-12345678\.js">/, "the start page prefetches the seed's built chunks");
    // A start without a readable form is a clean 400 before any place is reserved.
    for (const init of [{}, { body: '{"x":1}', headers: { 'content-type': 'application/json' } }, { body: 'x', headers: { 'content-type': 'multipart/form-data; boundary=none' } }]) {
      const refused = await fetch('/__demo/start', `rer_demo_measure=${measurement}`, { method: 'POST', ...init, headers: { 'cf-connecting-ip': '203.0.113.9', accept: 'application/json', ...init.headers } });
      assert.equal(refused.status, 400, 'unreadable start body');
      assert.match((await refused.json()).notice, /readable form/);
    }
    const [a, b] = await Promise.all([start('203.0.113.1'), start('203.0.113.2')]);
    assert.deepEqual([await (await fetch('/health-client', a)).json(), await (await fetch('/health-client', b)).json()], ['203.0.113.1', '203.0.113.2'], "the seed's /health during start sees each visitor's client address");
    assert.equal((await fetch('/items', a, { method: 'POST', body: 'visitor-a' })).status, 200);
    assert.deepEqual(await (await fetch('/items', b)).json(), [{ name: 'sample' }]);
    assert.deepEqual(await (await fetch('/d1-session', b)).json(), { names: ['sample'], bookmark: 'string', unknown: true, warnings: 1 }, 'D1 sessions read the visitor database; an unknown D1 method reads undefined and warns once');
    assert.deepEqual(await (await fetch('/modules', a)).json(), { sum: 5, data: [7, 8, 9] }, 'the app answers with its wasm and data modules');
    assert.equal((await fetch('/bindings', a, { method: 'POST', body: 'visitor-a' })).status, 201);
    let processed;
    for (let attempt = 0; attempt < 60; attempt++) {
      const response = await fetch('/bindings', a);
      assert.equal(response.status, 200, await response.clone().text());
      processed = await response.json();
      if (processed.jobs.length) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.deepEqual(processed, { keys: ['attachment'], body: 'visitor-a', retained: 'visitor-a', jobs: [{ name: 'visitor-a' }], secondary: [{ name: 'visitor-a' }] });
    assert.deepEqual(await (await fetch('/bindings', b)).json(), { keys: [], body: null, retained: null, jobs: [], secondary: [] });
    for (const cookies of [a, b]) {
      const own = await (await fetch('/own-fetch', cookies)).json();
      assert.deepEqual(own.primary, own.secondary);
      assert.deepEqual(own.primary, (await (await fetch('/items', cookies)).json()).map(row => row.name));
      assert.deepEqual({ messaging: own.messaging, network: own.network }, { messaging: 'Demo direct messaging transport refused', network: 'network' });
    }
    const restricted = await (await fetch('/bridge-probe', a)).json();
    assert.ok(Object.values(restricted).every(result => result === 'denied'), JSON.stringify(restricted));
    assert.equal((await fetch('/alarms', a, { method: 'POST' })).status, 200);
    let alarm;
    for (let attempt = 0; attempt < 50; attempt++) {
      alarm = await (await fetch('/alarms', a)).json();
      if (alarm.fired) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(await (await fetch('/legacy-alarm', a)).json(), true, 'legacy plain classes receive alarms too');
    assert.equal(alarm.fired, true, 'seed alarm delivered after a failed first attempt');
    assert.equal(alarm.attempts, 2);
    assert.equal(alarm.during, null, 'getAlarm is null during alarm delivery');
    assert.ok(alarm.next > Date.now(), 'seed can schedule its next alarm from alarm()');
    assert.equal((await (await fetch('/alarms', b)).json()).fired, false);
    // R2 lives in the visitor's own storage: objects, listing, ranges,
    // conditions, checksums, streamed bodies and multipart, erased at expiry.
    const at = (index, part = 0) => (index - part) % 251;
    assert.deepEqual(await (await fetch('/r2', a)).json(), {
      top: { keys: ['r2/top.txt'], prefixes: ['r2/docs/'], truncated: false, cursor: 'undefined', metadata: [{}] },
      first: { keys: ['r2/docs/a.txt'], prefixes: [], truncated: true, cursor: 'string', metadata: [{}] },
      rest: ['r2/docs/b.txt', 'r2/docs/sub/c.txt'],
      after: { keys: ['r2/docs/sub/c.txt', 'r2/top.txt'], prefixes: [], truncated: false, cursor: 'undefined', metadata: [{ key: 'r2/docs/sub/c.txt' }, { key: 'r2/top.txt' }] },
      ranges: ['top', 'txt', 'r2'], conditional: [null, false, true, 'y'], checksum: true, sha256: true,
      big: { size: 6 * 1024 * 1024 + 5, same: true, edge: [0, 1, 2, 3].map(offset => at(1024 * 1024 - 2 + offset)) },
      multipart: { etag: true, size: 1536 * 1024 + 3, contentType: 'application/x-multi', tail: [at(1536 * 1024 - 1), 7, 8, 9], across: [at(1536 * 1024 - 1), 7], missing: true },
      deleted: { docs: ['r2/docs/sub/c.txt'], big: null, head: null },
    });
    assert.deepEqual((await (await fetch('/bindings', b)).json()).keys, [], 'another visitor sees none of these objects');
    const upgraded = await fetch('/socket', a, { headers: { upgrade: 'websocket' } });
    assert.equal(upgraded.status, 101);
    const socket = upgraded.webSocket; socket.accept();
    const echoed = new Promise(resolve => socket.addEventListener('message', event => resolve(event.data), { once: true }));
    socket.send('visitor-a');
    assert.equal(await echoed, 'visitor-a');
    socket.close();
    const replay = b.replace(/rer_demo=[^;]+/, a.match(/rer_demo=[^;]+/)[0]);
    assert.equal((await fetch('/items', replay)).status, 401);
    assert.equal((await fetch('/items', 'rer_demo=forged')).status, 303);
    const asset = await fetch('/assets/fixture-12345678.js');
    assert.equal(await asset.text(), 'fixture-asset');
    assert.ok(asset.headers.get('cache-control').includes('immutable'));
    // Signing out ends the visitor's copy as expiry does; the ended page's
    // Start a new demo leads to a fresh signed-in copy. A refused sign-out
    // passes through and keeps the copy.
    const c = await start('203.0.113.3');
    assert.equal((await fetch('/auth/signout', c.replace(/owner=[^;]+/, 'owner=wrong'), { method: 'POST' })).status, 401);
    assert.equal((await fetch('/items', c)).status, 200);
    const signedOut = await fetch('/auth/signout', c, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(signedOut.status, 204);
    assert.match(signedOut.headers.get('set-cookie'), /^owner=;/);
    const ended = await fetch('/signin', c);
    assert.equal(ended.status, 410);
    assert.match(ended.headers.get('set-cookie'), /^rer_demo=;.*Max-Age=0/);
    const next = new URL((await ended.text()).match(/<a class="button" href="([^"]+)"/)[1]);
    assert.equal(next.origin, origin);
    assert.equal((await fetch(next.pathname)).status, 200);
    const d = await start('203.0.113.3');
    assert.notEqual(d.match(/rer_demo=[^;]+/)[0], c.match(/rer_demo=[^;]+/)[0]);
    assert.deepEqual(await (await fetch('/items', d)).json(), [{ name: 'sample' }]);
    const navigated = await fetch('/auth/signout', d, { method: 'POST', headers: { accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'content-type': 'application/x-www-form-urlencoded' }, body: '' });
    assert.equal(navigated.status, 410);
    assert.match(navigated.headers.get('set-cookie'), /^rer_demo=;.*Max-Age=0/);
    assert.equal(new URL((await navigated.text()).match(/<a class="button" href="([^"]+)"/)[1]).origin, origin);
    assert.equal((await fetch('/items', d)).status, 410);
    await new Promise(resolve => setTimeout(resolve, 12500));
    assert.equal((await fetch('/items', a)).status, 410);
    assert.equal((await fetch('/items', b)).status, 410);
    const namespace = await mf.getDurableObjectNamespace('DEMO');
    for (const cookies of [a, b, c, d]) {
      const id = namespace.idFromString(cookies.match(/(?:^|; )rer_demo=([^;]+)/)[1]);
      const storage = await mf.unsafeGetDurableObjectStorage('native-test', 'NativeDemo', { id: id.toString() });
      assert.deepEqual(await storage.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '_cf_METADATA'"), [], 'supervisor, R2 objects, queue records and facet inventory are erased');
    }
  } finally { await mf?.dispose(); await rm(folder, { recursive: true, force: true }); }
});
