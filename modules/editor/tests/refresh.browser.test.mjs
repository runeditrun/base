import { queuedEntrypoint } from '../../../onboarding/queued-entry.mjs';
const queued = await queuedEntrypoint(import.meta.url, 'verify:editor-browser');
if (queued !== null) process.exit(queued);
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { fixtureProvider } from './provider.mjs';
const { build } = await import(process.env.RER_ESBUILD_MODULE || 'esbuild');
const { chromium } = await import(process.env.RER_PLAYWRIGHT_MODULE || '@playwright/test');

test('an open editor survives an equivalent public API refresh and renews its expiry', async () => {
  const provider = await fixtureProvider();
  let browser, server;
  try {
    const bundle = await build({ stdin: {
      contents: `import {createOwnerEditor} from './src/index.ts';
        window.editor = createOwnerEditor();
        window.grant = () => ({config:{enabled:true,managementOrigin:${JSON.stringify(provider.origin)},installationId:'renewal_fixture'},expiresAt:Date.now()+30000});`,
      resolveDir: fileURLToPath(new URL('..', import.meta.url)),
    }, bundle: true, format: 'esm', write: false });
    server = createServer((request, response) => {
      response.setHeader('content-type', request.url === '/app.js' ? 'application/javascript' : 'text/html');
      response.end(request.url === '/app.js' ? bundle.outputFiles[0].text
        : '<!doctype html><html><body><main>Public API refresh fixture</main><script type="module" src="/app.js"></script></body></html>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    provider.state.allowed = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, ...(process.env.RER_BROWSER_CHANNEL ? { channel: process.env.RER_BROWSER_CHANNEL } : {}) });
    const page = await browser.newPage();
    await page.clock.install();
    await page.goto(provider.state.allowed);
    await page.waitForFunction(() => window.editor);
    await page.evaluate(async () => {
      editor.setOwner(true);
      await editor.refresh(async () => ({ ...grant(), expiresAt: Date.now() + 5000 }));
    });
    await page.getByRole('button', { name: 'Open Run Edit Run', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-rer-editor]')?.dataset.connection === 'connected');
    const frame = page.frames().find(frame => frame.url().startsWith(provider.origin));
    await frame.waitForLoadState('load');
    await page.waitForFunction(() => document.querySelector('[data-rer-editor]')?.dataset.connection === 'connected');
    await frame.evaluate(() => { window.draft = 'Unsent owner work'; });
    const session = await frame.evaluate(() => received.findLast(message => message.type === 'protocol-connected').sessionId);
    await page.evaluate(() => {
      window.host = document.querySelector('[data-rer-editor]');
      window.iframe = host.shadowRoot.querySelector('iframe');
      window.refreshResult = editor.refresh(() => new Promise(resolve => { window.completeRefresh = resolve; }));
    });
    // A pending loader preserves the open mount but cannot renew authority itself.
    const remainsOpen = () => page.evaluate(() => {
      const current = document.querySelector('[data-rer-editor]');
      return current === host && current.shadowRoot.querySelector('iframe') === iframe
        && !iframe.hidden && current.shadowRoot.querySelector('button').getAttribute('aria-expanded') === 'true';
    });
    assert.equal(await remainsOpen(), true);
    await page.clock.fastForward(1000);
    await page.evaluate(async () => {
      const renewed = grant();
      // Equivalent fresh objects and different key ordering must retain the mount.
      completeRefresh({ expiresAt: renewed.expiresAt, config: {
        installationId: renewed.config.installationId, managementOrigin: renewed.config.managementOrigin, enabled: true,
      } });
      await refreshResult;
    });
    await page.clock.fastForward(5000); // Past the original grant, within the new one.
    assert.equal(await remainsOpen(), true);
    assert.equal(await frame.evaluate(() => window.draft), 'Unsent owner work');
    assert.equal(await frame.evaluate(() => received.findLast(message => message.type === 'protocol-connected').sessionId), session);
    await page.clock.fastForward(30000);
    assert.equal(await page.locator('[data-rer-editor]').count(), 0, 'the renewed grant still expires');
  } finally {
    await browser?.close();
    if (server) await new Promise(resolve => server.close(resolve));
    await provider.close();
  }
});
