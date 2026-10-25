import test from 'node:test';
import assert from 'node:assert/strict';
import { createMailSender, MailValidationError, serializeSendGridMessage as serializeMailMessage } from '../../index.mjs';
import { sendSendGrid, serializeSendGridMessage, SendGridSendError } from '../../src/sendgrid-email/index.mjs';

const message = () => ({ from: 'Support <support@example.com>', to: ['person@example.com'], subject: 'Your request', text: 'Reply', html: '<p>Reply</p>', deliveryId: 'durable-1' });
const accept = async () => new Response(null, { status: 202, headers: { 'x-message-id': 'receipt-1' } });

test('the former message shape preserves explicit attachment MIME and disabled subscription tracking', () => {
  const input = { ...message(), subscriptionTracking: false, attachments: [{ content: 'aGk=', filename: 'proof.txt', type: 'text/plain' }] };
  assert.equal(serializeSendGridMessage(input), serializeMailMessage({
    ...input, attachments: [{ content: Uint8Array.of(104, 105), filename: 'proof.txt', contentType: 'text/plain' }],
  }));
});

test('messages without attachments retain the historical claim fingerprint bytes', () => {
  const wire = serializeSendGridMessage({
    from: 'Support <support@example.com>', to: ['Ada <ada@example.net>', 'grace@example.net'], subject: 'S ✓', text: 'T', html: '<p>x</p>',
    replyTo: '"Re" <r@example.com>', headers: { 'X-A': 'b' }, asmGroupId: 5, subscriptionTracking: false, customArgs: { b: '1', a: '2' }, deliveryId: 'd1',
  });
  // Both API paths share a serializer; an independent historical envelope guards durable fingerprints.
  assert.equal(wire, '{"personalizations":[{"to":[{"email":"ada@example.net","name":"Ada"},{"email":"grace@example.net"}]}],"from":{"email":"support@example.com","name":"Support"},"subject":"S ✓","content":[{"type":"text/plain","value":"T"},{"type":"text/html","value":"<p>x</p>"}],"reply_to":{"email":"r@example.com","name":"Re"},"headers":{"X-A":"b"},"custom_args":{"b":"1","a":"2","rer_delivery_id":"d1"},"asm":{"group_id":5},"tracking_settings":{"click_tracking":{"enable":false,"enable_text":false},"open_tracking":{"enable":false},"ganalytics":{"enable":false},"subscription_tracking":{"enable":false}}}');
});

test('base64 attachments become bytes and a missing type is a generic binary type', () => {
  const wire = JSON.parse(serializeSendGridMessage({ ...message(), attachments: [{ content: 'AP+ACg==', filename: 'bytes.bin' }] }));
  assert.deepEqual(wire.attachments, [{ content: 'AP+ACg==', type: 'application/octet-stream', filename: 'bytes.bin', disposition: 'attachment' }]);
});

test('invalid attachment content is rejected before any request', async () => {
  for (const content of ['not base64!', '', 42, null]) {
    let calls = 0;
    await assert.rejects(sendSendGrid({ apiKey: 'k', message: { ...message(), attachments: [{ content, filename: 'a.txt' }] }, fetch: async () => { calls++; return accept(); } }),
      error => error instanceof SendGridSendError && error.outcome === 'rejected');
    assert.equal(calls, 0);
  }
});

test('html may be null or empty, and fields the former module ignored stay ignored', async () => {
  for (const html of [null, '', undefined]) {
    let body;
    await sendSendGrid({ apiKey: 'k', message: { ...message(), html, unknownField: true }, fetch: async (_url, init) => { body = JSON.parse(init.body); return accept(); } });
    assert.deepEqual(body.content, [{ type: 'text/plain', value: 'Reply' }]);
  }
});

test('validation failures are rejections that never echo input values', async () => {
  for (const extra of [{ from: 'canary-secret' }, { to: ['canary-secret'] }, { headers: { From: 'canary-secret@example.com' } }, { deliveryId: '' }, { asmGroupId: 'canary-secret' }]) {
    await assert.rejects(sendSendGrid({ apiKey: 'k', message: { ...message(), ...extra }, fetch: async () => { throw new Error('must not send'); } }), error => {
      assert.ok(error instanceof SendGridSendError && error.outcome === 'rejected' && error.status === undefined);
      assert.doesNotMatch(error.message, /canary/);
      return true;
    });
  }
  assert.throws(() => serializeSendGridMessage({ ...message(), to: [] }), SendGridSendError);
  assert.throws(() => serializeSendGridMessage(null), SendGridSendError);
});

test('a blank or malformed API key is rejected before any request', async () => {
  for (const apiKey of ['', '   ', 'two words', undefined]) {
    let calls = 0;
    await assert.rejects(sendSendGrid({ apiKey, message: message(), fetch: async () => { calls++; return accept(); } }), error => error instanceof SendGridSendError && error.outcome === 'rejected');
    assert.equal(calls, 0);
  }
});

test('HTTP outcomes keep the exact status the former module reported', async () => {
  const cases = [[400, 'rejected'], [403, 'rejected'], [429, 'rate_limited'], [408, 'ambiguous'], [500, 'ambiguous'], [307, 'ambiguous'], [200, 'ambiguous']];
  for (const [status, outcome] of cases) {
    await assert.rejects(sendSendGrid({ apiKey: 'k', message: message(), fetch: async () => new Response('PRIVATE body', { status }) }), error => {
      assert.ok(error instanceof SendGridSendError);
      assert.equal(error.outcome, outcome);
      assert.equal(error.status, status);
      assert.doesNotMatch(error.message, /PRIVATE|\bk\b/);
      return true;
    });
  }
  await assert.rejects(sendSendGrid({ apiKey: 'k', message: message(), fetch: async () => { throw new Error('PRIVATE'); } }), error => error.outcome === 'ambiguous' && error.status === undefined && !/PRIVATE/.test(error.message));
});

test('timeoutMilliseconds bounds the single attempt', { timeout: 10_000 }, async () => {
  let calls = 0;
  const start = performance.now();
  await assert.rejects(sendSendGrid({ apiKey: 'k', message: message(), timeoutMilliseconds: 50, fetch: () => { calls++; return new Promise(() => {}); } }),
    error => error instanceof SendGridSendError && error.outcome === 'ambiguous' && error.status === undefined);
  assert.equal(calls, 1);
  assert.ok(performance.now() - start < 5_000);
});

test('the mail facade accepts the same optional timeout and rejects invalid values', { timeout: 10_000 }, async () => {
  const config = { provider: 'sendgrid', mode: 'test', apiKey: 'fixture-key' };
  const start = performance.now();
  const result = await createMailSender(config, { timeoutMilliseconds: 50, fetch: () => new Promise(() => {}) }).send(message());
  assert.equal(result.status, 'uncertain');
  assert.ok(performance.now() - start < 5_000);
  for (const timeoutMilliseconds of [0, -1, 1.5, '50', Number.NaN]) {
    assert.throws(() => createMailSender(config, { timeoutMilliseconds, fetch: accept }), error => error instanceof MailValidationError && error.code === 'invalid_timeout');
  }
});

test('an empty headers object is the same SendGrid request as no headers', async () => {
  const bodies = [];
  const send = input => createMailSender({ provider: 'sendgrid', mode: 'test', apiKey: 'fixture-key' }, { fetch: async (_url, init) => { bodies.push(init.body); return accept(); } }).send(input);
  await send(message());
  await send({ ...message(), headers: {} });
  await send({ ...message(), headers: { 'X-A': 'b' } });
  assert.equal(bodies[0], bodies[1]);
  assert.equal(JSON.parse(bodies[0]).headers, undefined);
  assert.deepEqual(JSON.parse(bodies[2]).headers, { 'X-A': 'b' });
});
