import { createServer } from 'node:http';
import { appendFile, readFile } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';
import { devGate } from '../../modules/operator-auth/dev-gate.mjs';

const [port, origin, key, control, observations] = process.argv.slice(2);
const gate = devGate({ key, origin, local: true });
let destinationStarted;
const server = createServer(async (req, res) => {
 const path = new URL(req.url, origin).pathname, config = JSON.parse(await readFile(control, 'utf8'));
 const body = ['POST', 'PUT'].includes(req.method) ? await new Response(req).text() : undefined;
 const request = new Request(origin + req.url, { method: req.method, headers: req.headers, ...(body ? { body } : {}) });
 let response;
 if (path === '/health') response = Response.json({ status: 'ok' });
 else if (path === '/mounted') { await appendFile(observations, JSON.stringify({ at: Date.now(), busy: false, mounted: true }) + '\n'); response = new Response(null, { status: 204 }); }
 else if (path === '/__dev/personas' && await gate.admits(request)) response = Response.json([{ as: 'owner', email: 'owner@example.test' }]);
 else if (path === '/__dev/key') response = await gate.exchange(request);
 else if (path === '/auth/dev/enter' && await gate.admits(request)) response = new Response(null, { status: 303, headers: { location: '/workspace/owner-entry', 'set-cookie': 'synthetic_owner=active; Path=/; HttpOnly' } });
 else if (path === '/workspace/owner-entry') response = new Response(null, { status: 302, headers: { location: '/workspace/start-here' } });
 else if (path === '/workspace/start-here' && await gate.admits(request) && req.headers.cookie?.includes('synthetic_owner=active')) {
  destinationStarted ??= Date.now();
  const busy = config.busyForever || Date.now() - destinationStarted < config.busyMs;
  await appendFile(observations, JSON.stringify({ at: Date.now(), busy }) + '\n');
  if (config.hang) { res.writeHead(200, { 'content-type': 'text/html' }); res.write('<html>'); return; }
  // Leave a readable refresh document between navigations. The next response
  // is delayed so the readiness deadline can also interrupt an in-flight read.
  if (config.refresh) await pause(250);
  const setup = '<main><h1>Setup</h1><form><label>Workspace name <input value="Synthetic workspace"></label><button>Continue</button></form></main>';
  // Foundation's signed-in /app is a rendered, read-only heading and paragraph.
  const owner = config.readOnly ? '<main><h1>Synthetic workspace</h1><p>Signed in as Synthetic owner</p></main>' : setup;
  const content = config.empty ? '<main></main>' : config.clientMs ? `<main><h1>Owner setup</h1><p role="status">Loading your name…</p></main><script>setTimeout(async()=>{document.body.innerHTML=${JSON.stringify(owner)};await fetch('/mounted')},${config.clientMs})</script>` : owner;
  response = new Response(busy ? '<!doctype html><html><body><h1>The workspace is busy. Trying again in a few seconds</h1></body></html>' : '<!doctype html><html><head>' + (config.refresh ? '<meta http-equiv="refresh" content="3600">' : '') + '</head><body>' + content + '<script>const recoveryText="The workspace is busy. Trying again in a few seconds";</script></body></html>', { status: busy ? config.status ?? 503 : config.destinationStatus ?? 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
 } else if (path === '/rer-warmup') {
  // The app's first document render: slow once, as an on-demand module graph is.
  await pause(config.renderMs ?? 0);
  await appendFile(observations, JSON.stringify({ at: Date.now(), render: 'done' }) + '\n');
  response = new Response('Not found', { status: 404 });
 } else response = new Response('Not found', { status: 404 });
 res.writeHead(response.status, { ...Object.fromEntries(response.headers), ...(response.headers.getSetCookie().length ? { 'set-cookie': response.headers.getSetCookie() } : {}) });
 res.end(Buffer.from(await response.arrayBuffer()));
});
server.listen(Number(port), '127.0.0.1');
