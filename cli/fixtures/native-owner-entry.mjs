import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from './reference.mjs';

export async function nativeOwnerBrowser(f, mode, ready, email) {
 const browser = await chromium.launch({ headless: true, executablePath: process.env.RER_TEST_CHROMIUM, args: ['--no-sandbox'] });
 const keys = [];
 try {
  if (mode === 'demo') {
   const persona = await browser.newContext();
   try {
    const page = await persona.newPage(); await page.goto(ready.openUrl);
    await page.waitForURL(url => url.pathname !== '/__dev/key');
    const session = await (await persona.request.get(ready.url + '/auth/session')).json();
    assert.equal(session.kind, 'dev', 'demo keeps its existing persona');
    assert.equal(session.operator.email, email);
   } finally { await persona.close(); }
  }
  for (const width of [1440, 390]) {
   const row = width === 1440 ? ready : JSON.parse((await f.run([mode, '--json'])).stdoutText.split('\n').find(line => line.includes('"event":"ready"')));
   assert.ok(row.ownerOpenUrl, 'native owner link is announced alongside readiness');
   const key = new URLSearchParams(new URL(row.ownerOpenUrl).hash.slice(1)).get('rer-dev'); keys.push(key);
   const context = await browser.newContext({ viewport: { width, height: 900 } });
   try {
    const request = context.request;
    const wrongOrigin = await request.post(row.url + '/__dev/key', { headers: { Origin: 'https://synthetic-base-1.invalid' }, data: { key } });
    assert.equal(wrongOrigin.status(), 403, 'foreign origin cannot redeem the link');
    const wrongHost = await request.post(row.url + '/__dev/key', { headers: { Host: 'synthetic-base-1.invalid', Origin: row.url }, data: { key } });
    assert.equal(wrongHost.status(), 421, 'non-loopback host cannot redeem the link');
    const bypass = await request.post(row.url + '/auth/owner-signin', { headers: { Origin: row.url }, data: { token: key } });
    assert.equal(bypass.status(), 400, 'public entry credential cannot bypass its run-owned gate');
    const page = await context.newPage();
    await page.goto(row.ownerOpenUrl);
    await page.waitForURL(url => url.pathname !== '/__dev/key');
    const response = await request.get(row.url + '/auth/session');
    assert.equal(response.status(), 200);
    const session = await response.json();
    assert.equal(session.operator.email, email);
    assert.equal(session.operator.role, 'owner');
    assert.equal(session.kind, 'native');
    assert.equal(new URL(page.url()).hash, '', 'entry removes its credential fragment');
    const replay = await request.post(row.url + '/__dev/key', { headers: { Origin: row.url }, data: { key } });
    assert.equal(replay.status(), 403, 'native entry is single use');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    if (process.env.RER_TEST_EVIDENCE_DIRECTORY) await page.screenshot({ path: join(process.env.RER_TEST_EVIDENCE_DIRECTORY, `${mode}-native-owner-${width}.png`), fullPage: true });
   } finally { await context.close(); }
  }
  async function scan(path) {
   for (const entry of await readdir(path, { withFileTypes: true })) {
    if (['node_modules', '.git'].includes(entry.name)) continue;
    const file = join(path, entry.name);
    if (entry.isDirectory()) await scan(file);
    else if (entry.isFile()) { const bytes = await readFile(file); for (const key of keys) assert.ok(!bytes.includes(key), 'entry credential is absent from generated files and logs'); }
   }
  }
  await scan(f.root);
 } finally { await browser.close(); }
}
