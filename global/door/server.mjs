// The front door process: node server.mjs, with RER_DOOR_DIR set. One process
// listens on 127.0.0.1:PORT (required) and [::1]:PORT (when IPv6 loopback
// exists), never a wildcard address, and routes by Host:
//   localhost, 127.0.0.1, [::1]      the index of sites (and the identity proof)
//   NAME.localhost and subdomains    that checkout, Host preserved (lowercased;
//                                    matching ignores letter case)
//   a trailing-dot Host              308 to the canonical Host
//   an unknown *.localhost           404 saying how to add a checkout
//   anything else                    400, never proxied (the DNS-rebinding guard)
// It never reads cookies (beyond making Domain=localhost Set-Cookie host-only,
// on HTTP and WebSocket handshake replies alike) and never holds a dev key.
import http from 'node:http';
import net from 'node:net';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { processInfo } from '../../modules/job-queue/processes.mjs';
import { changeDoorState, doorChallengeHeader, doorIdentityPath, doorProof, doorProtocol, doorSecretHeader, readDoorState, readPrivate, writePrivate } from '../../cli/door.mjs';
import { listeners, processName } from '../../onboarding/process-diagnostics.mjs';
import { ownManifest, ownRoot } from '../package-info.mjs';
import { confirmPage, failurePage, indexPage, startingPage, unknownPage } from './pages.mjs';
import { hostOnlyCookie, hostOnlyHead, splitHead } from './cookies.mjs';
import { readHost, startKind } from './routes.mjs';
import { doorSites } from './sites.mjs';

const say = line => process.stdout.write(`${new Date().toISOString()} ${line}\n`);
function fail(message, code = 4) { process.stderr.write(`rer door: ${message}\n`); process.exit(code); }

const state = await readDoorState(process.env);
if (!state?.door?.enabled) fail('The front door is not enabled. Run rer door enable.', 3);
const { door } = state, port = door.port, version = ownManifest().version;
const token = (await readPrivate(join(state.directory, 'token')))?.trim();
if (!token) fail(`The front door's token is missing from ${state.directory}. Run rer door enable.`, 3);
const sites = doorSites({ env: process.env, door, log: say });
const indexOrigins = new Set(['localhost', '127.0.0.1', '[::1]'].map(host => `http://${host}:${port}`));
const portOf = name => Number(/:(\d+)$/.exec(name)?.[1]);

async function holder() {
 const row = (await listeners()).find(item => item.pid !== process.pid && item.names.some(name => portOf(name) === port));
 return row && `PID ${row.pid} (${await processName(row.pid)})`;
}
const busy = who => `Port ${port} is held by ${who}. The front door needs 127.0.0.1:${port} and [::1]:${port} to itself. Stop that process, or enable the door on another port with rer door enable --port N.`;

// --- responses -------------------------------------------------------------
const send = (res, status, type, body, headers = {}) => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers }); res.end(body); };
const html = (res, status, body, headers) => send(res, status, 'text/html; charset=utf-8', body, headers);
const text = (res, status, body, headers) => send(res, status, 'text/plain; charset=utf-8', body + '\n', headers);
const json = (res, status, value) => send(res, status, 'application/json', JSON.stringify(value));

const publicView = view => ({ name: view.name, path: view.path, mode: view.mode, state: view.state, url: view.url, ...(view.proxyPort ? { proxyPort: view.proxyPort } : {}), ...(view.reason ? { reason: view.reason } : {}) });

async function index(req, res) {
 const path = new URL(req.url, 'http://door').pathname;
 if (path === doorIdentityPath) {
  const challenge = String(req.headers[doorChallengeHeader] ?? '');
  if (!/^[0-9a-f]{16,128}$/.test(challenge)) return json(res, 400, { error: 'challenge required' });
  const address = req.socket.localAddress?.replace(/^::ffff:/, '');
  return json(res, 200, { protocol: doorProtocol, pid: process.pid, proof: doorProof(token, challenge, address) });
 }
 if (path === '/__rer/door/status') return json(res, 200, { protocol: doorProtocol, pid: process.pid, port, version, sites: (await sites.views()).map(publicView) });
 if (path !== '/' || !['GET', 'HEAD'].includes(req.method)) return text(res, 404, 'Not found.');
 return html(res, 200, indexPage({ port, version, sites: await sites.views() }), { 'referrer-policy': 'origin' });
}

// `stale()` answers instead when the server has just stopped (the registry
// view is cached for a second): a refused connection before any byte was sent.
function proxy(req, res, view, host, stale) {
 const upstream = http.request({ host: '127.0.0.1', port: view.proxyPort, method: req.method, path: req.url, headers: { ...req.headers, host, [doorSecretHeader]: view.secret }, agent: false }, reply => {
  const raw = [];
  for (let i = 0; i < reply.rawHeaders.length; i += 2) raw.push(reply.rawHeaders[i], reply.rawHeaders[i].toLowerCase() === 'set-cookie' ? hostOnlyCookie(reply.rawHeaders[i + 1]) : reply.rawHeaders[i + 1]);
  res.writeHead(reply.statusCode, reply.statusMessage, raw);
  reply.pipe(res);
 });
 req.once('aborted', () => upstream.destroy());
 res.once('close', () => upstream.destroy());
 upstream.on('error', error => {
  sites.invalidate();
  if (res.headersSent) return res.destroy();
  if (error.code === 'ECONNREFUSED' && stale && ['GET', 'HEAD'].includes(req.method)) return stale();
  text(res, 502, `${view.name} stopped answering. Reload to start it again.`);
 });
 if (req.readableEnded) upstream.end(); else req.pipe(upstream);
}

async function site(req, res, target, retried = false) {
 const url = new URL(req.url, 'http://door'), registered = (await sites.list()).find(item => item.name === target.name);
 if (!registered) { req.resume(); return html(res, 404, unknownPage(target.name, port)); }
 // The door's own paths on a site host: its state (polled by the starting
 // page) and the same-origin Start button.
 if (url.pathname === '/__rer/door/state') {
  const view = await sites.view(registered, { force: true });
  return json(res, 200, { state: view.state, ...(view.reason ? { reason: view.reason } : {}), ...(view.state === 'running' && view.mode === 'direct' ? { redirect: view.url } : {}) });
 }
 if (url.pathname === '/__rer/door/start') {
  req.resume();
  const sameOrigin = req.headers.origin === `http://${target.host}` && ['same-origin', undefined].includes(req.headers['sec-fetch-site']);
  if (req.method !== 'POST' || !sameOrigin) return text(res, 403, 'Start a site from its own page.');
  sites.ensureStarted(registered);
  const to = url.searchParams.get('to');
  return send(res, 303, 'text/plain; charset=utf-8', '', { location: to?.startsWith('/') && !to.startsWith('//') ? to : '/' });
 }
 const view = await sites.view(registered, { force: retried });
 const kind = startKind(req, indexOrigins), here = url.pathname + url.search;
 if (view.state === 'running') {
  if (view.mode === 'door') return proxy(req, res, view, target.host, retried ? undefined : () => site(req, res, target, true).catch(() => { if (!res.headersSent) text(res, 502, 'The front door could not answer this request.'); }));
  // A direct-mode checkout (an old pin): send navigations to its own URL.
  req.resume();
  return kind === 'never' ? text(res, 404, `${view.name} is served directly at ${view.url}.`) : send(res, 302, 'text/plain; charset=utf-8', '', { location: view.url + here });
 }
 req.resume();
 if (kind === 'never') return text(res, 503, `${view.name} is not running. Open http://${target.host}/ in a browser to start it.`);
 if (view.state === 'failed') return html(res, 200, failurePage(view.name, view.reason, here));
 if (kind === 'confirm' && view.state !== 'starting') return html(res, 200, confirmPage(view.name, here));
 sites.ensureStarted(registered);
 return html(res, 503, startingPage(view.name), { 'retry-after': '2' });
}

const active = new Set(), upgraded = new Set();
async function handle(req, res) {
 active.add(res); res.once('close', () => active.delete(res));
 try {
  const target = readHost(req.headers.host, port);
  if (target.kind === 'redirect') { req.resume(); return send(res, 308, 'text/plain; charset=utf-8', '', { location: `http://${target.canonical}${req.url}` }); }
  if (target.kind === 'index') return await index(req, res);
  if (target.kind === 'site') return await site(req, res, target);
  req.resume();
  return text(res, 400, `This front door serves only localhost names on port ${port}.`);
 } catch (error) {
  say(`request failed: ${error.message}`);
  if (!res.headersSent) text(res, 500, 'The front door could not answer this request.'); else res.destroy();
 }
}

// WebSockets (Vite HMR among them) reach running door-mode sites only; an
// upgrade never starts a site, and one whose Origin is another site's is refused.
// An upgrade cannot follow a redirect, so a trailing-dot Host is read as its
// canonical Host; upstream always sees the canonical (lowercase) Host.
async function upgrade(req, socket, head) {
 const refuse = status => socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
 socket.on('error', () => socket.destroy());
 const read = readHost(req.headers.host, port);
 const target = read.kind === 'redirect' ? readHost(read.canonical, port) : read;
 if (target.kind !== 'site') return refuse('400 Bad Request');
 const registered = (await sites.list()).find(item => item.name === target.name);
 if (!registered) return refuse('404 Not Found');
 const origin = req.headers.origin;
 if (origin !== undefined && origin !== `http://${target.host}`) return refuse('403 Forbidden');
 const view = await sites.view(registered);
 if (view.state !== 'running' || view.mode !== 'door') return refuse('503 Service Unavailable');
 const upstream = net.connect(view.proxyPort, '127.0.0.1', () => {
  let lines = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
   const name = req.rawHeaders[i].toLowerCase();
   if (name !== doorSecretHeader) lines += `${req.rawHeaders[i]}: ${name === 'host' ? target.host : req.rawHeaders[i + 1]}\r\n`;
  }
  upstream.write(`${lines}${doorSecretHeader}: ${view.secret}\r\n\r\n`);
  if (head.length) upstream.write(head);
  socket.pipe(upstream);
  // The reply's head (101 or any other status) goes through the cookie rule;
  // the bytes after it pass unchanged.
  let reply = Buffer.alloc(0);
  const readHead = chunk => {
   reply = Buffer.concat([reply, chunk]);
   const split = splitHead(reply);
   if (!split) { if (reply.length > 65536) close(); return; }
   upstream.off('data', readHead);
   socket.write(hostOnlyHead(split.head));
   if (split.rest.length) socket.write(split.rest);
   upstream.pipe(socket);
  };
  upstream.on('data', readHead);
 });
 upgraded.add(socket);
 const close = () => { upgraded.delete(socket); socket.destroy(); upstream.destroy(); };
 upstream.on('error', close); upstream.on('close', close); socket.on('close', close);
}

// --- listening ---------------------------------------------------------------
const servers = [];
function listen(host) {
 const server = http.createServer(handle);
 server.on('upgrade', upgrade);
 server.on('clientError', (error, socket) => socket.destroy());
 return new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen({ host, port, exclusive: true, ...(host === '::1' ? { ipv6Only: true } : {}) }, () => { servers.push(server); resolve(server); });
 });
}

const before = await holder();
if (before) fail(busy(before));
try { await listen('127.0.0.1'); }
catch (error) { fail(error.code === 'EADDRINUSE' ? busy(await holder() ?? 'another process') : `Cannot listen on 127.0.0.1:${port}: ${error.code ?? error.message}.`); }
const addresses = ['127.0.0.1'];
try { await listen('::1'); addresses.push('::1'); }
catch (error) {
 // IPv6 loopback may not exist (a container, ipv6.disable=1); 127.0.0.1 alone serves then.
 if (!['EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes(error.code)) fail(error.code === 'EADDRINUSE' ? busy(await holder() ?? 'another process on [::1]') : `Cannot listen on [::1]:${port}: ${error.code ?? error.message}.`);
}
// Address families do not exclude each other: a wildcard listener elsewhere
// would still answer browsers that try [::1] first.
const after = await holder();
if (after) fail(busy(after));

const { start } = await processInfo(process.pid);
const record = { protocol: doorProtocol, pid: process.pid, start, port, addresses, version, versionDir: ownRoot, startedAt: new Date().toISOString() };
await writePrivate(join(state.directory, 'process.json'), JSON.stringify(record) + '\n');
say(`front door listening on ${addresses.map(address => address === '::1' ? `[::1]:${port}` : `${address}:${port}`).join(' and ')} (PID ${process.pid}, rer ${version})`);

// On SIGTERM: stop accepting and close WebSockets (open tabs reconnect through
// HMR). During a restart (`restarting` in the state) the starts under way are
// handed to the next door, and the process record is removed at once so that
// door can take the port while this one finishes its requests (up to 10 s).
// On a plain stop, starts under way get up to 25 s (inside rer door stop's 30)
// to record their servers as door-started.
let stopping = false;
async function release() {
 try { const current = JSON.parse(await readFile(join(state.directory, 'process.json'), 'utf8')); if (current.pid === process.pid) await rm(join(state.directory, 'process.json'), { force: true }); } catch {}
}
async function handOver() {
 try {
  return await changeDoorState(process.env, current => {
   if (!current.door?.restarting) return false;
   const names = sites.pending();
   if (names.length) current.door.handoff = [...new Set([...(current.door.handoff ?? []), ...names])];
   return true;
  });
 } catch (error) { say(`could not hand over the starts under way: ${error.message}`); return false; }
}
async function stop(signal) {
 if (stopping) return; stopping = true;
 say(`stopping (${signal})`);
 for (const server of servers) server.close();
 for (const socket of upgraded) socket.destroy();
 const restarting = await handOver();
 if (restarting) { say('handing over to the next door'); await release(); }
 for (const started = Date.now(); (active.size && Date.now() - started < 10000) || (!restarting && sites.busy() && Date.now() - started < 25000);) await delay(100);
 for (const server of servers) server.closeAllConnections();
 await release();
 process.exit(0);
}
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => void stop(signal));
process.on('SIGHUP', () => {});

// Starts the door this one replaced handed over (rer door restart or enable):
// each continues here, attaching to the launch already under way, so its tab
// on the starting page reloads into the site.
try {
 const handed = await changeDoorState(process.env, current => { const names = current.door?.handoff ?? []; if (current.door) delete current.door.handoff; return names; });
 const registered = await sites.list(true);
 for (const name of handed) {
  const site = registered.find(item => item.name === name);
  if (site) { say(`continuing the start of ${name} from the previous door`); sites.ensureStarted(site); }
 }
} catch (error) { say(`could not read the starts handed over: ${error.message}`); }
