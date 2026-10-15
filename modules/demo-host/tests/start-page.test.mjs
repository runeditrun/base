import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ORIGIN, front } from './front.mjs';

// The start page in a real browser against the front Worker in workerd. The
// browser's requests to the demo's origin go to the Worker; Turnstile's script
// (the network edge) is a stand-in that passes its check when the test lets it.
const { chromium } = createRequire(new URL('../../../default-seed/package.json', import.meta.url))('@playwright/test');

const TURNSTILE = `(() => {
  const render = box => {
    const input = box.querySelector('input') ?? box.appendChild(Object.assign(document.createElement('input'), { type: 'hidden', name: 'cf-turnstile-response' }));
    input.value = '';
    setTimeout(() => { input.value = 'passed'; window[box.dataset.callback](input.value); }, 100);
  };
  window.turnstile = { reset: box => { window.resets = (window.resets ?? 0) + 1; render(box); } };
  const all = () => document.querySelectorAll('.cf-turnstile').forEach(render);
  document.readyState === 'loading' ? addEventListener('DOMContentLoaded', all) : all();
})()`;

test('the start page waits for the check, shows its start working, says when it fails, and Try again starts a new one', async () => {
  let mode = 'wait', dropNextStart = false, releaseCheck;
  const checked = new Promise(resolve => { releaseCheck = resolve; });
  const { mf, fetch, demos } = await front({ max: 1, startMs: 20_000, probeMs: 200,
    health: () => mode === 'ok' ? Response.json({ ok: true }) : new Response(null, { status: mode === 'exit' ? 599 : 503 }) });
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.route('https://challenges.cloudflare.com/**', async route => { await checked; await route.fulfill({ contentType: 'text/javascript', body: TURNSTILE }); });
    await context.route(`${ORIGIN}/**`, async route => {
      const request = route.request();
      if (request.method() === 'POST' && dropNextStart) { dropNextStart = false; return route.abort('connectionreset'); }
      const response = await fetch(new URL(request.url()).pathname, { method: request.method(), headers: { ...await request.allHeaders(), 'cf-connecting-ip': '203.0.113.1' }, body: request.postDataBuffer() ?? undefined });
      const headers = Object.fromEntries([...response.headers].filter(([name]) => name !== 'set-cookie'));
      if (response.headers.getSetCookie().length) headers['set-cookie'] = response.headers.getSetCookie().join('\n');
      await route.fulfill({ status: response.status, headers, body: Buffer.from(await response.arrayBuffer()) });
    });
    const page = await context.newPage();
    await page.clock.install();
    const form = page.locator('#start'), button = page.locator('#start .button'), notice = page.locator('#notice');
    const state = async expected => { await page.waitForFunction(value => document.getElementById('start').dataset.state === value, expected); };
    await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' });

    // Before the check passes the button waits, and says so.
    await state('waiting');
    assert.equal(await button.isDisabled(), true);
    assert.ok((await button.textContent()).trim());

    // The check passes and the start cannot reach the host: the page says so and offers Try again.
    dropNextStart = true;
    releaseCheck();
    await state('failed');
    assert.equal(await notice.isVisible(), true);
    assert.equal(await button.isEnabled(), true);

    // Try again runs a new check; the container exits during startup and the page says so.
    mode = 'exit';
    await button.click();
    await state('failed');
    assert.equal(await page.evaluate(() => window.resets), 1);
    assert.equal(await notice.isVisible(), true);

    // Try again once more: while the container starts, the page shows it working.
    mode = 'wait';
    const pendingStart = page.waitForResponse(response => response.url() === ORIGIN + '/__demo/start' && response.status() === 202);
    await button.click();
    await pendingStart;
    await state('working');
    assert.equal(await button.isDisabled(), true);
    assert.equal(await page.locator('#start .spinner').isVisible(), true);
    assert.equal(await page.locator('#start .steps').isVisible(), true);
    assert.equal(await notice.isVisible(), false);
    assert.ok((await page.locator('#status').textContent()).trim(), 'screen readers hear the step');
    assert.equal(await form.getAttribute('data-state'), 'working');

    // A slow start is explicitly abandoned, and its only capacity place is
    // free before the next human check admits the replacement.
    const prior = [...demos.values()].at(-1);
    await page.clock.fastForward(26000);
    await state('slow');
    const replacementStart = page.waitForResponse(response => response.url() === ORIGIN + '/__demo/start' && response.status() === 202);
    await button.click();
    await replacementStart;
    await page.waitForFunction(() => window.resets === 3);
    assert.equal(prior.destroyed, true);
    await state('working');
    // It comes up: the visitor lands in their signed-in demo.
    mode = 'ok';
    await page.waitForURL(`${ORIGIN}/app`);
    assert.match(await page.textContent('body'), /^[0-9a-f]{64} \/app$/);
  } finally { await browser.close(); await mf.dispose(); }
});
