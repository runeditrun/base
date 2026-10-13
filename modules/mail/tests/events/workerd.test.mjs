import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signed, sg, resend, NOW } from './fixtures.mjs';

const { Miniflare } = await import(process.env.MAIL_MINIFLARE_MODULE || 'miniflare');
const root = new URL('../../', import.meta.url);
async function createRuntime(path) {
  const modules = {};
  async function add(path) { modules[path] = { type: 'esm', contents: await readFile(new URL(path, root), 'utf8') }; }
  for (const dir of ['src/events', 'src/core', 'src/adapters/messaging']) {
    for (const file of await readdir(new URL(dir, root))) if (file.endsWith('.mjs')) await add(`${dir}/${file}`);
  }
  await add('tests/events/worker.mjs');
  return new Miniflare({ cf: false, resourcePersistencePath: path, workers: [{ config: {
    type: 'worker', name: 'mail-events-test', compatibilityDate: '2026-09-01',
    manifest: { mainModule: 'tests/events/worker.mjs', modulesRoot: fileURLToPath(root), modules },
    env: { LEDGER: { type: 'durable-object', worker: 'mail-events-test', exportName: 'EventLedger' }, QUEUE: { type: 'queue', name: 'mail-events' } },
    triggers: [{ type: 'queue', name: 'mail-events', maxBatchTimeout: 0 }],
    exports: { EventLedger: { type: 'durable-object', storage: 'sqlite' } },
  } }] });
}
function payload(input, extra = {}) {
  return { raw: Buffer.from(input.rawBody).toString('base64'), headers: [...input.headers],
    config: { provider: input.provider, key: input.key, now: input.now, tenantId: 'tenant', eventNamespace: 'endpoint', ...extra } };
}
async function send(runtime, path, body) {
  const response = await runtime.dispatchFetch(`https://mail.test/${path}`, { method: 'POST', body: JSON.stringify(body) });
  return response.json();
}
test('signed delivery intake is isolated, atomic and durable in real workerd SQLite and Queue', async () => {
  const path = await mkdtemp(join(tmpdir(), 'mail-events-'));
  let runtime;
  try {
    runtime = await createRuntime(path);
    const body = payload(signed('resend', JSON.stringify(resend())));
    const results = await Promise.all([send(runtime, 'smoke', body), send(runtime, 'smoke', body)]);
    assert.deepEqual(results.map(value => value.result[0].outcome).sort(), ['duplicate', 'stored']);
    assert.equal((await send(runtime, 'smoke', payload(signed('resend', JSON.stringify(resend({ type: 'email.bounced' })))))).code, 'event_identity_conflict');
    // Crypto/authorization must refuse before committing any durable receipt.
    const invalid = signed('sendgrid', '{invalid'); invalid.rawBody[0] ^= 1;
    assert.equal((await send(runtime, 'refused', payload(invalid))).code, 'event_signature_invalid');
    assert.equal((await send(runtime, 'refused', payload(signed('sendgrid', JSON.stringify([sg()])), { authorize: false }))).code, 'event_unauthorized');
    assert.deepEqual(await send(runtime, 'refused', { action: 'list' }), []);
    // Identical event IDs in distinct tenant/endpoint scopes remain independent.
    for (const tenantId of ['tenant', 'other']) for (const eventNamespace of ['endpoint', 'other']) {
      assert.equal((await send(runtime, 'isolated', payload(signed('resend', JSON.stringify(resend())), { tenantId, eventNamespace }))).result[0].outcome, 'stored');
    }
    const initial = payload(signed('sendgrid', JSON.stringify([sg()])));
    assert.equal((await send(runtime, 'rollback', initial)).result[0].outcome, 'stored');
    const prior = await send(runtime, 'rollback', { action: 'list' });
    const conflicting = payload(signed('sendgrid', JSON.stringify([sg({ sg_event_id: 'new', email: 'second@example.test' }), sg({ event: 'bounce' })])));
    assert.equal((await send(runtime, 'rollback', conflicting)).code, 'event_identity_conflict');
    assert.deepEqual(await send(runtime, 'rollback', { action: 'list' }), prior);
    await runtime.dispose(); runtime = await createRuntime(path);
    assert.equal((await send(runtime, 'smoke', body)).result[0].outcome, 'duplicate');
    const older = payload(signed('resend', JSON.stringify(resend({ type: 'email.sent', created_at: new Date(NOW - 1000).toISOString() })), { id: 'older' }));
    assert.equal((await send(runtime, 'smoke', older)).result[0].recipients[0].state.status, 'delivered');
    const producer = await runtime.getQueueProducer('QUEUE');
    await producer.send({ type: 'cf.email.sending.message.delivered', source: { type: 'email.sending', zoneId: 'zone', domain: 'example.test' },
      payload: { eventId: 'actual-queue', messageId: 'actual-message', recipient: 'recipient@example.test', terminal: true, delivery: { status: 'delivered' } },
      metadata: { accountId: 'account', eventSubscriptionId: 'subscription', eventSchemaVersion: 1, eventTimestamp: new Date(NOW).toISOString() } });
    let rows; const deadline = Date.now() + 10000;
    do {
      rows = await send(runtime, 'trusted-queue', { action: 'list' });
      if (rows.length === 2) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    assert.equal(rows.length, 2);
    assert.equal(rows.find(([key]) => key.includes(':receipt:'))[1].eventId, 'actual-queue');
    assert.equal(rows.find(([key]) => key.includes(':state:'))[1].status, 'delivered');
  } finally { await runtime?.dispose(); await rm(path, { recursive: true, force: true }); }
});
