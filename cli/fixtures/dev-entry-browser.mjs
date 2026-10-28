import assert from 'node:assert/strict';
import { join } from 'node:path';
import { chromium } from './reference.mjs';

// Walk the real seed from a waiting key gate to its signed-in owner screen.
export async function devEntryBrowser(ready) {
 const browser = await chromium.launch({ headless: true, executablePath: process.env.RER_TEST_CHROMIUM, args: ['--no-sandbox'] });
 const evidence = process.env.RER_TEST_EVIDENCE_DIRECTORY;
 try {
  for (const width of [1440, 390]) {
   const context = await browser.newContext({ viewport: { width, height: 900 } });
   try {
    const page = await context.newPage();
    let gateDocuments = 0;
    page.on('request', request => { if (request.isNavigationRequest() && new URL(request.url()).pathname === '/__dev/key') gateDocuments++; });
    await page.goto(ready.url + '/signin');
    assert.equal(page.url(), ready.url + '/__dev/key');
    if (evidence) await page.screenshot({ path: join(evidence, `waiting-gate-${width}.png`), fullPage: true });
    await page.goto(ready.openUrl);
    await page.waitForURL(url => ['/setup', '/app'].includes(url.pathname));
    assert.equal(gateDocuments, 1, 'owner entry completes without reloading the waiting gate');
    const session = await (await context.request.get(ready.url + '/auth/session')).json();
    assert.equal(session.operator.email, 'migration-owner@example.test');
    assert.equal(session.kind, 'dev');
    if (new URL(page.url()).pathname === '/setup') {
     await page.getByRole('checkbox').check();
     await page.getByRole('button', { name: 'Finish setup', exact: true }).click();
     await page.waitForURL(ready.url + '/app');
    }
    assert.equal(new URL(page.url()).hash, '');
    if (evidence) await page.screenshot({ path: join(evidence, `owner-app-${width}.png`), fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'owner screen fits the viewport');
   } finally { await context.close(); }
  }
 } finally { await browser.close(); }
}
