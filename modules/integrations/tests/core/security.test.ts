import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { NodePinnedTransport } from '../../core/node-transport.ts';
import { validateDestination, isPublicAddress, verifyWebhook, createWebhookProtocol } from '../../core/index.ts';
import { database } from './support.ts';

test('public routing policy rejects local, metadata, IPv4 aliases, IPv6 transition and reserved addresses', async () => {
  const bad = ['http://example.com', 'https://user:test-pass@example.com', 'https://example.com/#fragment', 'https://example.com:444/', 'https://localhost/', 'https://a.internal/', 'https://127.0.0.1/', 'https://2130706433/', 'https://0x7f000001/', 'https://0177.0.0.1/', 'https://169.254.169.254/', 'https://10.0.0.1/', 'https://192.168.0.1/', 'https://[::1]/', 'https://[::ffff:127.0.0.1]/', 'https://[fc00::1]/', 'https://[fe80::1]/', 'https://[2002:7f00:1::]/', 'https://[2001:db8::1]/', 'https://example.com./'];
  for (const value of bad) assert.throws(() => validateDestination(value), value);
  for (const address of ['100.64.0.1', '172.31.1.1', '198.18.0.1', '203.0.113.1', '224.0.0.1', '0.0.0.0', '2001::1', '2001:10::1', '3fff::1']) assert.equal(isPublicAddress(address), false, address);
  for (const value of ['https://example.com/hook', 'https://8.8.8.8/', 'https://[2606:4700:4700::1111]/']) assert.ok(validateDestination(value));
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
});

test('production transport cannot reach a real private listener or redirect credentials via private literal', async () => {
  let calls = 0; const server = createServer((_req, res) => { calls++; res.writeHead(302, { location: 'https://example.com/' }); res.end(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const transport = new NodePinnedTransport();
    await assert.rejects(transport.send({ url: 'https://127.0.0.1/', headers: { authorization: 'Bearer test-only' }, body: '{}' }), /public/);
    assert.equal(calls, 0);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('replay claims race atomically and reject conflicting validly signed identity reuse', async () => {
  const store = await database(), key = crypto.getRandomValues(new Uint8Array(32)), now = Date.now();
  const p = createWebhookProtocol({ resolveDestination: async () => 'https://example.com/', signingKey: async () => key });
  const envelope = { id: 'e', tenant: 'tenant', destinationId: 'dest', event: 'created', protocol: 'webhook', body: '{}' };
  try {
    const wire = await p.prepare(envelope, now), verified = await verifyWebhook({ ...wire, key, tenant: 'tenant', destinationId: 'dest', now });
    const result = await Promise.all(Array.from({ length: 10 }, () => store.repo().acceptReplay(verified)));
    assert.equal(result.filter(Boolean).length, 1);
    const changedWire = await p.prepare({ ...envelope, body: '{"changed":true}' }, now);
    const changed = await verifyWebhook({ ...changedWire, key, tenant: 'tenant', destinationId: 'dest', now });
    await assert.rejects(store.repo().acceptReplay(changed), /conflict/);
    await assert.rejects(store.repo('other').acceptReplay(verified), /namespace/);
  } finally { await store.close(); }
});
