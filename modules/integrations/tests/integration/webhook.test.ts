import { runCases } from '../cases.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { DeliveryService, createWebhookProtocol, verifyWebhook } from '../../index.ts';
import type { Envelope } from '../../index.ts';
import { loopback, store } from './support.ts';

const url = 'https://receiver.example.com/events';
const key = new Uint8Array(32).fill(71); // Test key, never consumer custody.

test('public webhook: exact HMAC, bounded retry after restart, durable replay inbox and identity', async t => {
  await runCases(t, [['independent input groups', async t => {
  const sender = await store(t), receiver = await store(t);
  let now = 1800000000000, requests = 0;
  const protocol = createWebhookProtocol({ resolveDestination: async () => url, signingKey: async () => key });
  const wire = await loopback(t, [url], async (request, _req, res) => {
    const h = request.headers;
    const canonical = JSON.stringify(['integrations.webhook.v1', 'installation', 'receiver-v1', 'incident.opened', 'event-1', h['webhook-timestamp'], request.body]);
    assert.equal(h['webhook-signature'], `v1=${createHmac('sha256', key).update(canonical).digest('hex')}`);
    assert.equal((await sender.repo().log('event-1')).at(-1)?.finishedAt, null, 'attempt is durable before send');
    if (++requests === 1) { res.writeHead(429, { 'retry-after': '2' }); res.end(); return; }
    const verified = await verifyWebhook({ ...request, key, tenant: 'installation', destinationId: 'receiver-v1', now });
    assert.equal(await receiver.repo().acceptReplay(verified), true);
    res.writeHead(204); res.end();
  });
  const service = () => new DeliveryService({ repository: sender.repo(), protocols: [protocol], transport: wire.transport, now: () => now });
  const envelope: Envelope = { id: 'event-1', tenant: 'installation', destinationId: 'receiver-v1', event: 'incident.opened', protocol: 'webhook', body: '{"title":"Café ☕","value":1}' };
  await service().enqueue(envelope, { maxAttempts: 2, retryDelaysMs: [1] });
  assert.equal((await service().dispatch(envelope.id))?.state, 'queued');
  sender.restart(); now += 1999;
  assert.deepEqual(await service().dispatchDue(), []);
  now += 1; assert.equal((await service().dispatchDue())[0]?.state, 'accepted');
  assert.equal(requests, 2); assert.deepEqual(wire.failures, []);
  assert.equal(wire.received[0]!.body, wire.received[1]!.body);
  assert.notEqual(wire.received[0]!.headers['webhook-signature'], wire.received[1]!.headers['webhook-signature']);
  const accepted = wire.received[1]!;
  receiver.restart();
  const verified = await verifyWebhook({ ...accepted, key, tenant: 'installation', destinationId: 'receiver-v1', now });
  assert.deepEqual(await Promise.all([receiver.repo().acceptReplay(verified), receiver.repo().acceptReplay(verified)]), [false, false]);
  const changed = await protocol.prepare({ ...envelope, body: '{}' }, now);
  const conflict = await verifyWebhook({ ...changed, key, tenant: 'installation', destinationId: 'receiver-v1', now });
  await runCases(t, [
    ["receiver refusal inputs: case 1", async t => {
      await assert.rejects(receiver.repo().acceptReplay(conflict), /identity conflict/);
    }],
    ["receiver refusal inputs: case 2", async t => {
      await assert.rejects(verifyWebhook({ ...accepted, body: accepted.body + ' ', key, tenant: 'installation', destinationId: 'receiver-v1', now }), /signature/);
    }],
    ["receiver refusal inputs: case 3", async t => {
      await assert.rejects(verifyWebhook({ ...accepted, key, tenant: 'installation', destinationId: 'receiver-v1', now: now + 300001 }), /timestamp/);
    }],
    ["receiver refusal inputs: case 4", async t => {
      await assert.rejects(service().enqueue({ ...envelope, body: '{}' }), /identity conflict/);
    }]
  ]);
  await service().dispatch(envelope.id); assert.equal(requests, 2);
  assert.deepEqual((await service().log(envelope.id)).map(a => a.outcome?.kind), ['retryable', 'accepted']);
  assert.equal((await sender.repo('other-installation').get(envelope.id)), null);

  }]]);
});

test('public delivery: response lost after durable inbox acceptance stays uncertain across restart', async t => {
  const sender = await store(t), receiver = await store(t); let now = 1800000000000;
  const protocol = createWebhookProtocol({ resolveDestination: async () => url, signingKey: async () => key });
  const wire = await loopback(t, [url], async (request, req) => {
    const verified = await verifyWebhook({ ...request, key, tenant: 'installation', destinationId: 'receiver-v1', now });
    assert.equal(await receiver.repo().acceptReplay(verified), true);
    req.socket.destroy(); // The inbox committed, but the sender cannot know that.
  });
  const service = () => new DeliveryService({ repository: sender.repo(), protocols: [protocol], transport: wire.transport, now: () => now });
  await service().enqueue({ id: 'lost-1', tenant: 'installation', destinationId: 'receiver-v1', event: 'incident.opened', protocol: 'webhook', body: '{}' });
  assert.equal((await service().dispatch('lost-1'))?.state, 'uncertain');
  sender.restart(); receiver.restart(); now += 600000;
  assert.deepEqual(await service().dispatchDue(), []);
  await service().dispatch('lost-1'); assert.equal(wire.received.length, 1);
  assert.equal((await receiver.repo().query('SELECT id FROM integration_replays WHERE namespace=?')).length, 1);
  await service().resolveUncertain('lost-1', 'accepted', 'receiver_inbox_confirmed');
  assert.equal((await service().get('lost-1'))?.state, 'accepted');
  assert.equal((await service().log('lost-1'))[0]?.outcome?.kind, 'uncertain');
  assert.equal((await sender.repo().resolutions('lost-1')).length, 1);
  assert.deepEqual(wire.failures, []);
});
