import { checkCases } from '../onboarding/test-fixture.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { notFoundResponse, rejectedResponse } from './runtime/rejected-response.ts';

function streamedRequest(body) {
  return new Request('https://example.test/missing', {
    method: 'POST',
    body,
    duplex: 'half',
  });
}

test('rejected upload draining preserves usable responses and refuses oversized or stalled bodies', { timeout: 5_000 }, () => checkCases([
  ["rejected uploads drain readable bodies and preserve the supplied response", () => checkCases([
  ['drains ordinary JSON and preserves the supplied response', async () => {
  const request = new Request('https://example.test/missing', {
    method: 'POST',
    body: JSON.stringify({ ignored: 'input' }),
  });
  const supplied = new Response('Denied', { status: 403, headers: { 'x-reason': 'policy' } });
  const result = await rejectedResponse(request, supplied);
  assert.equal(result, supplied);
  assert.equal(result.status, 403);
  assert.equal(result.headers.get('x-reason'), 'policy');
  assert.equal(await result.text(), 'Denied');
  assert.equal(request.bodyUsed, true);
}],
  ['accepts exactly 64 KiB across multiple chunks', async () => {
  const request = streamedRequest(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(32 * 1024));
      controller.enqueue(new Uint8Array(32 * 1024));
      controller.close();
    },
  }));
  const supplied = new Response(null, { status: 404 });
  assert.equal(await rejectedResponse(request, supplied), supplied);
}],
  ['preserves the supplied response for an already consumed body', async () => {
  const request = new Request('https://example.test/missing', { method: 'POST', body: 'used' });
  await request.text();
  const supplied = new Response(null, { status: 405 });
  assert.equal(await rejectedResponse(request, supplied), supplied);
}],
  ['preserves the supplied response when there is no body', async () => {
  const supplied = new Response(null, { status: 405 });
  assert.equal(await rejectedResponse(new Request('https://example.test/missing'), supplied), supplied);
}],
  ['propagates body read failures', async () => {
  const failure = new Error('transport failed');
  const request = streamedRequest(new ReadableStream({
    start(controller) { controller.error(failure); },
  }));
  await assert.rejects(rejectedResponse(request, new Response(null, { status: 404 })), error => error === failure);
}]
 ])],
  ['rejects a body one byte over 64 KiB and cancels its stream', async () => {
  let cancelled = false;
  const request = streamedRequest(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(64 * 1024));
      controller.enqueue(new Uint8Array(1));
    },
    cancel() { cancelled = true; },
  }));
  const result = await rejectedResponse(request, new Response(null, { status: 404 }));
  assert.equal(result.status, 413);
  assert.equal(cancelled, true);
}],
  ['a stalled body receives 408 within the bounded drain timeout', async () => {
  let cancelled = false;
  const request = streamedRequest(new ReadableStream({
    cancel() { cancelled = true; },
  }));
  const started = performance.now();
  const result = await rejectedResponse(request, new Response(null, { status: 404 }));
  const elapsed = performance.now() - started;
  assert.equal(result.status, 408);
  assert.ok(elapsed >= 1_800, `timeout fired too early: ${elapsed}ms`);
  assert.ok(elapsed < 4_000, `timeout exceeded its bound: ${elapsed}ms`);
  assert.equal(cancelled, true);
}],
  ['notFoundResponse drains unused input and returns a 404', async () => {
  const request = new Request('https://example.test/missing', { method: 'POST', body: 'ignored' });
  assert.equal((await notFoundResponse(request)).status, 404);
  assert.equal(request.bodyUsed, true);
}]
]));
