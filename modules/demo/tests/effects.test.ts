import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const ROOT = new URL('../../', import.meta.url);

// Exercise the real Worker entry; replace only the external network edge.
async function worker(t, bindings) {
  const calls = [];
  const modules = ['demo/tests/fixture.mjs', ...['index', 'effects', 'responses', 'label'].map(name => `demo/${name}.mjs`), ...['http', 'csp', 'errors', 'crypto', 'loopback'].map(name => `operator-auth/${name}.mjs`)];
  const mf = new Miniflare(convertV4MiniflareOptions({ modulesRoot: fileURLToPath(ROOT), modules: modules.map(path => ({ type: 'ESModule', path: fileURLToPath(new URL(path, ROOT)) })), compatibilityDate: '2026-09-08', d1Databases: { DB: 'demo' }, bindings,
    outboundService(request) { calls.push(`${request.method} ${request.url}`); return Response.json({ reached: new URL(request.url).pathname }, { status: 202, headers: { 'x-message-id': 'real-network-id' } }); },
  }));
  t.after(() => mf.dispose());
  return { get: path => mf.dispatchFetch(`http://127.0.0.1${path}`), calls };
}

test('demo public reads and POST probes reach the network, sends complete successfully without leaving', async t => {
  const { get, calls } = await worker(t, { RER_DEMO: '1' });
  assert.deepEqual(await (await get('/read')).json(), { reached: '/page' });
  assert.deepEqual(await (await get('/probe')).json(), { reached: '/check' });
  const before = calls.length;
  const sent = await (await get('/send')).json();
  assert.equal(sent.accepted, true);
  assert.ok(sent.id);
  assert.equal((await (await get('/chat')).json()).ok, true);
  const payment = await (await get('/payment')).json();
  assert.equal(payment.payment_status, 'paid');
  assert.equal(new URL(payment.url).pathname, '/paid');
  const hook = await (await get('/webhook')).json();
  assert.equal(hook.success, true);
  assert.equal(hook.event, 'record.created');
  assert.deepEqual(await (await get('/binding')).json(), { sent: 'demo' });
  assert.equal(calls.length, before, 'no send reached the network');
});

test('ordinary runtime sends remain real and the Worker is undecorated', async t => {
  const { get, calls } = await worker(t, {});
  assert.deepEqual(await (await get('/send')).json(), { accepted: true, id: 'real-network-id' });
  assert.equal(calls.length, 1);
  assert.deepEqual(await (await get('/binding')).json(), { sent: 'real' });
  assert.equal((await get('/')).headers.get('content-security-policy'), "default-src 'none'; style-src 'self'");
});
