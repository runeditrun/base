import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createWebhookProtocol, verifyWebhook } from '../../index.ts';
import type { Envelope, TimestampedBodySignature } from '../../index.ts';

const now = 1800000000987;
const key = new TextEncoder().encode('synthetic-random-secret-text-32-bytes-or-more');
const url = 'https://receiver.example.com/events';
const envelope: Envelope = { id: 'event-1', tenant: 'installation', destinationId: 'receiver-v1', event: 'incident.opened', protocol: 'webhook', body: '{}' };
const additional = { timestampHeader: 'X-Event-Timestamp', signatureHeader: 'X-Event-Signature' };
const makeProtocol = (timestampedBodySignature?: TimestampedBodySignature) => createWebhookProtocol({
  resolveDestination: async () => url, signingKey: async () => key, timestampedBodySignature,
});
function baseHeaders(body: string) {
  const timestamp = String(Math.floor(now / 1000));
  const canonical = JSON.stringify(['integrations.webhook.v1', envelope.tenant, envelope.destinationId, envelope.event, envelope.id, timestamp, body]);
  return { 'content-type': 'application/json', 'webhook-id': envelope.id,
    'webhook-tenant': envelope.tenant, 'webhook-destination': envelope.destinationId, 'webhook-event': envelope.event,
    'webhook-timestamp': timestamp, 'webhook-signature': `v1=${createHmac('sha256', key).update(canonical, 'utf8').digest('hex')}` };
}

test('omitting timestamped-body signing preserves the exact default webhook request and classifier', async () => {
  const protocol = createWebhookProtocol({ resolveDestination: async () => url, signingKey: async () => key });
  const expected = { url, body: envelope.body, headers: baseHeaders(envelope.body) };
  assert.equal(JSON.stringify(await protocol.prepare(envelope, now)), JSON.stringify(expected));
  assert.equal(JSON.stringify(await makeProtocol(undefined).prepare(envelope, now)), JSON.stringify(expected));
  const signed = makeProtocol(additional);
  for (const status of [200, 204, 302, 400, 401, 408, 429, 500, 503]) {
    const response = { status, headers: { 'retry-after': '9' }, body: '' };
    assert.deepEqual(signed.classify(response, now), protocol.classify(response, now));
  }
  for (const status of [302, 408, 500, 503])
    assert.equal(signed.classify({ status, headers: {}, body: '' }, now).kind, 'uncertain');
});

test('timestamped-body signature matches independent HMAC over exact Unicode, newlines, BOM and empty body', async () => {
  const protocol = makeProtocol(additional);
  const bodies = ['', '{}', '{\r\n "text": "Café λ 🚀 e\u0301 �", "number": 1\n}\n', '\ufeff{"text":"signed BOM"}'];
  for (const body of bodies) {
    const wire = await protocol.prepare({ ...envelope, body }, now);
    const iso = wire.headers[additional.timestampHeader]!;
    assert.equal(iso, new Date(Math.floor(now / 1000) * 1000).toISOString());
    assert.equal(Date.parse(iso), Number(wire.headers['webhook-timestamp']) * 1000);
    assert.equal(wire.body, body);
    assert.deepEqual(Buffer.from(wire.body, 'utf8'), Buffer.from(body, 'utf8'));
    const signature = wire.headers[additional.signatureHeader]!;
    assert.match(signature, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(signature, createHmac('sha256', key).update(iso + '.', 'utf8').update(Buffer.from(body, 'utf8')).digest('base64url'));
    assert.notEqual(signature, createHmac('sha256', key).update(iso + '.' + body + '\n', 'utf8').digest('base64url'));
    assert.deepEqual(wire.headers, { ...baseHeaders(body), [additional.timestampHeader]: iso, [additional.signatureHeader]: signature });
    const verified = await verifyWebhook({ ...wire, body: Buffer.from(body, 'utf8'), key, tenant: envelope.tenant, destinationId: envelope.destinationId, now });
    assert.equal(verified.envelope.body, body);
  }
});

test('a configured body signing resolver can use a separate key while Base verification retains its own key', async () => {
  const bodyKey = new Uint8Array(32).fill(91);
  let baseCalls = 0, bodyCalls = 0;
  const protocol = createWebhookProtocol({ resolveDestination: async () => url,
    signingKey: async actual => { assert.equal(actual, envelope); baseCalls++; return key; },
    timestampedBodySignature: { ...additional, signingKey: async actual => { assert.equal(actual, envelope); bodyCalls++; return bodyKey; } },
  });
  const wire = await protocol.prepare(envelope, now);
  assert.equal(baseCalls, 1); assert.equal(bodyCalls, 1);
  const input = wire.headers[additional.timestampHeader] + '.' + envelope.body;
  assert.equal(wire.headers[additional.signatureHeader], createHmac('sha256', bodyKey).update(input).digest('base64url'));
  assert.notEqual(wire.headers[additional.signatureHeader], createHmac('sha256', key).update(input).digest('base64url'));
  assert.equal(wire.headers['webhook-signature'], baseHeaders(envelope.body)['webhook-signature']);
  await verifyWebhook({ ...wire, key, tenant: envelope.tenant, destinationId: envelope.destinationId, now });
});

test('both signatures retain one key snapshot when caller-owned bytes rotate during real WebCrypto signing', async () => {
  for (const buffer of [false, true]) {
    const storage = buffer ? Buffer.alloc(48, 37) : new Uint8Array(48).fill(37);
    const shared = storage.subarray(8, 40);
    const original = new Uint8Array(shared);
    let resolutions = 0, rotations = 0;
    const protocol = createWebhookProtocol({ resolveDestination: async () => url,
      signingKey: async () => {
        resolutions++;
        // The first microtask precedes prepare's await continuation. The second
        // follows its first real WebCrypto import, before that HMAC can finish.
        // This orders rotation without timers or replacing any crypto method.
        queueMicrotask(() => queueMicrotask(() => { shared.fill(83); rotations++; }));
        return shared;
      },
      timestampedBodySignature: additional,
    });
    const wire = await protocol.prepare(envelope, now);
    assert.equal(resolutions, 1);
    assert.equal(rotations, 1);
    const timestamp = String(Math.floor(now / 1000));
    const canonical = JSON.stringify(['integrations.webhook.v1', envelope.tenant, envelope.destinationId, envelope.event, envelope.id, timestamp, envelope.body]);
    const bodyInput = `${new Date(Number(timestamp) * 1000).toISOString()}.${envelope.body}`;
    assert.equal(wire.headers['webhook-signature'], `v1=${createHmac('sha256', original).update(canonical, 'utf8').digest('hex')}`);
    assert.equal(wire.headers[additional.signatureHeader], createHmac('sha256', original).update(bodyInput, 'utf8').digest('base64url'));
    assert.notEqual(wire.headers[additional.signatureHeader], createHmac('sha256', shared).update(bodyInput, 'utf8').digest('base64url'));
  }
});

test('timestamped-body signing refuses short or non-byte keys from either resolver', async () => {
  for (const invalid of [new Uint8Array(0), new Uint8Array(31), 'a'.repeat(32), new Array(32).fill(1), null, undefined]) {
    const invalidKey = invalid as Uint8Array;
    await assert.rejects(makeProtocol({ ...additional, signingKey: async () => invalidKey }).prepare(envelope, now), /at least 32 bytes/);
    for (const timestampedBodySignature of [additional, { ...additional, signingKey: async () => key }]) {
      const protocol = createWebhookProtocol({ resolveDestination: async () => url, signingKey: async () => invalidKey, timestampedBodySignature });
      await assert.rejects(protocol.prepare(envelope, now), /at least 32 bytes/);
    }
  }
  const failure = new Error('fixture resolver failure');
  await assert.rejects(makeProtocol({ ...additional, signingKey: async () => { throw failure; } }).prepare(envelope, now), error => error === failure);
  await assert.rejects(makeProtocol(additional).prepare({ ...envelope, body: '\ud800' }, now), /valid UTF-8/);
});

test('timestamped-body headers reject illegal tokens, duplicates and case-insensitive Base or transport header overrides', () => {
  const invalidNames = ['', 'x space', ' x-leading', 'x-trailing ', 'x:colon', 'x\r\ninjected', 'x\n', 'café', 'x\t', 'x/invalid', null, undefined, 42];
  for (const name of invalidNames) {
    assert.throws(() => makeProtocol({ ...additional, timestampHeader: name as string }), /header name/);
    assert.throws(() => makeProtocol({ ...additional, signatureHeader: name as string }), /header name/);
  }
  for (const name of ['content-type', 'webhook-id', 'webhook-tenant', 'webhook-destination', 'webhook-event', 'webhook-timestamp', 'webhook-signature',
    'host', 'connection', 'content-length', 'transfer-encoding', 'proxy-authorization', 'authorization', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'upgrade']) {
    assert.throws(() => makeProtocol({ ...additional, timestampHeader: name.toUpperCase() }), /cannot replace Base headers/);
    assert.throws(() => makeProtocol({ ...additional, signatureHeader: name.toUpperCase() }), /cannot replace Base headers/);
  }
  for (const signatureHeader of ['X-Same', 'x-same'])
    assert.throws(() => makeProtocol({ timestampHeader: 'X-Same', signatureHeader }), /distinct/);
  assert.throws(() => makeProtocol({ ...additional, signingKey: null as unknown as TimestampedBodySignature['signingKey'] }), /key resolver/);
});

test('all legal token punctuation works and later option mutation cannot replace Base headers', async () => {
  const options = { timestampHeader: "X-!#$%&'*+.^_`|~", signatureHeader: '__proto__' };
  const protocol = makeProtocol(options);
  const names = { ...options };
  options.timestampHeader = 'webhook-timestamp'; options.signatureHeader = 'content-type';
  const wire = await protocol.prepare(envelope, now);
  assert.equal(wire.headers[names.timestampHeader], new Date(Math.floor(now / 1000) * 1000).toISOString());
  assert.match(wire.headers[names.signatureHeader]!, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(wire.headers['webhook-timestamp'], baseHeaders(envelope.body)['webhook-timestamp']);
  assert.equal(wire.headers['content-type'], 'application/json');
  assert.equal(Object.getPrototypeOf(wire.headers), Object.prototype);
});
