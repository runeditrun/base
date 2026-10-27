import { runCases, type Case } from '../cases.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DeliveryService, createWebhookProtocol, verifyWebhook } from '../../core/index.ts';
import { SqliteDatabase } from '../../core/sqlite.ts';
import { IntegrationsRepository } from '../../core/repository.ts';
import { database, receiver } from './support.ts';
const key = crypto.getRandomValues(new Uint8Array(32));
const envelope = { id: 'event-1', tenant: 'tenant', destinationId: 'destination-v1', event: 'ticket.created', protocol: 'webhook', body: '{ "text": "Unicode λ 🚀", "n": 1 }' };
const protocol = createWebhookProtocol({ resolveDestination: async () => 'https://receiver.example.com/hook', signingKey: async () => key });

test("durable webhook delivery preserves bounded retries and conservative outcomes across failure and restart", async t => {
  const foldedCases: Case[] = [];
foldedCases.push(['real HTTP signature, bounded rate-limit retry, stable identity and durable receiver replay protection after restart', async (t) => {
  const sender = await database(), inbox = await database(); let now = 1700000000000, calls = 0, effects = 0;
  const seen: Record<string, string>[] = [];
  const http = await receiver(async (body, headers, _req, res) => {
    seen.push(headers); const verified = await verifyWebhook({ body, headers, key, tenant: 'tenant', destinationId: 'destination-v1', now });
    calls++;
    if (calls === 1) { res.writeHead(429, { 'retry-after': '2' }); res.end('limited'); return; }
    if (await inbox.repo().acceptReplay(verified)) effects++;
    res.writeHead(204); res.end();
  });
  try {
    let service = new DeliveryService({ repository: sender.repo(), protocols: [protocol], transport: http.transport, now: () => now });
    await service.enqueue(envelope);
    assert.equal((await service.dispatch(envelope.id))!.state, 'queued');
    assert.equal((await service.get(envelope.id))!.nextAt, now + 2000);
    await service.dispatch(envelope.id); assert.equal(calls, 1);
    sender.restart(); now += 2000;
    service = new DeliveryService({ repository: sender.repo(), protocols: [protocol], transport: http.transport, now: () => now });
    assert.equal((await service.dispatch(envelope.id))!.state, 'accepted');
    assert.equal(effects, 1); assert.equal(seen[0]!['webhook-id'], seen[1]!['webhook-id']);
    assert.notEqual(seen[0]!['webhook-signature'], seen[1]!['webhook-signature']);
    inbox.restart(); await http.transport.send(await protocol.prepare(envelope, now)); assert.equal(effects, 1);
    assert.equal((await service.log(envelope.id)).length, 2);
    assert.equal((await service.enqueue(envelope)).state, 'accepted');
    await assert.rejects(service.enqueue({ ...envelope, body: '{}' }), /conflict/);
    await assert.rejects(service.enqueue({ ...envelope, destinationId: 'other' }), /conflict/);
    await assert.rejects(service.enqueue({ ...envelope, tenant: 'other' }), /tenant/);
    const original = await protocol.prepare(envelope, now);
    await runCases(t, Array.from([ { body: envelope.body + ' ' }, { headers: { ...original.headers, 'webhook-event': 'other' } }, { headers: { ...original.headers, 'webhook-id': 'other' } }, { headers: { ...original.headers, 'webhook-tenant': 'other' } }, { headers: { ...original.headers, 'webhook-destination': 'other' } } ], (change, rowIndex) => [`${t.name}: change row ${rowIndex + 1}`, async t => {
      await assert.rejects(verifyWebhook({ ...original, ...change, key, tenant: 'tenant', destinationId: 'destination-v1', now }));
}]));
    await assert.rejects(verifyWebhook({ ...original, key, tenant: 'tenant', destinationId: 'destination-v1', now: now + 301000 }), /timestamp/);
  } finally { await http.close(); await sender.close(); await inbox.close(); }
}]);
foldedCases.push(['two durable connections race claims; lost response and expired lease never blindly replay', async () => {
  const store = await database(); let now = 1700000000000, sends = 0;
  const http = await receiver(async (_body, _headers, req) => { sends++; req.socket.destroy(); });
  const db2 = new SqliteDatabase(store.path), repo2 = new IntegrationsRepository(db2, 'tenant');
  try {
    const a = new DeliveryService({ repository: store.repo(), protocols: [protocol], transport: http.transport, now: () => now });
    const b = new DeliveryService({ repository: repo2, protocols: [protocol], transport: http.transport, now: () => now });
    await a.enqueue(envelope);
    await Promise.all([a.dispatch(envelope.id), b.dispatch(envelope.id), a.dispatch(envelope.id)]);
    assert.equal(sends, 1); assert.equal((await a.get(envelope.id))!.state, 'uncertain');
    await b.dispatch(envelope.id); assert.equal(sends, 1);
    await a.resolveUncertain(envelope.id, 'accepted', 'provider_reconciled');
    assert.equal((await a.get(envelope.id))!.state, 'accepted');
    assert.equal((await a.log(envelope.id))[0]!.outcome!.kind, 'uncertain');
    assert.equal((await store.repo().resolutions(envelope.id)).length, 1);
    await a.enqueue({ ...envelope, id: 'crashed' });
    assert.ok(await store.repo().claim('crashed', now, 1000)); now += 1000;
    assert.deepEqual(await b.recoverExpired(), ['crashed']);
    assert.equal((await b.dispatch('crashed'))!.state, 'uncertain'); assert.equal(sends, 1);
    assert.equal((await b.log('crashed'))[0]!.outcome!.code, 'claim_expired');
  } finally { db2.close(); await http.close(); await store.close(); }
}]);
foldedCases.push(['bounded explicit retries, terminal rejection and frozen destination', async () => {
  const store = await database(); let now = 1700000000000, calls = 0, url = 'https://receiver.example.com/hook';
  const http = await receiver(async (_body, _headers, _req, res) => { calls++; res.writeHead(429); res.end(); });
  try {
    const p = createWebhookProtocol({ resolveDestination: async () => url, signingKey: async () => key });
    const service = new DeliveryService({ repository: store.repo(), protocols: [p], transport: http.transport, now: () => now });
    await service.enqueue(envelope, { maxAttempts: 2, retryDelaysMs: [1] });
    await service.dispatch(envelope.id); now++; await service.dispatch(envelope.id);
    assert.equal((await service.get(envelope.id))!.state, 'rejected'); await service.dispatch(envelope.id); assert.equal(calls, 2);
    await service.enqueue({ ...envelope, id: 'changed' }); url = 'https://receiver.example.com/changed';
    assert.equal((await service.dispatch('changed'))!.state, 'rejected'); assert.equal(calls, 2);
    await assert.rejects(service.enqueue({ ...envelope, id: 'bad' }, { maxAttempts: 11 }));
    assert.equal(protocol.classify({ status: 503, body: '', headers: {} }, now).kind, 'uncertain');
    assert.equal(protocol.classify({ status: 400, body: '', headers: {} }, now).kind, 'rejected');
  } finally { await http.close(); await store.close(); }
}]);
foldedCases.push(['real database failure after remote acceptance is visible and recovers uncertain', async () => {
  const store = await database(); let now = 1700000000000, calls = 0;
  const http = await receiver(async (_body, _headers, _req, res) => { calls++; store.db.migrate("CREATE TRIGGER fail_finish BEFORE UPDATE ON integration_attempts BEGIN SELECT RAISE(ABORT,'disk write failure'); END;"); res.writeHead(204); res.end(); });
  try {
    const service = new DeliveryService({ repository: store.repo(), protocols: [protocol], transport: http.transport, now: () => now });
    await service.enqueue(envelope);
    await assert.rejects(service.dispatch(envelope.id), /disk write failure/);
    assert.equal((await service.get(envelope.id))!.state, 'sending');
    store.db.migrate('DROP TRIGGER fail_finish'); store.restart(); now += 60001;
    const restarted = new DeliveryService({ repository: store.repo(), protocols: [protocol], transport: http.transport, now: () => now });
    assert.equal((await restarted.dispatch(envelope.id))!.state, 'uncertain'); assert.equal(calls, 1);
  } finally { await http.close(); await store.close(); }
}]);
foldedCases.push(['durable due discovery and retry horizon never shorten Retry-After', async () => {
  const store = await database(), now = 1700000000000; let calls = 0;
  const http = await receiver(async (_body, _headers, _req, res) => { calls++; res.writeHead(429, { 'retry-after': '172800' }); res.end(); });
  try {
    let service = new DeliveryService({ repository: store.repo(), protocols: [protocol], transport: http.transport, now: () => now });
    await service.enqueue(envelope); store.restart();
    service = new DeliveryService({ repository: store.repo(), protocols: [protocol], transport: http.transport, now: () => now });
    assert.equal((await service.dispatchDue())[0]!.state, 'rejected');
    assert.equal((await service.log(envelope.id))[0]!.outcome!.code, 'retry_delay_exceeded');
    assert.deepEqual(await service.dispatchDue(), []); assert.equal(calls, 1);
    await assert.rejects(service.enqueue({ ...envelope, id: 'invalid-utf8', body: '\ud800' }), /UTF-8/);
  } finally { await http.close(); await store.close(); }
}]);
foldedCases.push(['late success cannot overwrite an expired claim, and provider body never reaches durable logs', async () => {
  const store = await database(); let now = 1700000000000;
  const http = await receiver(async (_body, _headers, _req, res) => { now += 60001; res.writeHead(200); res.end('private-provider-value'); });
  try {
    const service = new DeliveryService({ repository: store.repo(), protocols: [protocol], transport: http.transport, now: () => now });
    await service.enqueue(envelope);
    assert.equal((await service.dispatch(envelope.id))!.state, 'uncertain');
    const log = await service.log(envelope.id);
    assert.equal(log[0]!.outcome!.code, 'claim_expired');
    assert.equal(JSON.stringify(log).includes('private-provider-value'), false);
  } finally { await http.close(); await store.close(); }
}]);
  await runCases(t, foldedCases);
});
