import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { signInThroughOutbox } from '../index.mjs';

const options = signal => ({ origin: 'http://127.0.0.1:12345', email: 'reviewer@example.test', signal, timeoutMs: 1000 });

test('a request completed after cancellation cannot open an outbox reader', async () => {
  const controller = new AbortController();
  let release, receivedSignal, opened = false;
  const requested = new Promise(resolve => { release = resolve; });
  const page = { context: () => ({ newPage: async () => { opened = true; } }) };
  const signingIn = signInThroughOutbox(page, { ...options(controller.signal), request: (_, signal) => { receivedSignal = signal; return requested; } });
  await delay(0);
  const cancelledAt = performance.now();
  controller.abort();
  await assert.rejects(signingIn, /requesting the sign-in message/);
  assert.ok(performance.now() - cancelledAt < 500, 'cancellation does not wait for the deadline');
  assert.equal(receivedSignal, controller.signal);
  release();
  await delay(20);
  assert.equal(opened, false);
});

test('an outbox reader created after cancellation is closed without navigation', async () => {
  const controller = new AbortController();
  let release, opening, closed = false, navigated = false;
  const opened = new Promise(resolve => { opening = resolve; });
  const page = { context: () => ({ newPage: () => { opening(); return new Promise(resolve => { release = resolve; }); } }) };
  const signingIn = signInThroughOutbox(page, { ...options(controller.signal), request: async () => {} });
  await opened;
  const cancelledAt = performance.now();
  controller.abort();
  await assert.rejects(signingIn, /opening the outbox reader/);
  assert.ok(performance.now() - cancelledAt < 500, 'cancellation does not wait for the deadline');
  release({ close: async () => { closed = true; }, goto: async () => { navigated = true; } });
  await delay(20);
  assert.equal(closed, true);
  assert.equal(navigated, false);
});
