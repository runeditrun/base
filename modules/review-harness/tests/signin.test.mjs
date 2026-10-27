import { namedSteps } from './fold-steps.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { signIn } from '../index.mjs';

const origin = 'http://127.0.0.1:12345';

test("sign-in honours callback results, URL confinement and cancellation", async t => {
  const step = namedSteps(t);
  await step('opens a seed-provided URL or completes the seed browser callback', async () => {
    const visits = [];
    const page = { goto: async url => { visits.push(url); } };
    await signIn(page, { origin, open: '/auth/oneclick' });
    await signIn(page, { origin, open: async () => new URL('/auth/oneclick?persona=reviewer', origin) });
    await signIn(page, { origin, open: async (page, signal) => {
      signal.throwIfAborted();
      await page.goto(origin + '/app');
    } });
    assert.deepEqual(visits, [origin + '/auth/oneclick', origin + '/auth/oneclick?persona=reviewer', origin + '/app']);
  });

  await step('refuses foreign or credential-bearing URLs and omits private callback errors', async () => {
    let navigated = false;
    const page = { goto: async () => { navigated = true; } };
    for (const open of ['https://foreign.test/?token=private-test-link', 'http://user:password@127.0.0.1:12345/auth/oneclick', async () => { throw new Error('private-test-link'); }]) {
      await assert.rejects(signIn(page, { origin, open }), error => /Sign-in failed/.test(error.message) && !error.message.includes('private-test-link') && !error.message.includes('password'));
    }
    assert.equal(navigated, false);
  });

  await step('bounds a pending callback and ignores its late URL', async () => {
    let release, hookSignal, navigated = false;
    const page = { goto: async () => { navigated = true; } };
    await assert.rejects(signIn(page, { origin, timeoutMs: 30, open: (_, signal) => {
      hookSignal = signal;
      return new Promise(resolve => { release = resolve; });
    } }), /Sign-in failed/);
    assert.equal(hookSignal.aborted, true);
    release('/auth/oneclick');
    await delay(0);
    assert.equal(navigated, false);
  });

  await step('cancellation interrupts a pending callback and prevents late navigation', async () => {
    const controller = new AbortController();
    let release, hookSignal, navigated = false;
    const signingIn = signIn({ goto: async () => { navigated = true; } }, { origin, signal: controller.signal, open: (_, signal) => {
      hookSignal = signal;
      return new Promise(resolve => { release = resolve; });
    } });
    await delay(0);
    controller.abort();
    await assert.rejects(signingIn, /Sign-in failed/);
    assert.equal(hookSignal.aborted, true);
    release('/auth/oneclick');
    await delay(0);
    assert.equal(navigated, false);
  });

  await step('an already cancelled sign-in never starts the callback', async () => {
    let started = false;
    await assert.rejects(signIn({}, { origin, signal: AbortSignal.abort(), open: () => { started = true; } }), /Sign-in failed/);
    assert.equal(started, false);
  });
})
