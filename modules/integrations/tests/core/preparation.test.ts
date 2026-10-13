import test from 'node:test';
import assert from 'node:assert/strict';
import { DeliveryService, createWebhookProtocol } from '../../core/index.ts';
import { database, receiver } from './support.ts';

const envelope = { id: 'delayed', tenant: 'tenant', destinationId: 'receiver-v1', event: 'changed', protocol: 'webhook', body: '{}' };
const key = new Uint8Array(32).fill(47);

test('enqueue snapshots bounded retry delays before asynchronous destination preparation', async () => {
  const store = await database();
  const delays = [1000];
  const wire = await receiver(async (_body, _headers, _req, res) => { res.writeHead(204).end(); });
  try {
    const protocol = createWebhookProtocol({ signingKey: async () => key, resolveDestination: async () => {
      await Promise.resolve(); delays[0] = 86400001;
      return 'https://receiver.example.com/';
    } });
    const service = new DeliveryService({ repository: store.repo(), protocols: [protocol], transport: wire.transport });
    await assert.rejects(service.enqueue(envelope, { maxAttempts: 2, retryDelaysMs: new Array(1) }), /bounded retry policy/);
    await service.enqueue(envelope, { maxAttempts: 2, retryDelaysMs: delays });
    store.restart();
    assert.deepEqual((await store.repo().get(envelope.id))?.retryDelaysMs, [1000]);
  } finally { await wire.close(); await store.close(); }
});

for (const reconcile of [false, true]) test(`expired asynchronous preparation cannot start an external effect${reconcile ? ' after reconciliation' : ''}`, async () => {
  const store = await database(); let now = 1800000000000, calls = 0, sends = 0;
  const wire = await receiver(async (_body, _headers, _req, res) => { sends++; res.writeHead(204).end(); });
  try {
    let service: DeliveryService;
    const protocol = createWebhookProtocol({ signingKey: async () => key, resolveDestination: async () => {
      if (++calls === 2) {
        now += 60001;
        await service.recoverExpired();
        if (reconcile) await service.resolveUncertain(envelope.id, 'rejected', 'operator_confirmed');
      }
      return 'https://receiver.example.com/';
    } });
    service = new DeliveryService({ repository: store.repo(), protocols: [protocol], transport: wire.transport, now: () => now });
    await service.enqueue(envelope);
    assert.equal((await service.dispatch(envelope.id))?.state, reconcile ? 'rejected' : 'uncertain');
    assert.equal(sends, 0, 'late destination preparation must not send');
    assert.equal((await service.log(envelope.id)).length, 1);
    assert.equal((await service.log(envelope.id))[0]?.outcome?.kind, 'uncertain');
  } finally { await wire.close(); await store.close(); }
});
