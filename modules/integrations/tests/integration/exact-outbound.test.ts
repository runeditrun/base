import { runCases } from '../cases.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { DeliveryService, createWebhookProtocol, verifyWebhook } from '../../index.ts';
import { loopback, store } from './support.ts';

test('outbound HMAC preserves original UTF-8 bytes including whitespace, line endings and signed BOM', async t => {
  const sender = await store(t), inbox = await store(t);
  const key = new Uint8Array(32).fill(83), now = 1800000000000;
  const url = 'https://receiver.example.com/exact-bytes';
  const bodies = ['{\r\n  "text": "Café λ 🚀 e\u0301", "value": 1\n}\n', '\ufeff{"text":"signed BOM"}'];
  const transport = await loopback(t, [url], async (request, _req, response) => {
    const id = request.headers['webhook-id']!;
    const original = bodies[Number(id.split('-').at(-1))]!;
    assert.deepEqual(request.rawBody, Buffer.from(original, 'utf8'));
    const canonical = JSON.stringify(['integrations.webhook.v1', 'installation', 'exact-v1', 'changed', id, request.headers['webhook-timestamp'], original]);
    assert.equal(request.headers['webhook-signature'], `v1=${createHmac('sha256', key).update(canonical, 'utf8').digest('hex')}`);
    const verified = await verifyWebhook({ body: request.rawBody, headers: request.headers, key, tenant: 'installation', destinationId: 'exact-v1', now });
    assert.equal(verified.envelope.body, original);
    assert.equal(await inbox.repo().acceptReplay(verified), true);
    await assert.rejects(verifyWebhook({ body: Buffer.from(original + ' '), headers: request.headers, key, tenant: 'installation', destinationId: 'exact-v1', now }), /signature/);
    response.writeHead(204).end();
  });
  const protocol = createWebhookProtocol({ resolveDestination: async () => url, signingKey: async () => key });
  const service = new DeliveryService({ repository: sender.repo(), protocols: [protocol], transport: transport.transport, now: () => now });
  await runCases(t, Array.from(bodies.entries(), ([index, body], rowIndex) => [`${t.name}: [index, body] row ${rowIndex + 1}`, async t => {
    const id = `exact-${index}`;
    await service.enqueue({ id, tenant: 'installation', destinationId: 'exact-v1', event: 'changed', protocol: 'webhook', body });
    assert.equal((await service.dispatch(id))?.state, 'accepted');
}]));
  assert.equal(transport.received.length, bodies.length);
  assert.deepEqual(transport.failures, []);
  inbox.restart();
  for (const request of transport.received) {
    const verified = await verifyWebhook({ body: request.rawBody, headers: request.headers, key, tenant: 'installation', destinationId: 'exact-v1', now });
    assert.equal(await inbox.repo().acceptReplay(verified), false);
  }
});
