import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { journey, loadDependencies, ReviewError } from '../index.mjs';
import { consumer, temporary } from './helpers.mjs';

const html = script => `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Browser review</title></head><body><main><h1>Browser review</h1><a href="/">Home</a></main><script>${script}</script></body></html>`;
async function server(t, handler) {
  const sockets = new Set();
  const server = createServer(handler);
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', error => { if (error.code !== 'ECONNRESET') throw error; });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}
function upgrade(socket, req) {
  const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const text = Buffer.from('Real local server');
  socket.write(Buffer.concat([Buffer.from([0x81, text.length]), text]));
  socket.on('data', data => { if ((data[0] & 0x0f) === 8) socket.end(Buffer.from([0x88, 0])); });
}
async function review(options) {
  try { return (await journey({ cwd: consumer, ...options })).report; }
  catch (error) { if (error instanceof ReviewError) return error.report; throw error; }
}
async function verifyFiles(evidence, report) {
  assert.deepEqual(JSON.parse(await readFile(join(evidence, 'review.json'), 'utf8')), report);
  for (const entry of report.captures) {
    assert.equal(entry.imageRetention.kept, entry.images.length > 0);
    for (const image of entry.images) assert.equal((await readFile(join(evidence, image.file))).length, image.bytes);
  }
}

test('foreign WebSockets close before zero server handshakes; local sockets reach the real server', async t => {
  let foreignHandshakes = 0, localHandshakes = 0;
  const foreign = await server(t, (_req, res) => res.end('foreign'));
  foreign.server.on('upgrade', (req, socket) => { foreignHandshakes++; upgrade(socket, req); });
  const local = await server(t, (_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(html(`window.foreignDone=false; window.localMessage='';
const foreign=new WebSocket(${JSON.stringify(foreign.origin.replace('http:', 'ws:') + '/socket?token=synthetic-socket-secret')});
foreign.onopen=()=>window.foreignDone=true; foreign.onclose=()=>window.foreignDone=true;
const local=new WebSocket(location.origin.replace('http:','ws:')+'/socket');
local.onmessage=event=>window.localMessage=event.data;`));
  });
  local.server.on('upgrade', (req, socket) => { localHandshakes++; upgrade(socket, req); });
  const evidence = await temporary(t);
  const report = await review({ origin: local.origin, evidence, async run({ page, capture }) {
    await page.goto('/'); // Both sockets start inside the first navigation.
    await page.waitForFunction(() => window.foreignDone && window.localMessage === 'Real local server');
    await capture('socket policy', { continueOnFailure: true });
  } });
  assert.equal(foreignHandshakes, 0);
  assert.equal(localHandshakes, 2);
  assert.equal(report.passed, false);
  assert.deepEqual(report.errors, []);
  assert.equal(report.captures.length, 2);
  for (const entry of report.captures) {
    assert.deepEqual(entry.gate.failures, ['externalRequests']);
    assert.deepEqual(entry.externalRequests, [foreign.origin.replace('http:', 'ws:') + '/socket']);
  }
  await verifyFiles(evidence, report);
});

test('colliding slugs cannot overwrite a reported screenshot, including repeated widths', async t => {
  const local = await server(t, (_req, res) => { res.setHeader('content-type', 'text/html'); res.end(html('')); });
  const directory = await temporary(t);
  for (const repeatWidth of [false, true]) {
    const evidence = join(directory, repeatWidth ? 'contexts' : 'page');
    let step = 0;
    const report = await review({ origin: local.origin, evidence, widths: repeatWidth ? [390, 390] : [390], async run({ page, capture }) {
      await page.goto('/');
      if (!repeatWidth || step++ === 0) await capture('same name', { canonical: true });
      if (!repeatWidth || step === 2) {
        await page.evaluate(() => { document.body.style.background = 'pink'; });
        await capture('same-name', { canonical: true });
      }
    } });
    assert.equal(report.passed, false);
    assert.deepEqual(report.errors, ['Duplicate capture state: 390-same-name']);
    assert.equal(report.captures.length, 1);
    assert.equal(report.captures[0].gate.passed, true);
    await verifyFiles(evidence, report);
  }
});

test('a run launches one real browser and closes separate contexts for every width', async t => {
  const local = await server(t, (_req, res) => { res.setHeader('content-type', 'text/html'); res.end(html('')); });
  const evidence = await temporary(t);
  const { chromium } = loadDependencies(consumer);
  const launch = chromium.launch;
  let launches = 0, browser;
  const contexts = [], closed = [];
  chromium.launch = function (...args) { launches++; return launch.apply(this, args); };
  try {
    const report = await review({ origin: local.origin, evidence, widths: [1440, 390, 800], async run({ page, context, width, capture }) {
      if (browser) assert.equal(context.browser(), browser);
      browser = context.browser();
      assert.equal(contexts.includes(context), false);
      contexts.push(context);
      context.once('close', () => closed.push(context));
      assert.deepEqual(await context.cookies(), []);
      await context.addCookies([{ name: 'width', value: String(width), url: local.origin }]);
      await page.goto('/');
      await capture('clean');
    } });
    assert.equal(report.passed, true);
    assert.equal(launches, 1);
    assert.equal(contexts.length, 3);
    assert.deepEqual(closed, contexts);
    assert.equal(browser.isConnected(), false);
    await verifyFiles(evidence, report);
  } finally { chromium.launch = launch; }
});
