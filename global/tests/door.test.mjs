import { randomBytes } from 'node:crypto';
// The front door end to end through its public doors: the rer command and HTTP
// on the door's port. Two fresh default-seed exports are set up behind the
// door with one `rer dev` each; a visit starts a stopped one, an image or a
// WebSocket never does, Vite HMR reaches it through the door, it stops when
// idle and the next visit starts it again; an unknown name answers 404, and the
// door refuses to start while another process holds its port on [::1].
// Every request goes to 127.0.0.1 with a Host header, as rer's own probes do,
// so no resolver needs to know *.localhost.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { exportReference } from '../../scripts/export-reference.mjs';
import { isolatedQueue } from '../../cli/fixtures/queue.mjs';

const base = resolve(import.meta.dirname, '../..'), rer = join(base, 'global/rer.mjs');

function run(args, { cwd, env }) {
 return new Promise((resolveRun, reject) => {
  const child = spawn(process.execPath, [rer, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  child.once('error', reject);
  child.once('close', code => resolveRun({ code, stdout, stderr }));
 });
}

// One request to the door on 127.0.0.1 with the Host a browser would send.
function request(port, host, path, headers = {}) {
 return new Promise((resolveRequest, reject) => {
  const sent = http.request({ host: '127.0.0.1', port, path, headers: { host, ...headers }, agent: false }, response => {
   let body = '';
   response.setEncoding('utf8');
   response.on('data', chunk => { body += chunk; });
   response.on('end', () => resolveRequest({ status: response.statusCode, headers: response.headers, body }));
  });
  sent.on('error', reject);
  sent.end();
 });
}

const navigation = { accept: 'text/html', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'none' };
const image = { accept: 'image/*', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image', 'sec-fetch-site': 'same-origin' };

// A WebSocket upgrade through the door; resolves with the status line and,
// once upgraded, the socket and every text it receives.
function upgrade(port, host, path, { origin, protocol } = {}) {
 return new Promise((resolveUpgrade, reject) => {
  const socket = net.connect(port, '127.0.0.1', () => socket.write([`GET ${path} HTTP/1.1`, `Host: ${host}`, 'Connection: Upgrade', 'Upgrade: websocket', 'Sec-WebSocket-Version: 13', `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`, ...(protocol ? [`Sec-WebSocket-Protocol: ${protocol}`] : []), ...(origin ? [`Origin: ${origin}`] : []), '', ''].join('\r\n')));
  let received = '';
  socket.on('data', chunk => {
   received += chunk.toString('latin1');
   if (!socket.status && received.includes('\r\n')) { socket.status = received.split('\r\n')[0]; resolveUpgrade(socket); }
  });
  socket.text = () => received;
  socket.on('error', reject);
 });
}

async function freePort() {
 for (;;) {
  const probe = net.createServer();
  await new Promise(resolveListen => probe.listen(0, '127.0.0.1', resolveListen));
  const { port } = probe.address();
  await new Promise(resolveClose => probe.close(resolveClose));
  // Free on [::1] too, where the door also listens.
  const six = net.createServer();
  const free = await new Promise(resolveSix => { six.once('error', error => resolveSix(['EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes(error.code))); six.listen({ port, host: '::1', ipv6Only: true }, () => six.close(() => resolveSix(true))); });
  if (free) return port;
 }
}

async function until(check, what, timeoutMs = 240_000) {
 const started = Date.now();
 for (;;) {
  const value = await check();
  if (value) return value;
  if (Date.now() - started > timeoutMs) assert.fail(`timed out waiting for ${what}`);
  await delay(500);
 }
}

const lines = output => Object.fromEntries(output.split('\n').filter(line => /^RER_[A-Z_]+ /.test(line)).map(line => [line.split(' ')[0], line.slice(line.indexOf(' ') + 1)]));

test('the front door serves two checkouts by name, starting them on a visit and stopping them when idle', { timeout: 30 * 60_000 }, async t => {
 const directory = await mkdtemp(join(tmpdir(), 'rer-door-')), alpha = join(directory, 'alpha'), beta = join(directory, 'beta');
 const env = await isolatedQueue(t, { PATH: process.env.PATH, HOME: process.env.HOME, CI: 'true', WRANGLER_SEND_METRICS: 'false', RER_SERVERS_DIR: join(directory, 'servers'), RER_DOOR_DIR: join(directory, 'door'), ...Object.fromEntries(['TMPDIR', 'PLAYWRIGHT_BROWSERS_PATH', 'COREPACK_HOME', 'npm_config_store_dir'].filter(name => process.env[name]).map(name => [name, process.env[name]])) });
 let squatter;
 t.after(async () => {
  squatter?.close();
  for (const root of [alpha, beta]) await run(['dev', '--stop'], { cwd: root, env }).catch(() => {});
  await run(['door', 'disable'], { cwd: directory, env }).catch(() => {});
  await rm(directory, { recursive: true, force: true });
 });

 // The door never starts while another process holds its port on [::1]
 // (where browsers try first); a host without IPv6 loopback holds 127.0.0.1.
 const held = await freePort();
 squatter = net.createServer();
 const sixOnly = await new Promise(resolveListen => { squatter.once('error', () => resolveListen(false)); squatter.listen({ port: held, host: '::1', ipv6Only: true }, () => resolveListen(true)); });
 if (!sixOnly) { squatter = net.createServer(); await new Promise(resolveListen => squatter.listen(held, '127.0.0.1', resolveListen)); }
 t.diagnostic(`squatter on ${sixOnly ? '[::1]' : '127.0.0.1'}:${held}`);
 const refused = await run(['door', 'enable', '--port', String(held)], { cwd: directory, env: { ...env, RER_DOOR_DIR: join(directory, 'door-refused') } });
 assert.equal(refused.code, 4, refused.stderr + refused.stdout);
 assert.match(refused.stderr, new RegExp(`PID ${process.pid}\\b`), 'the refusal names the process that holds the port');
 squatter.close(); squatter = undefined;

 const port = await freePort(), door = name => `${name}.localhost:${port}`;
 const enabled = await run(['door', 'enable', '--port', String(port), '--idle-timeout', '15'], { cwd: directory, env });
 assert.equal(enabled.code, 0, enabled.stderr + enabled.stdout);

 // A fresh checkout launched with one rer dev is set up at its door origin.
 await Promise.all([alpha, beta].map(root => exportReference(base, root)));
 const launched = await Promise.all([alpha, beta].map(root => run(['dev'], { cwd: root, env })));
 for (const [index, name] of ['alpha', 'beta'].entries()) {
  assert.equal(launched[index].code, 0, launched[index].stderr + launched[index].stdout);
  assert.equal(lines(launched[index].stdout).RER_READY, `http://${door(name)}`);
  assert.equal((await request(port, door(name), '/health')).status, 200, `${name} answers through the door`);
  assert.equal((await request(port, door(name).toUpperCase(), '/health')).status, 200, `${name} answers in any letter case`);
 }
 assert.equal((await request(port, door('nobody'), '/')).status, 404, 'an unknown name is not a checkout');
 assert.equal((await request(port, `evil.example:${port}`, '/')).status, 400, 'another Host is never proxied');
 for (const root of [alpha, beta]) assert.equal((await run(['dev', '--stop'], { cwd: root, env })).code, 0);

 const state = async name => JSON.parse((await request(port, door(name), '/__rer/door/state')).body).state;
 const sites = async () => Object.fromEntries(JSON.parse((await run(['door', 'status', '--json'], { cwd: directory, env })).stdout).sites.map(site => [site.name, site.state]));
 assert.deepEqual(await sites(), { alpha: 'stopped', beta: 'stopped' });

 // An image or a WebSocket never starts a stopped checkout.
 assert.equal((await request(port, door('alpha'), '/favicon.ico', image)).status, 503);
 const early = await upgrade(port, door('alpha'), '/', { protocol: 'vite-hmr', origin: `http://${door('alpha')}` });
 assert.match(early.status, / 503 /); early.destroy();
 await delay(2000);
 assert.equal(await state('alpha'), 'stopped', 'neither request started alpha');

 // A visit starts it: a starting page, then the app itself.
 const visit = await request(port, door('alpha'), '/', navigation);
 assert.equal(visit.status, 503);
 assert.ok(visit.headers['retry-after']);
 await until(async () => await state('alpha') === 'running', 'alpha to start');
 assert.equal((await request(port, door('alpha'), '/', navigation)).status, 200);
 assert.equal(await state('beta'), 'stopped', 'only the visited checkout started');

 // Vite HMR reaches the page through the door: an edit arrives as an update.
 const token = /wsToken = "([^"]+)"/.exec((await request(port, door('alpha'), '/@vite/client')).body)?.[1];
 assert.ok(token, 'the Vite client names its HMR token');
 assert.match((await upgrade(port, door('alpha'), `/?token=${token}`, { protocol: 'vite-hmr', origin: `http://${door('beta')}` })).status, / 403 /, 'another site may not open the socket');
 const hmr = await upgrade(port, door('alpha'), `/?token=${token}`, { protocol: 'vite-hmr', origin: `http://${door('alpha')}` });
 assert.match(hmr.status, / 101 /);
 // The page's own module, as the browser loads it, puts it in Vite's client graph.
 assert.equal((await request(port, door('alpha'), '/src/routes/records.tsx', { accept: '*/*', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'script', 'sec-fetch-site': 'same-origin' })).status, 200);
 const route = join(alpha, 'src/routes/records.tsx');
 await writeFile(route, (await readFile(route, 'utf8')).replace('Server-rendered public record', 'Edited behind the door'));
 await until(() => hmr.text().includes('"type":"update"') && hmr.text().includes('records.tsx'), 'the HMR update', 60_000);
 hmr.destroy();

 // Idle for its stored 15 seconds, it stops; the next visit starts it again.
 await until(async () => (await sites()).alpha === 'stopped', 'alpha to stop when idle', 120_000);
 assert.equal((await request(port, door('alpha'), '/', navigation)).status, 503);
 await until(async () => await state('alpha') === 'running', 'alpha to start again');
 assert.match((await request(port, door('alpha'), '/records', navigation)).body, /Edited behind the door/);
});
