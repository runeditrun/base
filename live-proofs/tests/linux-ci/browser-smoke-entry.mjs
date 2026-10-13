import fs from 'node:fs';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { chromium } from '/opt/browser/node_modules/playwright/index.mjs';
assert.equal(process.getuid(), 10001); assert.equal(process.getgid(), 10001);
const widget = fs.readFileSync('/artifact/dist/client/widget.js'), pageerrors = [], requests = [];
const pageHtml = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Local Chromium qualification</title><style>body{font:20px sans-serif;margin:24px}main{max-width:900px;background:#eef;padding:24px}button{padding:16px}</style><main><h1>Local browser check</h1><p>Actual built widget script loaded; hosted journey pending.</p><button id="counter">0</button></main><script src="/widget.js"></script><script>document.querySelector("button").onclick=e=>e.target.textContent=Number(e.target.textContent)+1</script>';
const server = http.createServer((req, res) => {
  requests.push(req.url);
  if (req.url === '/widget.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(widget); }
  else if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end(pageHtml); }
  else res.writeHead(404).end();
});
let browser;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true });
  const screenshots = [];
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } }); page.on('pageerror', e => pageerrors.push(e.message));
    await page.goto('http://127.0.0.1:' + server.address().port, { waitUntil: 'load' });
    assert.equal(await page.evaluate(() => typeof window.h2h), 'function');
    await page.locator('#counter').click(); assert.equal(await page.locator('#counter').textContent(), '1');
    screenshots.push({ width, jpg: (await page.screenshot({ type: 'jpeg', quality: 80, fullPage: true })).toString('base64') }); await page.close();
  }
  assert.deepEqual(pageerrors, []); assert.equal(requests.filter(x => x === '/widget.js').length, 2);
  console.log(JSON.stringify({ version: browser.version(), headless: true, uid: process.getuid(), gid: process.getgid(), pageerrors,
    widgetSha256: crypto.createHash('sha256').update(widget).digest('hex'), requests, screenshots, hostedJourney: 'pending' }));
} finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
