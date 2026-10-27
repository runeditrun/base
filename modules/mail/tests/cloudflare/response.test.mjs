import { runCases } from '../helpers/cases.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { sendCloudflare } from '../../src/adapters/cloudflare/index.mjs';
import { config, message, success, transport } from './fixtures.mjs';

const send = (body, input = message()) => sendCloudflare(config, input, transport(body));

test("Cloudflare response disposition preserves recipient truth under malformed or bounded reads", async t => {
  const foldedCases = [];
foldedCases.push(["Cloudflare acceptance conservatively preserves exact recipient outcomes", async t => {
  // Each row keeps its original assertions and reports its own failure name.
  await runCases(t, [
    ['documented REST success without message_id returns nullable ID, not invented correlation', async t => {

  await runCases(t, [
['missing provider ID remains null', async t => {
  assert.deepEqual(await send(success()), {
    provider: 'cloudflare', status: 'accepted', providerMessageId: null,
    recipientResults: [{ recipient: 'a@example.com', status: 'accepted' }],
  });
}],
['explicit null ID remains null', async t => {
  assert.equal((await send(success({ message_id: null }))).providerMessageId, null);
}],
['usable provider ID remains exact', async t => {
  assert.equal((await send(success({ message_id: '<real@cloudflare.example>' }))).providerMessageId, '<real@cloudflare.example>');
}]
  ]);
}],
    ['queued recipients are accepted without claiming mailbox receipt', async () => {
  const result = await send(success({ delivered: [], queued: ['a@example.com'] }));
  assert.equal(result.status, 'accepted');
  assert.equal(result.recipientResults[0].status, 'accepted');
  assert.equal(Object.hasOwn(result, 'delivered'), false);
}],
    ['partial bounces and suppressions remain visible, conservative and correlated across all envelopes', async () => {
  const result = await send(success({
    message_id: '<real@cloudflare.example>', queued: ['c@example.com'],
    permanent_bounces: ['b@example.com'], suppressed_recipients: ['hidden@example.com'],
  }), message({ to: ['a@example.com', 'b@example.com'], cc: ['c@example.com'], bcc: ['hidden@example.com'] }));
  assert.deepEqual(result, {
    provider: 'cloudflare', status: 'uncertain', providerMessageId: '<real@cloudflare.example>',
    code: 'cloudflare_partial_recipient_failure', recipientResults: [
      { recipient: 'a@example.com', status: 'accepted' }, { recipient: 'b@example.com', status: 'rejected' },
      { recipient: 'c@example.com', status: 'accepted' }, { recipient: 'hidden@example.com', status: 'rejected' },
    ],
  });
}],
    ['all bounce or suppressed recipients reject without fabricating delivery', async (t) => {
  await runCases(t, Array.from(['permanent_bounces', 'suppressed_recipients'], (field, rowIndex) => [`${t.name}: field row ${rowIndex + 1}`, async t => {
    const result = await send(success({ delivered: [], [field]: ['a@example.com'] }));
    assert.equal(result.status, 'rejected');
    assert.equal(result.code, 'cloudflare_recipients_rejected');
}]));
}],
    ['missing, duplicated, conflicting and extraneous recipient outcomes never pass', async (t) => {
  await runCases(t, Array.from([
    { delivered: [] }, { delivered: ['a@example.com', 'a@example.com'] },
    { queued: ['a@example.com'] }, { permanent_bounces: ['a@example.com'] },
    { delivered: ['a@example.com', 'outsider@example.com'] }, { delivered: ['Alice <a@example.com>'] },
    { delivered: ['a@example.com\nSECRET'] }, { delivered: [null] },
    { delivered: 'a@example.com' }, { queued: null }, { permanent_bounces: undefined },
    { suppressed_recipients: false },
  ], (fields, rowIndex) => [`${t.name}: fields row ${rowIndex + 1}`, async t => {
    const result = await send(success(fields));
    assert.equal(result.status, 'uncertain');
    assert.equal(result.code, 'cloudflare_incomplete_recipient_results');
    assert.deepEqual(result.recipientResults.map(item => item.recipient), ['a@example.com']);
    assert.ok(!JSON.stringify(result).includes('SECRET'));
    assert.ok(!JSON.stringify(result).includes('outsider'));
}]));
}],
    ['incomplete coverage preserves known outcomes and marks missing requested recipients uncertain', async () => {
  const result = await send(success(), message({ to: ['a@example.com', 'b@example.com'] }));
  assert.equal(result.status, 'uncertain');
  assert.deepEqual(result.recipientResults, [
    { recipient: 'a@example.com', status: 'accepted' }, { recipient: 'b@example.com', status: 'uncertain' },
  ]);
}],
    ['recipient matching ignores domain case only and unique mailboxes do not erase the sent envelope', async () => {
  const fixture = transport(success());
  const result = await sendCloudflare(config, message({ to: ['a@EXAMPLE.COM', 'a@EXAMPLE.COM'] }), fixture);
  assert.equal(result.status, 'accepted');
  assert.deepEqual(JSON.parse(fixture.calls[0].init.body).to, ['a@EXAMPLE.COM', 'a@EXAMPLE.COM']);
  assert.equal(result.recipientResults.length, 1);
  assert.equal((await send(success(), message({ to: ['A@example.com'] }))).status, 'uncertain');
}],
    ['2xx success flag, result schema and message IDs are checked independently of HTTP', async (t) => {
  await runCases(t, Array.from([null, {}, [], { success: true }, { ...success(), success: 'true' },
    { ...success(), result: null }, { ...success(), errors: null },
    { ...success(), errors: [{ code: 10002, message: 'secret provider text' }] },
    success({ message_id: 'secret\nheader' }), success({ message_id: '' }), success({ message_id: {} }),
    success({ message_id: 'x'.repeat(1025) }), { success: false, errors: [], result: { delivered: ['a@example.com'] } },
  ], (body, rowIndex) => [`${t.name}: body row ${rowIndex + 1}`, async t => {
    const result = await send(body);
    assert.equal(result.status, 'uncertain');
    assert.equal(result.providerMessageId, null);
    assert.ok(!JSON.stringify(result).includes('secret'));
}]));
}],
  ]);
}]);
foldedCases.push(['documented provider errors use fixed redacted codes including rate and transient failures', async (t) => {
  await runCases(t, Array.from([[10001, 'rejected'], [10101, 'rejected'], [10004, 'rate_limited'], [10002, 'uncertain'], [10003, 'uncertain'], [10100, 'uncertain']], ([code, status], rowIndex) => [`${t.name}: [code, status] row ${rowIndex + 1}`, async t => {
    assert.deepEqual(await send({ success: false, result: null, errors: [{ code, message: 'fixture-token BODY SECRET' }] }), {
      provider: 'cloudflare', status, providerMessageId: null, code: 'cloudflare_provider_error',
    });
}]));
}]);
foldedCases.push(['HTTP errors, redirects and interrupted transport make one attempt and redact raw errors', async (t) => {
  await runCases(t, Array.from([[300, 'uncertain'], [302, 'uncertain'], [400, 'rejected'], [401, 'rejected'], [403, 'rejected'], [408, 'uncertain'], [429, 'rate_limited'], [500, 'uncertain'], [503, 'uncertain']], ([http, status], rowIndex) => [`${t.name}: [http, status] row ${rowIndex + 1}`, async t => {
    const fixture = transport({ secret: 'fixture-token BODY' }, http);
    assert.deepEqual(await sendCloudflare(config, message(), fixture), {
      provider: 'cloudflare', status, providerMessageId: null, code: 'cloudflare_http_error',
    });
    assert.equal(fixture.calls.length, 1);
    assert.equal(fixture.calls[0].init.redirect, 'manual');
}]));
  let attempts = 0;
  const result = await sendCloudflare(config, message(), { fetch: async () => { attempts++; throw new Error('fixture-token BODY'); } });
  assert.deepEqual(result, { provider: 'cloudflare', status: 'uncertain', providerMessageId: null, code: 'cloudflare_transport_failed' });
  assert.equal(attempts, 1);
}]);
foldedCases.push(['empty, malformed, truncated, oversized and invalid UTF-8 response bodies remain uncertain', async (t) => {
  const responses = [
    new Response(null, { status: 204 }), new Response('not json secret'), new Response('{"success":'),
    new Response(' '.repeat(1024 * 1024 + 1)), new Response(new Uint8Array([255])),
    new Response(new ReadableStream({ start(controller) { controller.error(new Error('secret body')); } })),
  ];
  await runCases(t, Array.from(responses, (response, rowIndex) => [`${t.name}: response row ${rowIndex + 1}`, async t => {
    const result = await sendCloudflare(config, message(), { fetch: async () => response });
    assert.deepEqual(result, { provider: 'cloudflare', status: 'uncertain', providerMessageId: null, code: 'cloudflare_invalid_response' });
}]));
}]);
foldedCases.push(['an already-consumed transport response is redacted and uncertain', async () => {
  const response = new Response(JSON.stringify(success()));
  await response.text();
  assert.deepEqual(await sendCloudflare(config, message(), { fetch: async () => response }), {
    provider: 'cloudflare', status: 'uncertain', providerMessageId: null, code: 'cloudflare_invalid_response',
  });
}]);
foldedCases.push(['a stalled response body is bounded and its stream is cancelled', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  const pending = sendCloudflare(config, message(), { fetch: async () => response });
  // Let the request phase complete so this probes the body reader's own deadline.
  await new Promise(resolve => setImmediate(resolve));
  context.mock.timers.tick(15_000);
  const result = await pending;
  assert.equal(result.status, 'uncertain');
  assert.equal(result.code, 'cloudflare_invalid_response');
  assert.equal(cancelled, true);
}]);
  await runCases(t, foldedCases);
});
