import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as httpServer } from 'node:http';
import { createServer as tlsServer } from 'node:https';
import { connect } from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { exportReference } from '../scripts/export-reference.mjs';

const execute = promisify(execFile);
const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; };

test('rer downloads use the environment proxy and its child Node bypasses loopback', { timeout: 90000 }, async t => {
 const directory = await mkdtemp(join(tmpdir(), 'rer-proxy-')), root = join(directory, 'project');
 t.after(() => rm(directory, { recursive: true, force: true }));
 await exportReference(resolve(import.meta.dirname, '..'), root);
 const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
 const pin = '0.0.1';
 await execute('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem'), '-days', '1', '-subj', '/CN=nodejs.org', '-addext', 'subjectAltName=DNS:nodejs.org,DNS:registry.npmjs.org']);
 const paths = [], tunnels = [], sockets = new Set();
 const edge = tlsServer({ key: await readFile(join(directory, 'key.pem')), cert: await readFile(join(directory, 'cert.pem')) }, (req, res) => {
  paths.push(req.url);
  if (req.url.endsWith('SHASUMS256.txt')) res.end('0'.repeat(64) + `  node-v${pin}-${process.platform}-${process.arch}.tar.gz\n`);
  else if (req.url.includes('/pnpm/') && !req.url.endsWith('.tgz')) res.end(JSON.stringify({ version: pkg.packageManager.slice(5), dist: { integrity: 'sha512-' + Buffer.alloc(64).toString('base64') } }));
  else res.end('deliberately invalid archive at the download edge');
 });
 const edgePort = await listen(edge);
 const proxy = httpServer((req, res) => { tunnels.push(req.url); res.writeHead(502).end(); });
 proxy.on('connect', (req, socket, head) => {
  tunnels.push(req.url);
  const upstream = connect(edgePort, '127.0.0.1', () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket); });
  for (const stream of [socket, upstream]) { sockets.add(stream); stream.on('error', () => {}); stream.on('close', () => sockets.delete(stream)); }
 });
 const proxyPort = await listen(proxy);
 let localRequests = 0;
 const local = httpServer((_req, res) => { localRequests++; res.end('loopback'); });
 const localPort = await listen(local);
 const local6 = httpServer((_req, res) => { localRequests++; res.end('loopback'); });
 local6.listen(localPort, '::1'); await once(local6, 'listening');
 t.after(async () => { for (const socket of sockets) socket.destroy(); for (const server of [edge, proxy, local, local6]) { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); } });
 // Only real, required executables are visible: never inherit a matching pnpm,
 // runtime cache selectors, package-manager settings or Node startup flags.
 const tools = join(directory, 'bin'); await mkdir(tools);
 for (const [name, binary] of [['node', process.execPath], ['sh', '/bin/sh'], ['tar', '/usr/bin/tar']]) await symlink(binary, join(tools, name));
 const clean = { PATH: tools, TMPDIR: directory, CI: 'true', RER_NO_UPDATE_CHECK: '1', NODE_EXTRA_CA_CERTS: join(directory, 'cert.pem') };
 async function run(args, proxyOn) {
  const home = join(directory, 'home-' + Math.random()); await mkdir(home);
  const env = { ...clean, HOME: home, ...(proxyOn ? { HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`, NO_PROXY: 'example.invalid', no_proxy: 'another.invalid' } : {}) };
  const child = spawn(process.execPath, [join(root, 'scripts/rer.mjs'), ...args, '--cwd', root], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const timer = setTimeout(() => child.kill('SIGTERM'), 20000);
  const [code] = await once(child, 'exit'); clearTimeout(timer);
  t.diagnostic(`${args[0]} proxy=${proxyOn ? 'set' : 'unset'} Node=${process.versions.node} exit=${code} CONNECTs=${tunnels.length}; ${output.trim().replaceAll('\n', ' | ').slice(-1200)}`);
  return { code, output };
 }
 async function nodePin(version) {
  pkg.engines.node = version;
  await writeFile(join(root, 'package.json'), JSON.stringify(pkg));
  for (const name of ['.node-version', '.nvmrc']) await writeFile(join(root, name), version);
 }
 await nodePin(pin);
 const before = tunnels.length;
 const absent = await run(['install'], false);
 assert.notEqual(absent.code, 0);
 assert.equal(tunnels.length, before, 'unset proxy receives no download traffic');
 const selected = await run(['install'], true);
 const [major, minor] = process.versions.node.split('.').map(Number);
 if (!((major === 22 && minor >= 21) || major >= 24)) {
  assert.match(selected.output, /Proxy downloads require Node/);
  assert.equal(tunnels.length, before, 'unsupported Node refuses instead of silently fetching directly');
 } else {
  assert.match(selected.output, /checksum/i);
  assert.ok(paths.some(path => path.endsWith('SHASUMS256.txt')));
  assert.ok(paths.some(path => path.endsWith('.tar.gz')));
  assert.ok(tunnels.includes('nodejs.org:443'));
  await nodePin(process.versions.node);
  const pnpm = await run(['install'], true);
  assert.notEqual(pnpm.code, 0);
  assert.ok(paths.some(path => path.startsWith('/pnpm/') && !path.endsWith('.tgz')), pnpm.output);
  assert.ok(paths.some(path => path.endsWith('.tgz')), pnpm.output);
  assert.match(pnpm.output, /integrity verification failed/);
  assert.ok(tunnels.includes('registry.npmjs.org:443'));
 }
 // A genuine independently authored operation exercises the same rer child
 // environment, including the two preserved bypass lists and local fetch.
 const descriptor = { version: 2, project: 'example/proxy', runtime: { requirements: [] }, requiredEnvironment: [], commands: { setup: { argv: ['node', 'loopback.mjs'], inputs: ['loopback.mjs'], effects: 'Fetch loopback through a real Node child.' } } };
 await writeFile(join(root, 'loopback.mjs'), `for(const host of ['127.0.0.1','localhost','[::1]']){const r=await fetch('http://'+host+':${localPort}');if(await r.text()!=='loopback')process.exit(1);}for(const name of ['NO_PROXY','no_proxy'])for(const host of ['127.0.0.1','localhost','::1','example.invalid','another.invalid'])if(!process.env[name].split(',').includes(host))process.exit(2);`);
 // The independent descriptor runs the operation without acquiring project pnpm.
 await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify(descriptor));
 await nodePin(process.versions.node);
 // A warm runtime must not let setup dispatch an unguarded downloading child.
 await writeFile(join(root, 'download.mjs'), `console.log('CHILD_DOWNLOAD_STARTED');try{const r=await fetch('https://registry.npmjs.org/child-download',{signal:AbortSignal.timeout(2000)});console.log('CHILD_DOWNLOAD_COMPLETE',r.status)}catch{console.error('CHILD_DOWNLOAD_FAILED');process.exitCode=9}`);
 descriptor.commands.setup.argv = ['node', 'download.mjs'];
 descriptor.commands.setup.inputs = ['download.mjs'];
 await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify(descriptor));
 const setupBefore = tunnels.length;
 const setupAbsent = await run(['setup'], false);
 assert.match(setupAbsent.output, /CHILD_DOWNLOAD_STARTED/);
 assert.equal(tunnels.length, setupBefore, 'unset setup sends no traffic to the logging proxy');
 const setup = await run(['setup'], true);
 if (!((major === 22 && minor >= 21) || major >= 24)) {
  assert.match(setup.output, /Proxy downloads require Node/);
  assert.doesNotMatch(setup.output, /CHILD_DOWNLOAD_STARTED/, 'unsupported setup refuses before starting a child download');
  assert.equal(tunnels.length, setupBefore);
  return;
 }
 assert.equal(setup.code, 0, setup.output);
 assert.match(setup.output, /CHILD_DOWNLOAD_COMPLETE/);
 assert.ok(tunnels.length > setupBefore, 'setup child download reaches the proxy');
 descriptor.commands.setup.argv = ['node', 'loopback.mjs'];
 descriptor.commands.setup.inputs = ['loopback.mjs'];
 await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify(descriptor));
 const prior = tunnels.length;
 const loopback = await run(['setup'], true);
 assert.equal(loopback.code, 0, loopback.output);
 assert.equal(localRequests, 3);
 assert.equal(tunnels.length, prior, 'loopback never reaches the proxy');
 t.diagnostic(`downloads observed: ${paths.join(', ')}; proxy CONNECTs=${tunnels.length}`);
});
