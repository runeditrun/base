import { runCases } from '../helpers/cases.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMailSender, MailValidationError } from '../../index.mjs';
import { validateSendResult } from '../../src/core/validation.mjs';
import { config, message, accepted, verifyRequest, NOW } from './fixtures.mjs';

const redacted = error => error instanceof MailValidationError && !error.message.includes('SENSITIVE');
test("Messaging facade preserves signed effects and conservative readback outcomes", async t => {
  const foldedCases = [];
foldedCases.push(['public Messaging facade signs actual bytes, snapshots inputs, reconciles escaped IDs and erases exact mailbox', async () => {
  const original = message();
  original.unsubscribe = { url: 'https://app.example.test/unsubscribe', oneClick: true };
  const input = structuredClone(original), options = config();
  const seen = [];
  const sender = createMailSender(options, { clock: () => NOW, fetch: async (url, init) => {
    const bytes = verifyRequest(url, init); seen.push({ url, init, bytes });
    if (init.method === 'GET') return Response.json({ deliveryId: original.deliveryId, messageId: 'message-service-1', state: 'accepted', result: accepted(), attempts: [{ provider: 'resend', outcome: 'accepted', httpStatus: 200, code: null, durationMs: 12 }], lastEvent: null });
    return Response.json(url.endsWith('/v1/erase') ? { erased: true } : accepted());
  } });
  options.installId = 'SENSITIVE'; options.signingKey.d = 'invalid';
  const pending = sender.send(input);
  input.to[0] = 'changed@example.test'; input.attachments[0].content.fill(4); input.subject = 'changed';
  assert.deepEqual(await pending, accepted());
  const wire = JSON.parse(seen[0].bytes);
  assert.equal(wire.to, original.to[0]); assert.equal(wire.subject, original.subject);
  assert.deepEqual(Buffer.from(wire.attachments[0].content, 'base64'), Buffer.from(original.attachments[0].content));
  assert.equal(wire.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click'); assert.equal('unsubscribe' in wire, false);
  assert.equal(wire.kind, original.kind); assert.equal(wire.expiresAt, original.expiresAt);
  assert.equal((await sender.reconcile(original.deliveryId)).result.status, 'accepted');
  assert.equal(seen[1].url, `${config().serviceOrigin}/v1/messages/${encodeURIComponent(original.deliveryId)}`);
  assert.equal(seen[1].init.body, undefined); assert.equal(seen[1].bytes.length, 0);
  assert.deepEqual(await sender.erase('Reader@example.test'), { erased: true });
  assert.deepEqual(JSON.parse(seen[2].bytes), { address: 'Reader@example.test' });
  assert.equal(seen.length, 3);
}]);
foldedCases.push(['signed service binding and closed provider-specific outcomes never fall back or expose malformed fields', async (t) => {
  let calls = 0, value = accepted();
  const serviceBinding = { async fetch(url, init) { assert.equal(this, serviceBinding); verifyRequest(url, init); calls++; return Response.json(value); } };
  const sender = createMailSender(config(), { serviceBinding, clock: () => NOW });
  const valid = [accepted(), { provider: 'messaging', status: 'development', providerMessageId: null },
    { provider: 'messaging', status: 'rejected', providerMessageId: null, code: 'suppressed', suppression: 'hard_bounce' },
    { provider: 'messaging', status: 'rate_limited', providerMessageId: null, code: 'app_cap', retryAfter: NOW / 1000 + 50 },
    { provider: 'messaging', status: 'uncertain', providerMessageId: null, code: 'in_progress', retryAfter: NOW / 1000 + 10 }];
  await runCases(t, Array.from(valid, (rowValue, rowIndex) => [`${t.name}: rowValue row ${rowIndex + 1}`, async t => {value = rowValue;
assert.deepEqual(await sender.send(message()), value);
}]));
  const invalid = [{ ...accepted(), code: 'SENSITIVE' }, { ...accepted(), provider: 'resend' }, { ...accepted(), status: 'constructor' },
    { ...valid[2], suppression: 'SENSITIVE' }, { ...valid[3], retryAfter: 'SENSITIVE' }, { ...valid[4], retryAfter: undefined },
    { ...accepted(), recipientResults: [] }, { ...valid[3], code: 'suppressed' }, { ...accepted(), debug: 'SENSITIVE' }];
  await runCases(t, Array.from(invalid, (rowValue, rowIndex) => [`${t.name}: rowValue row ${rowIndex + 1}`, async t => {value = rowValue;

    assert.throws(() => validateSendResult(value, 'messaging'), redacted);
    const result = await sender.send(message());
    assert.deepEqual(result, { provider: 'messaging', status: 'uncertain', providerMessageId: null, code: 'ambiguous' });
}]));
  assert.equal(calls, valid.length + invalid.length);
  await runCases(t, Array.from(['sendgrid', 'resend', 'cloudflare', 'development'], (provider, rowIndex) => [`${t.name}: provider row ${rowIndex + 1}`, async t => {
    const result = { provider, status: provider === 'development' ? 'development' : 'accepted', providerMessageId: null, retryAfter: 1 };
    assert.throws(() => validateSendResult(result, provider), redacted);
}]));
}]);
foldedCases.push(['invalid envelopes/settings fail before dispatch; missing and failed reads remain honest', async (t) => {
  let calls = 0;
  const sender = createMailSender(config(), { clock: () => NOW, fetch: async () => { calls++; return new Response(null, { status: 404 }); } });
  await runCases(t, Array.from([{ ...message(), kind: undefined }, { ...message(), kind: 'sms' }, { ...message(), to: ['a@example.test', 'b@example.test'] },
    { ...message(), cc: [] }, { ...message(), bcc: [] }, { ...message(), expiresAt: '2026-02-30T00:00:00Z' },
    { ...message(), customArgs: {} }, { ...message(), headers: { Authorization: 'SENSITIVE' } }], (bad, rowIndex) => [`${t.name}: bad row ${rowIndex + 1}`, async t => {
await assert.rejects(sender.send(bad), redacted);
}]));
  assert.equal(calls, 0);
  await runCases(t, [
    ["messaging configuration inputs: case 1", async t => {
      assert.throws(() => createMailSender({ ...config(), apiKey: 'SENSITIVE' }), redacted);
    }],
    ["messaging configuration inputs: case 2", async t => {
      assert.throws(() => createMailSender({ ...config(), serviceOrigin: 'https://messaging.example.test/path' }), redacted);
    }],
    ["messaging configuration inputs: case 3", async t => {
      assert.throws(() => createMailSender(config(), { serviceBinding: { fetch() {} }, fetch() {} }), redacted);
    }]
  ]);
  await runCases(t, Array.from(['sendgrid', 'resend'], (provider, rowIndex) => [`${t.name}: provider row ${rowIndex + 1}`, async t => {
    const direct = createMailSender({ provider, mode: 'test', apiKey: 'test-key' }, { fetch: async () => { calls++; throw Error('unexpected'); } });
    await assert.rejects(direct.send(message()), redacted);
}]));
  assert.equal(calls, 0);
  await runCases(t, [
    ["messaging operation inputs: case 1", async t => {
      assert.equal(await sender.reconcile('not-found'), null);
    }],
    ["messaging operation inputs: case 2", async t => {
      await assert.rejects(sender.erase('Reader@example.test'), redacted);
    }],
    ["messaging operation inputs: case 3", async t => {
      await assert.rejects(sender.erase('Reader <Reader@example.test>'), redacted);
    }]
  ]);
}]);
foldedCases.push(['one network attempt covers error, redirect, missing response, hanging fetch and hanging body', async (t) => {
  await runCases(t, Array.from([async () => { throw Error('SENSITIVE'); }, async () => new Response('SENSITIVE', { status: 503 }),
    async () => new Response(null, { status: 302, headers: { Location: 'https://evil.test' } }), async () => Response.json({ secret: 'SENSITIVE' }),
    async () => new Response('SENSITIVE'), async () => new Response('x'.repeat(1024 * 1024 + 1)),
    async () => new Promise(() => {}), async () => new Response(new ReadableStream({ start() {} }))], (edge, rowIndex) => [`${t.name}: edge row ${rowIndex + 1}`, async t => {
    let calls = 0;
    const sender = createMailSender(config(), { clock: () => NOW, timeoutMilliseconds: 25, fetch: (...args) => { calls++; return edge(...args); } });
    assert.deepEqual(await sender.send(message()), { provider: 'messaging', status: 'uncertain', providerMessageId: null, code: 'ambiguous' });
    assert.equal(calls, 1);
}]));
}]);
  await runCases(t, foldedCases);
});
