import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserRuntime, chromium, DEV_KEY, OWNER } from './dev-gate-browser-runtime.mjs';

test('RER_OPEN enters as owner on initial load and same-path fragment navigation from the waiting gate', async () => {
  const r = await browserRuntime();
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ['--use-mock-keychain', '--password-store=basic'] });
    for (const waitingGate of [false, true]) {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        const requests = [];
        page.on('request', request => requests.push(request));
        if (waitingGate) {
          await page.goto(`${r.origin}/signin`);
          assert.equal(page.url(), `${r.origin}/__dev/key`);
          assert.deepEqual(await context.cookies(), []);
          assert.equal((await context.request.get(`${r.origin}/auth/session`)).status(), 401);
        }
        const exchanged = page.waitForResponse(response =>
          response.request().method() === 'POST' && new URL(response.url()).pathname === '/__dev/key');
        const entered = page.waitForResponse(response => new URL(response.url()).pathname === '/auth/dev/enter');
        await page.goto(`${r.origin}/__dev/key#rer-dev=${DEV_KEY}&as=owner`);
        const exchange = await exchanged;
        assert.equal(exchange.status(), 204);
        assert.deepEqual(exchange.request().postDataJSON(), { key: DEV_KEY });
        assert.equal((await exchange.request().allHeaders())['sec-fetch-site'], 'same-origin');
        assert.equal((await entered).status(), 303);
        await page.waitForURL(`${r.origin}/app`);
        assert.equal(new URL(page.url()).hash, '');
        const session = await context.request.get(`${r.origin}/auth/session`);
        assert.equal(session.status(), 200);
        const identity = await session.json();
        assert.equal(identity.operator.email, OWNER);
        assert.equal(identity.kind, 'dev');
        const cookies = await context.cookies();
        const gate = cookies.find(cookie => cookie.name.startsWith('rer_dev_gate_'));
        assert.ok(gate);
        assert.equal(gate.httpOnly, true);
        assert.equal(gate.sameSite, 'Strict');
        const gateGets = requests.filter(request => request.method() === 'GET' && new URL(request.url()).pathname === '/__dev/key');
        assert.equal(gateGets.length, 1, 'same-path navigation must work without reloading the waiting document');
        for (const request of requests) {
          assert.ok(!request.url().includes(DEV_KEY), 'the key stays out of HTTP URLs');
          assert.ok(!(await request.allHeaders()).referer?.includes(DEV_KEY), 'the key stays out of Referer');
        }
      } finally { await context.close(); }
    }
  } finally { await browser?.close(); await r.close(); }
});

test('the hand-off page shows the seed\'s own logo, and its product name as text when the seed declares none', async () => {
  const cases = [
    { branding: { productName: 'Gate Test', theme: '/rer-theme.css' }, logo: true },
    { branding: { productName: 'Gate Test', theme: '/no-logo-theme.css' }, logo: false },
  ];
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ['--use-mock-keychain', '--password-store=basic'] });
    for (const { branding, logo } of cases) {
      const r = await browserRuntime(branding);
      try {
        const page = await (await browser.newContext()).newPage();
        await page.goto(`${r.origin}/__dev/key`);
        const brand = page.locator('.brand');
        assert.match(await brand.textContent(), /Gate Test/);
        if (logo) {
          const image = brand.locator('img');
          await image.waitFor();
          assert.equal(await image.getAttribute('alt'), 'Gate Test');
          assert.equal(new URL(await image.getAttribute('src'), r.origin).pathname, '/brand/mark.svg');
          assert.equal(await image.evaluate(img => img.complete && img.naturalWidth > 0), true, 'the mark loads under the page\'s own policy');
        } else {
          assert.equal(await brand.locator('img').count(), 0);
          assert.equal(await brand.locator('span').getAttribute('aria-hidden'), null, 'the name is the only mark, so readers keep it');
        }
      } finally { await r.close(); }
    }
  } finally { await browser?.close(); }
});
