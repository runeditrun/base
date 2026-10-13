import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { key, tenant, destinationId, signedWebhook, byteMutations, receiverWorkerModules } from './raw-webhook-fixture.ts';

const { Miniflare } = await import(process.env.INTEGRATIONS_MINIFLARE_MODULE ?? 'miniflare');

test('documented Fetch receiver runs in workerd with raw-byte authentication and durable D1 replay protection', async t => {
  const now = Math.floor(Date.now() / 1000) * 1000;
  t.mock.method(Date, 'now', () => now);
  const directory = await mkdtemp(join(tmpdir(), 'integrations-raw-worker-'));
  const modules = await receiverWorkerModules();
  modules['worker.js'] = { type: 'esm', contents: `
    import { receiveWebhook } from './receiver.js';
    import { D1SqlDatabase, IntegrationsRepository } from './modules/integrations/index.ts';
    Date.now = () => ${now};
    export default { async fetch(request, env) {
      try {
        return await receiveWebhook(request,
          new IntegrationsRepository(new D1SqlDatabase(env.DB), ${JSON.stringify(tenant)}),
          new Uint8Array(${JSON.stringify([...key])}), ${JSON.stringify(destinationId)});
      } catch { return new Response('rejected', { status: 400 }); }
    } };` };
  const options = {
    host: '127.0.0.1', port: 0, cf: false, telemetry: { enabled: false }, resourcePersistencePath: directory,
    workers: [{ config: { name: 'raw-webhook-test', type: 'worker', compatibilityDate: '2026-09-01',
      manifest: { mainModule: 'worker.js', modules }, env: { DB: { type: 'd1', id: 'raw-webhook-inbox' } },
    } }],
  };
  let runtime = new Miniflare(options);
  try {
    let binding = await runtime.getD1Database('DB');
    const schema = await readFile(new URL('../../core/schema.sql', import.meta.url), 'utf8');
    await binding.batch(schema.split(';').filter(sql => sql.trim()).map(sql => binding.prepare(sql)));
    const send = (wire: ReturnType<typeof signedWebhook>) => runtime.dispatchFetch('http://receiver.test/', { method: 'POST', ...wire });
    const rows = () => binding.prepare('SELECT * FROM integration_replays').all();
    for (const mutation of byteMutations) {
      const signed = signedWebhook(mutation.original);
      assert.equal((await send({ ...signed, body: mutation.body })).status, 400, mutation.name);
    }
    assert.equal((await rows()).results.length, 0);
    const body = '{"text":"Café λ 🚀 e\u0301 \ufffd"}', signed = signedWebhook(body);
    assert.equal((await send(signed)).status, 204, 'real Worker crypto accepts the original Unicode body');
    assert.equal((await rows()).results.length, 1);
    await runtime.dispose(); runtime = new Miniflare(options);
    binding = await runtime.getD1Database('DB');
    assert.equal((await send(signed)).status, 204);
    assert.equal((await rows()).results.length, 1, 'durable replay identity survives Worker restart');
    assert.equal((await send(signedWebhook('{"changed":true}'))).status, 400);
    for (const audience of [{ tenant: 'other' }, { destinationId: 'other' }]) {
      assert.equal((await send(signedWebhook(body, { id: 'wrong-audience', ...audience }))).status, 400);
    }
    assert.equal((await send(signedWebhook(body, { id: 'expired', now: Date.now() - 301000 }))).status, 400);
    assert.equal((await send(signedWebhook(body, { id: 'future', now: Date.now() + 301000 }))).status, 400);
    assert.equal((await rows()).results.length, 1);
    for (const offset of [-300000, 300000]) {
      assert.equal((await send(signedWebhook(body, { id: `boundary-${offset}`, now: now + offset }))).status, 204, 'exact five-minute boundary is accepted');
    }
    assert.equal((await rows()).results.length, 3);
    // A BOM is permitted only when it is actually covered by the signature.
    assert.equal((await send(signedWebhook('\ufeff{"text":"signed BOM"}', { id: 'signed-bom' }))).status, 204);
    assert.equal((await rows()).results.length, 4);
  } finally { await runtime.dispose(); await rm(directory, { recursive: true, force: true }); }
});
