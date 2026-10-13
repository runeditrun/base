import assert from 'node:assert/strict';
import test from 'node:test';
import { waitForDeploymentHealth } from '../health.mjs';

function runtime(responses) {
  let elapsed = 0, calls = 0;
  const sleeps = [];
  return {
    options: {
      timeoutMs: 6_000,
      intervalMs: 2_000,
      now: () => elapsed,
      sleep: async (milliseconds) => { sleeps.push(milliseconds); elapsed += milliseconds; },
      fetchImpl: async (_url, options) => {
        assert.equal(options.redirect, 'manual');
        assert.ok(options.signal instanceof AbortSignal);
        const next = responses[Math.min(calls++, responses.length - 1)];
        if (next instanceof Error) throw next;
        return new Response('', { status: next });
      },
    },
    get calls() { return calls; },
    sleeps,
  };
}

test('immediate healthy response needs one read and no wait', async () => {
  const probe = runtime([200]);
  assert.equal((await waitForDeploymentHealth('https://example.test/health', probe.options)).status, 200);
  assert.equal(probe.calls, 1); assert.deepEqual(probe.sleeps, []);
});

test('observed route and binding propagation can settle before the deadline', async () => {
  const probe = runtime([404, 503, 200]);
  assert.equal((await waitForDeploymentHealth('https://example.test/health', probe.options)).status, 200);
  assert.equal(probe.calls, 3); assert.deepEqual(probe.sleeps, [2_000, 2_000]);
});

test('network failure is retried only within the same bounded readiness window', async () => {
  const probe = runtime([new TypeError('test-only connection reset'), 200]);
  await waitForDeploymentHealth('https://example.test/health', probe.options);
  assert.equal(probe.calls, 2);
});

test('persistent transient failures fail accurately at the deadline', async () => {
  const probe = runtime([503]);
  await assert.rejects(waitForDeploymentHealth('https://example.test/health', probe.options), /within 6000ms; last result: HTTP 503/);
  assert.equal(probe.calls, 3); assert.deepEqual(probe.sleeps, [2_000, 2_000, 2_000]);
});

test('other HTTP failures and redirects are terminal, never accepted as healthy', async () => {
  for (const status of [401, 302, 500]) {
    const probe = runtime([status]);
    await assert.rejects(waitForDeploymentHealth('https://example.test/health', probe.options), new RegExp(`HTTP ${status}`));
    assert.equal(probe.calls, 1); assert.deepEqual(probe.sleeps, []);
  }
});
