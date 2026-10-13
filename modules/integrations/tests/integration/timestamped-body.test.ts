import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { DeliveryService, createWebhookProtocol, verifyWebhook } from '../../index.ts';
import { loopback, store } from './support.ts';

test('durable webhook sends both signatures over the identical original HTTP body', async t => {
  const sender = await store(t);
  const key = new TextEncoder().encode('synthetic-shared-random-secret-string-over-32-bytes');
  const now = 1800000000123, url = 'https://receiver.example.com/timestamped-body';
  const body = '\ufeff{\r\n  "text": "Café λ 🚀 e\u0301", "state": "open"\n}\n';
  const transport = await loopback(t, [url], async (request, _req, response) => {
    const iso = request.headers['x-receiver-timestamp']!;
    assert.equal(iso, new Date(Number(request.headers['webhook-timestamp']) * 1000).toISOString());
    assert.deepEqual(request.rawBody, Buffer.from(body, 'utf8'));
    assert.equal(request.headers['x-receiver-signature'], createHmac('sha256', key).update(iso + '.', 'utf8').update(request.rawBody).digest('base64url'));
    const verified = await verifyWebhook({ body: request.rawBody, headers: request.headers, key, tenant: 'installation', destinationId: 'receiver-v1', now });
    assert.equal(verified.envelope.body, body);
    response.writeHead(204).end();
  });
  const protocol = createWebhookProtocol({ resolveDestination: async () => url, signingKey: async () => key,
    timestampedBodySignature: { timestampHeader: 'X-Receiver-Timestamp', signatureHeader: 'X-Receiver-Signature' },
  });
  const service = new DeliveryService({ repository: sender.repo(), protocols: [protocol], transport: transport.transport, now: () => now });
  await service.enqueue({ id: 'timestamped-1', tenant: 'installation', destinationId: 'receiver-v1', event: 'incident.opened', protocol: protocol.id, body });
  assert.equal((await service.dispatch('timestamped-1'))?.state, 'accepted');
  assert.deepEqual(transport.failures, []);
  assert.equal(transport.received.length, 1);
  assert.equal((await service.get('timestamped-1'))?.body, body);
});
