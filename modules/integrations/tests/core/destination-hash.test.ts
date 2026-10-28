import { runCases, type Case } from '../cases.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { DeliveryService } from '../../core/delivery.ts';
import { hmac } from '../../core/crypto.ts';
import type { DeliveryProtocol, WireRequest } from '../../core/types.ts';
import { database } from './support.ts';

const now = 1700000000000;
const envelope = { id: 'hashed', tenant: 'tenant', destinationId: 'receiver-v1', event: 'changed', protocol: 'hash-test', body: '{ "text": "λ 🚀" }\n' };
const endpoint = 'https://receiver.example.com/hook';
const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
function protocol(resolve = () => endpoint): DeliveryProtocol {
  return { id: envelope.protocol, async prepare(input) { return { url: resolve(), headers: { 'content-type': 'application/json' }, body: input.body }; },
    classify() { return { kind: 'accepted', code: 'acknowledged' }; } };
}

test("durable destination hashing binds preparation to the current claimed immutable delivery", async t => {
  const foldedCases: Case[] = [];
foldedCases.push(['default destination hash preserves every queued field and exact outbound request', async () => {
  const store = await database(); let sent: WireRequest | undefined;
  try {
    const service = new DeliveryService({ repository: store.repo(), protocols: [protocol()], now: () => now,
      transport: { async send(wire) { sent = wire; return { status: 204, headers: {}, body: '' }; } } });
    const destinationHash = digest(endpoint), maxAttempts = 4, retryDelaysMs = [1000, 5000, 30000];
    const expected = { ...envelope, fingerprint: digest(JSON.stringify({ envelope, destinationHash, maxAttempts, retryDelaysMs })),
      destinationHash, state: 'queued', attempts: 0, createdAt: now, nextAt: now, claim: null, claimUntil: null, maxAttempts, retryDelaysMs };
    assert.ok(JSON.stringify(await service.enqueue(envelope)) === JSON.stringify(expected), 'default durable fields are byte-identical');
    assert.ok((await service.dispatch(envelope.id))?.state === 'accepted');
    assert.ok(JSON.stringify(sent) === JSON.stringify(await protocol().prepare(envelope, now)), 'default wire is byte-identical');
  } finally { await store.close(); }
}]);
for (const prefix of ['', 'hmac-v1:']) foldedCases.push([`configured keyed destination digest persists across restart${prefix ? ' with a version' : ''}`, async () => {
  const store = await database(), key = randomBytes(48); let sends = 0, hashes = 0;
  const hashDestination = async (url: string) => { hashes++; return prefix + await hmac(key, digest(url)); };
  const transport = { async send(wire: WireRequest) {
    sends++; assert.ok(JSON.stringify(wire) === JSON.stringify(await protocol().prepare(envelope, now)), 'hash configuration cannot enter wire');
    return { status: 204, headers: {}, body: '' };
  } };
  const create = () => new DeliveryService({ repository: store.repo(), protocols: [protocol()], transport, now: () => now, hashDestination });
  try {
    let service = create(); const row = await service.enqueue(envelope);
    const expected = prefix + createHmac('sha256', key).update(digest(endpoint), 'utf8').digest('hex');
    assert.ok(row.destinationHash === expected, 'stored digest matches independent Node HMAC answer');
    assert.ok(row.destinationHash !== digest(endpoint), 'stored digest differs from raw URL SHA-256');
    const persisted = JSON.stringify(await store.repo().query('SELECT * FROM integration_deliveries WHERE namespace=?'));
    assert.ok(!persisted.includes(endpoint) && !persisted.includes(key.toString('hex')), 'configuration is absent from durable fields');
    store.restart(); service = create();
    assert.ok((await service.get(envelope.id))?.destinationHash === expected, 'restart retains keyed digest');
    assert.ok((await service.dispatch(envelope.id))?.state === 'accepted');
    assert.ok(hashes === 2 && sends === 1, 'enqueue and dispatch both use the supplied hasher');
    assert.ok((await service.get(envelope.id))?.attempts === 1);
  } finally { await store.close(); }
}]);
foldedCases.push(['keyed destination drift rejects during preflight without transport', async () => {
  const store = await database(), key = randomBytes(32); let url = endpoint, sends = 0;
  try {
    const service = new DeliveryService({ repository: store.repo(), protocols: [protocol(() => url)], now: () => now,
      hashDestination: async value => 'hmac-v1:' + await hmac(key, digest(value)),
      transport: { async send() { sends++; return { status: 204, headers: {}, body: '' }; } } });
    await service.enqueue(envelope); url += '/changed';
    assert.ok((await service.dispatch(envelope.id))?.state === 'rejected');
    assert.ok(sends === 0 && (await service.get(envelope.id))?.attempts === 1);
    assert.ok((await service.log(envelope.id))[0]?.outcome?.code === 'preflight_failed');
  } finally { await store.close(); }
}]);
for (const phase of ['enqueue', 'dispatch'] as const) foldedCases.push([`invalid destination digests cannot ${phase === 'enqueue' ? 'insert a delivery' : 'start transport'}`, async () => {
  const store = await database(); let sends = 0;
  try {
    for (const [index, value] of invalid.entries()) {
      let valid = phase === 'dispatch';
      const service = new DeliveryService({ repository: store.repo(), protocols: [protocol()], now: () => now,
        hashDestination: async () => (valid ? digest(endpoint) : value) as string,
        transport: { async send() { sends++; return { status: 204, headers: {}, body: '' }; } } });
      const input = { ...envelope, id: `invalid-${index}` };
      if (phase === 'enqueue') {
        await assert.rejects(service.enqueue(input), /^Error: Invalid destination hash$/);
        assert.ok(await service.get(input.id) === null, 'invalid hash cannot insert');
        assert.ok((await service.log(input.id)).length === 0, 'invalid hash cannot create an attempt');
      } else {
        await service.enqueue(input); valid = false;
        assert.ok((await service.dispatch(input.id))?.state === 'rejected', 'invalid hash rejects preflight');
        assert.ok((await service.log(input.id))[0]?.outcome?.code === 'preflight_failed');
      }
    }
    assert.ok(sends === 0, 'invalid hash cannot start transport');
  } finally { await store.close(); }
}]);
for (const reconcile of [false, true]) foldedCases.push([`asynchronous hashing preserves the durable claim check${reconcile ? ' after reconciliation' : ''}`, async () => {
  const store = await database(); let clock = now, calls = 0, sends = 0;
  try {
    const service = new DeliveryService({ repository: store.repo(), protocols: [protocol()], now: () => clock,
      hashDestination: async value => {
        if (++calls === 2) { clock += 60001; await service.recoverExpired(); if (reconcile) await service.resolveUncertain(envelope.id, 'rejected', 'operator_confirmed'); }
        return digest(value);
      }, transport: { async send() { sends++; return { status: 204, headers: {}, body: '' }; } } });
    await service.enqueue(envelope);
    assert.ok((await service.dispatch(envelope.id))?.state === (reconcile ? 'rejected' : 'uncertain'));
    assert.ok(sends === 0, 'expired hashing cannot send');
    assert.ok((await service.log(envelope.id))[0]?.outcome?.code === 'claim_expired');
  } finally { await store.close(); }
}]);
  await runCases(t, foldedCases);
});





const invalid = [null, undefined, 42, {}, 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(64) + '\n',
  ':', 'Hmac-v1:', '1hmac:', 'a'.repeat(17) + ':', 'hmac_v1:', 'hmac:v1:'].map(value => typeof value === 'string' && value.endsWith(':') ? value + 'a'.repeat(64) : value);
