import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import type { Socket } from 'node:net';
export { testTls } from '../testing/wasm-tls.mjs';
import { buildEgressWorker, workerModules } from '../build.mjs';

/** Test-only roots are injected solely into a separately compiled WASM test artifact. */
export async function certificates() {
  const dir = await mkdtemp(join(tmpdir(), 'egress-certs-'));
  const run = (args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
  run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', 'ca.key', '-out', 'ca.pem', '-subj', '/CN=Egress Test CA',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign']);
  await writeFile(join(dir, 'index'), '');
  await writeFile(join(dir, 'serial'), '01\n');
  await writeFile(join(dir, 'ca.cnf'), '[ca]\ndefault_ca=issuer\n[issuer]\ndatabase=index\nserial=serial\nnew_certs_dir=.\ncertificate=ca.pem\nprivate_key=ca.key\ndefault_md=sha256\npolicy=policy\n[policy]\ncommonName=supplied\n');
  const issue = async (file: string, host: string, days = 1) => {
    run(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${file}.key`, '-out', `${file}.csr`, '-subj', `/CN=${host}`]);
    execFileSync('sh', ['-c', `printf 'subjectAltName=DNS:${host}\\nextendedKeyUsage=serverAuth\\n' > ${file}.ext`], { cwd: dir });
    if (days < 0) run(['ca', '-batch', '-config', 'ca.cnf', '-in', `${file}.csr`, '-out', `${file}.pem`, '-startdate', '20000101000000Z', '-enddate', '20000102000000Z', '-extfile', `${file}.ext`]);
    else run(['x509', '-req', '-in', `${file}.csr`, '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-days', String(days), '-out', `${file}.pem`, '-extfile', `${file}.ext`]);
    return { key: await readFile(join(dir, `${file}.key`)), cert: await readFile(join(dir, `${file}.pem`)) };
  };
  const receiver = await issue('receiver', 'receiver.example.com');
  const expired = await issue('expired', 'receiver.example.com', -1);
  const otherHost = await issue('other', 'other.example.net');
  run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', 'rogue.key', '-out', 'rogue.pem', '-subj', '/CN=receiver.example.com', '-addext', 'subjectAltName=DNS:receiver.example.com']);
  const untrusted = { key: await readFile(join(dir, 'rogue.key')), cert: await readFile(join(dir, 'rogue.pem')) };
  return { caPath: join(dir, 'ca.pem'), ca: await readFile(join(dir, 'ca.pem')), receiver, otherHost, untrusted, expired, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export interface Recorded { raw: Buffer; head: string; headers: Record<string, string>; body: Buffer; servername: string | false }
export type Reply = Buffer | string | { truncate: string };

/** A real TLS server on loopback that records each request's exact bytes and SNI, then writes a raw reply. */
export async function tlsReceiver(pair: { key: Buffer; cert: Buffer }, reply: (request: Recorded) => Reply | Promise<Reply> = () => 'HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n') {
  const requests: Recorded[] = [], sockets = new Set<Socket>();
  let connections = 0;
  const server = tls.createServer(pair, socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    let buffer = Buffer.alloc(0), done = false;
    socket.on('data', async chunk => {
      if (done) return;
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      const head = buffer.subarray(0, end).toString('latin1');
      const headers = Object.fromEntries(head.split('\r\n').slice(1).map(line => [line.slice(0, line.indexOf(':')).toLowerCase(), line.slice(line.indexOf(':') + 1).trim()]));
      const length = Number(headers['content-length'] ?? 0);
      if (buffer.length < end + 4 + length) return;
      done = true;
      const recorded = { raw: buffer, head, headers, body: buffer.subarray(end + 4, end + 4 + length), servername: socket.servername };
      requests.push(recorded);
      const out = await receiver.reply(recorded);
      if (out === 'stall') return;
      if (out === 'close') { socket.destroy(); return; }
      if (typeof out === 'object' && !Buffer.isBuffer(out)) { socket.write(out.truncate, () => socket.destroy()); return; }
      socket.end(out);
    });
  });
  server.on('connection', socket => { connections++; sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const receiver = {
    port: (server.address() as import('node:net').AddressInfo).port, requests, reply,
    /** TCP connections accepted, including ones whose TLS the client then refused. */
    get connections() { return connections; },
    get activeConnections() { return sockets.size; },
    async close() { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
  return receiver;
}

/** Recorded DNS and socket edge for the test egress Worker (its only fakes). */
export function networkEdge() {
  const state = {
    answers: new Map<string, string[][]>(), routes: new Map<string, number>(),
    resolutions: [] as string[], connects: [] as string[], failConnect: false, dnsDelayMs: 0, connectDelayMs: 0, stallWriteAfter: null as number | null,
  };
  const handler = async (request: Request) => {
    const url = new URL(request.url);
    if (url.pathname === '/resolve') {
      const host = await request.text(); state.resolutions.push(host);
      if (state.dnsDelayMs) await new Promise(resolve => setTimeout(resolve, state.dnsDelayMs));
      const queue = state.answers.get(host);
      const next = queue && (queue.length > 1 ? queue.shift() : queue[0]);
      return next ? Response.json(next) : new Response(null, { status: 404 });
    }
    if (url.pathname === '/connect') {
      const { hostname, port } = await request.json() as { hostname: string; port: number };
      state.connects.push(hostname);
      if (state.connectDelayMs) await new Promise(resolve => setTimeout(resolve, state.connectDelayMs));
      const route = !state.failConnect && port === 443 ? state.routes.get(hostname) : undefined;
      return Response.json({ port: route ?? null, stallWriteAfter: state.stallWriteAfter });
    }
    return new Response(null, { status: 404 });
  };
  return { state, handler };
}

/** The library entrypoint with the edge fixture as its ports; limits shortened for the stall rows. */
export const testEgressEntry = `
import module from './egress-service/tls/test.wasm';
import { rustls } from './egress-service/rustls.ts';
import { connect } from 'cloudflare:sockets';
import { createEgressEntrypoint } from './egress-service/entrypoint.ts';
const ports = env => ({
  fetch: (url, init) => fetch(url, init),
  async resolve(hostname) {
    const response = await env.EDGE.fetch('http://edge/resolve', { method: 'POST', body: hostname });
    if (!response.ok) throw new Error('no such name');
    return response.json();
  },
  async connect(address, options) {
    const { port, stallWriteAfter } = await (await env.EDGE.fetch('http://edge/connect', { method: 'POST', body: JSON.stringify(address) })).json();
    if (!port) throw new Error('socket fixture refused');
    const socket = connect({ hostname: '127.0.0.1', port }, options);
    if (stallWriteAfter === null) return socket;
    const writer = socket.writable.getWriter(); let writes = 0, rejectStall;
    return { opened: socket.opened, readable: socket.readable,
      writable: new WritableStream({ write(bytes) { if (writes++ >= stallWriteAfter) return new Promise((_, reject) => { rejectStall = reject; }); return writer.write(bytes); } }),
      async close() { rejectStall?.(new Error('closed network edge')); await socket.close(); writer.releaseLock(); },
    };
  },
});
const limits = { tls: rustls(module, exports => { const root = Uint8Array.from(ROOT); const ptr = exports.buffer(); new Uint8Array(exports.memory.buffer, ptr, root.length).set(root); exports.test_root(root.length); }), dnsTimeoutMs: 1000, requestTimeoutMs: 1500 };
export default createEgressEntrypoint(ports, limits);
export const EgressRestricted = createEgressEntrypoint(ports, limits, 'EgressRestricted');`;

/** A caller Worker: sends each wire through its EGRESS binding and reports the result or the error code. */
export const callerEntry = `
export default { async fetch(request, env) {
  const { wires = [], probe, url } = await request.json();
  if (url) { try { const response = await fetch(url); return Response.json({ status: response.status }); } catch (error) { return Response.json({ error: String(error.message) }); } }
  if (!env.EGRESS) return Response.json({ binding: false });
  if (probe) { try { await env.EGRESS[probe](); return Response.json({ probe: 'reached' }); } catch (error) { return Response.json({ probe: String(error.message) }); } }
  const results = [];
  for (const wire of wires) {
    try { results.push({ response: await env.EGRESS.send(wire) }); } catch (error) { results.push({ error: String(error.message) }); }
  }
  return Response.json({ binding: true, results });
} };`;

type ModuleSet = Record<string, { type: 'esm'; contents: string } | { type: 'wasm'; contents: Uint8Array }>;
const esm = (files: Record<string, string | Uint8Array>): ModuleSet => Object.fromEntries(Object.entries(files).map(([name, contents]) => [name, typeof contents === 'string' ? { type: 'esm' as const, contents } : { type: 'wasm' as const, contents }]));

/** Test egress module graph (library source + the edge entry) and the built deployable Worker. */
export async function egressModules(ca: Buffer) {
  const library = { ...await workerModules(new URL('../entrypoint.ts', import.meta.url).pathname), ...await workerModules(new URL('../rustls.ts', import.meta.url).pathname) };
  const built = await buildEgressWorker(await mkdtemp(join(tmpdir(), 'egress-build-')));
  const deployable: Record<string, string | Uint8Array> = {};
  for (const name of built.modules) deployable[name] = name.endsWith('.wasm') ? await readFile(join(built.server, name)) : await readFile(join(built.server, name), 'utf8');
  return {
    test: { mainModule: 'egress-test.js', modules: esm({ ...library, 'egress-service/tls/test.wasm': await readFile(new URL('../tls/test.wasm', import.meta.url)), 'egress-test.js': testEgressEntry.replace('ROOT', JSON.stringify([...der(ca)])) }) },
    deployable: { mainModule: built.main, modules: esm(deployable) },
    caller: { mainModule: 'caller.js', modules: esm({ 'caller.js': callerEntry }) },
    async cleanup() { await rm(join(built.server, '../..'), { recursive: true, force: true }); },
  };
}

export const worker = (name: string, manifest: { mainModule: string; modules: ModuleSet }, env: Record<string, unknown> = {}, dev: Record<string, unknown> = {}) =>
  ({ config: { name, type: 'worker', compatibilityDate: '2026-09-08', manifest, env: { EGRESS_OWNED_ZONES: { type: 'text', value: '[]' }, EGRESS_WORKERS_SUFFIX: { type: 'text', value: 'fixture.workers.dev' }, ...env } }, dev });

/** A recorder for a Worker's global fetch (Miniflare's outbound service). */
export function outboundRecorder() {
  const urls: string[] = [];
  return { urls, service: { outboundService: { type: 'fetcher', handler: (request: Request) => { urls.push(request.url); return new Response(null, { status: 502 }); } } } };
}

function der(pem: Buffer): Buffer { return Buffer.from(pem.toString().replace(/-----[^-]+-----/g, '').replace(/\s/g, ''), 'base64'); }
