import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { journey, signInThroughOutbox } from '../index.mjs';
import { consumer, fixture, requestSignIn } from './helpers.mjs';

async function mail(origin, input) {
  assert.equal((await fetch(origin + '/__fixtures/mail', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })).status, 200);
}
test('outbox selects the newest matching recipient after the request, skipping stale and foreign mail', async t => {
  const runtime = await fixture(t);
  await journey({ cwd: consumer, origin: runtime.origin, evidence: runtime.evidence, async run({ page }) {
    await mail(runtime.origin, { email: 'reviewer@example.test', link: runtime.origin + '/clean?choice=stale', createdAt: Date.now() - 5000 });
    await page.goto('/signin');
    await signInThroughOutbox(page, { origin: runtime.origin, email: 'reviewer@example.test', request: async page => {
      await requestSignIn(page);
      await mail(runtime.origin, { email: 'reviewer@example.test', link: runtime.origin + '/clean?choice=older', createdAt: Date.now() });
      await mail(runtime.origin, { email: 'Reviewer <reviewer@example.test>', link: runtime.origin + '/clean?choice=newest', createdAt: Date.now() + 1 });
      await mail(runtime.origin, { email: 'another@example.test', link: runtime.origin + '/clean?choice=wrong', createdAt: Date.now() + 100 });
    } });
    assert.equal(new URL(page.url()).searchParams.get('choice'), 'newest');
  } });
});
test('missing outbox message fails inside the bound without leaking a link', async t => {
  const runtime = await fixture(t);
  await journey({ cwd: consumer, origin: runtime.origin, evidence: runtime.evidence, widths: [390], async run({ page }) {
    await page.goto('/signin');
    const started = performance.now();
    await assert.rejects(signInThroughOutbox(page, { origin: runtime.origin, email: 'missing@example.test', timeoutMs: 800, request: page => requestSignIn(page, 'missing@example.test') }), /waiting for a new outbox message.*bound 800ms/);
    assert.ok(performance.now() - started < 2500);
  } });
  assert.equal((await readFile(join(runtime.evidence, 'review.json'), 'utf8')).includes('token='), false);
});
test('a stale message for the requested email cannot satisfy a new request', async t => {
  const runtime = await fixture(t);
  await mail(runtime.origin, { email: 'reviewer@example.test', link: runtime.origin + '/clean?choice=stale', createdAt: Date.now() - 5000 });
  await journey({ cwd: consumer, origin: runtime.origin, evidence: runtime.evidence, widths: [390], async run({ page }) {
    await page.goto('/signin');
    await assert.rejects(signInThroughOutbox(page, { origin: runtime.origin, email: 'reviewer@example.test', timeoutMs: 400, request: async () => {} }), /waiting for a new outbox message/);
  } });
});
test('foreign sign-in targets are refused and Playwright request diagnostics cannot expose links', async t => {
  const runtime = await fixture(t);
  await journey({ cwd: consumer, origin: runtime.origin, evidence: runtime.evidence, widths: [390], async run({ page }) {
    await page.goto('/signin');
    await assert.rejects(signInThroughOutbox(page, { origin: runtime.origin, email: 'reviewer@example.test', request: async () => {
      await mail(runtime.origin, { email: 'reviewer@example.test', link: 'http://127.0.0.1:1/auth/confirm?token=synthetic-private-link' });
    } }), error => /checking the sign-in link origin/.test(error.message) && !error.message.includes('synthetic-private-link'));
    await assert.rejects(signInThroughOutbox(page, { origin: runtime.origin, email: 'reviewer@example.test', request: async () => { throw new Error('private http://local.test/?token=synthetic-private-link'); } }), error => /requesting the sign-in message/.test(error.message) && !error.message.includes('synthetic-private-link'));
  } });
});
test('request itself is bounded and outbox paths must be same-origin', async t => {
  const runtime = await fixture(t);
  await journey({ cwd: consumer, origin: runtime.origin, evidence: runtime.evidence, widths: [390], async run({ page }) {
    await assert.rejects(signInThroughOutbox(page, { origin: runtime.origin, email: 'reviewer@example.test', request: () => new Promise(() => {}), timeoutMs: 100 }), /requesting.*bound 100ms/);
    await assert.rejects(signInThroughOutbox(page, { origin: runtime.origin, email: 'reviewer@example.test', request: requestSignIn, outboxPath: 'https://foreign.test/' }), /same-origin/);
  } });
});

const never = () => new Promise(() => {});
const emptyReader = () => ({ goto: async () => {}, locator: () => ({ evaluateAll: async () => [] }), close: async () => {} });
const boundedOptions = request => ({ origin: 'http://127.0.0.1:12345', email: 'reviewer@example.test', request, timeoutMs: 50 });

test('sign-in work bounds the request before opening a reader', { timeout: 1500 }, async () => {
  let opened = false;
  const page = { context: () => ({ newPage: async () => { opened = true; return emptyReader(); } }) };
  const started = performance.now();
  await assert.rejects(signInThroughOutbox(page, boundedOptions(never)), /requesting.*bound 50ms/);
  assert.equal(opened, false);
  assert.ok(performance.now() - started < 1000);
});
test('sign-in work bounds a reader creation that never resolves', { timeout: 1500 }, async () => {
  const page = { context: () => ({ newPage: never }) };
  const started = performance.now();
  await assert.rejects(signInThroughOutbox(page, boundedOptions(async () => {})), /opening the outbox reader.*bound 50ms/);
  assert.ok(performance.now() - started < 1000);
});
test('sign-in work bounds reader inspection and closes the reader', { timeout: 1500 }, async () => {
  let closed = false;
  const reader = { ...emptyReader(), locator: () => ({ evaluateAll: never }), close: async () => { closed = true; } };
  const page = { context: () => ({ newPage: async () => reader }) };
  const started = performance.now();
  await assert.rejects(signInThroughOutbox(page, boundedOptions(async () => {})), /waiting for a new outbox message.*bound 50ms/);
  assert.equal(closed, true);
  assert.ok(performance.now() - started < 1000);
});
test('reader cleanup that never resolves fails within its own bound', { timeout: 3000 }, async () => {
  let closeCalled = false;
  const reader = { ...emptyReader(), close: () => { closeCalled = true; return never(); } };
  const page = { context: () => ({ newPage: async () => reader }) };
  const started = performance.now();
  await assert.rejects(signInThroughOutbox(page, boundedOptions(async () => {})), /Outbox reader cleanup failed.*bound 50ms/);
  assert.equal(closeCalled, true);
  assert.ok(performance.now() - started < 2500);
});
test('a late request cannot create a reader after the deadline', { timeout: 1500 }, async () => {
  let release, opened = false;
  const page = { context: () => ({ newPage: async () => { opened = true; return emptyReader(); } }) };
  await assert.rejects(signInThroughOutbox(page, boundedOptions(() => new Promise(resolve => { release = resolve; }))), /requesting.*bound 50ms/);
  release();
  await delay(20);
  assert.equal(opened, false);
});
test('a reader created after the deadline is still closed', { timeout: 1500 }, async () => {
  let release, closed = false;
  const page = { context: () => ({ newPage: () => new Promise(resolve => { release = resolve; }) }) };
  await assert.rejects(signInThroughOutbox(page, boundedOptions(async () => {})), /opening.*bound 50ms/);
  release({ ...emptyReader(), close: async () => { closed = true; } });
  await delay(20);
  assert.equal(closed, true);
});
test('late reader inspection cannot navigate the original page', { timeout: 1500 }, async () => {
  let release, navigated = false;
  const reader = { ...emptyReader(), locator: () => ({ evaluateAll: () => new Promise(resolve => { release = resolve; }) }),
    getByRole: () => ({ getAttribute: async () => '/auth/confirm' }) };
  const page = { context: () => ({ newPage: async () => reader }), goto: async () => { navigated = true; } };
  await assert.rejects(signInThroughOutbox(page, boundedOptions(async () => {})), /waiting.*bound 50ms/);
  release([{ to: 'reviewer@example.test', received: Date.now() + 1, href: '/__dev/outbox/message' }]);
  await delay(20);
  assert.equal(navigated, false);
});
