// The script channel through its public doors: the package's own install.sh and
// `rer update`, against a local registry serving the real package tarball.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { buildPackage } from '../../scripts/rer-package.mjs';
import { tarball } from '../../scripts/rer-package/tarball.mjs';
import { integrity, localRegistry } from '../../scripts/rer-package/registry.mjs';
import { readPackage } from '../update/archive.mjs';

const base = resolve(import.meta.dirname, '../..');

test('install.sh uses an HTTP-only proxy for HTTPS registry downloads', async t => {
 const directory = await mkdtemp(join(tmpdir(), 'rer-installer-proxy-'));
 const servers = [];
 t.after(async () => {
  for (const server of servers) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
  await rm(directory, { recursive: true, force: true });
 });
 const env = { PATH: '/usr/bin:/bin', HOME: directory, CURL_HOME: directory, TMPDIR: directory };
 const key = join(directory, 'key.pem'), cert = join(directory, 'cert.pem');
 const generated = await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=registry.proxy.test', '-addext', 'subjectAltName=DNS:registry.proxy.test'], env);
 assert.equal(generated.code, 0, generated.stderr);
 async function listen(server) { servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; }
 let directRequests = 0;
 const registryPort = await listen(httpsServer({ key: await readFile(key), cert: await readFile(cert) }, (_req, res) => { directRequests++; res.end('{}'); }));
 const tunnels = [];
 const proxy = httpServer((_req, res) => res.writeHead(502).end());
 proxy.on('connect', (req, socket) => { tunnels.push(req.url); socket.end('HTTP/1.1 502 Fixture\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); });
 const proxyPort = await listen(proxy);
 const bin = join(directory, 'bin'); await mkdir(bin); await symlink(process.execPath, join(bin, 'node'));
 await writeFile(join(directory, '.curlrc'), `resolve = "registry.proxy.test:${registryPort}:127.0.0.1"\ncacert = "${cert}"\nmax-time = 5\n`);
 const result = await run('sh', [join(base, 'global/install.sh')], { ...env, PATH: `${bin}:${env.PATH}`, HTTP_PROXY: `http://127.0.0.1:${proxyPort}`, npm_config_registry: `https://registry.proxy.test:${registryPort}` });
 assert.notEqual(result.code, 0, 'the rejecting network edge stops installation');
 assert.deepEqual(tunnels, [`registry.proxy.test:${registryPort}`], 'the HTTPS fetch reaches the HTTP-only proxy');
 assert.equal(directRequests, 0, 'the installer never fetches directly');
 t.diagnostic(`proxy/listener PID=${process.pid}; CONNECTs=${tunnels.length}; direct requests=${directRequests}`);
});

function run(program, args, env, input) {
 return new Promise((resolveRun, reject) => {
  const child = spawn(program, args, { env, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
  if (input !== undefined) child.stdin.end(input);
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  child.once('error', reject);
  child.once('close', code => resolveRun({ code, stdout, stderr }));
 });
}

// The default seed's Run page as `rer build --site` renders it, and the commands in its code blocks.
async function runPageCommands() {
 const seed = createRequire(join(base, 'default-seed/package.json')), { build } = createRequire(seed.resolve('wrangler/package.json'))('esbuild');
 const bundle = await build({ entryPoints: [join(base, 'default-seed/src/site/pages.ts')], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' });
 const { sitePages } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
 const html = sitePages({ styles: [], clients: {} }).pages.find(page => page.path === '/run').html;
 const entities = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
 // A block's command is its text: inline spans only keep words together when it wraps.
 return [...html.matchAll(/<pre[^>]*><code>([\s\S]*?)<\/code><\/pre>/g)].map(match => match[1].replace(/<[^>]*>/g, '').replace(/&(amp|lt|gt|quot|#39);/g, entity => entities[entity]));
}

// The built package again under another version, optionally with extra raw entries.
function repack(entries, version, extra = []) {
 const files = entries.map(entry => ({ path: `package/${entry.path}`, data: entry.path === 'package.json' ? Buffer.from(JSON.stringify({ ...JSON.parse(entry.data), version }, null, 2) + '\n') : entry.data, executable: entry.executable }));
 return tarball([...files, ...extra], 0);
}

test('install.sh and rer update install verified registry releases, the Run page starts an app on what install.sh installed and its last line puts rer on PATH for new shells, and a bad download leaves the current one', { timeout: 5 * 60_000 }, async t => {
 const directory = await mkdtemp(join(tmpdir(), 'rer-installer-')), home = join(directory, 'home');
 const registry = await localRegistry();
 t.after(async () => { await registry.close(); await rm(directory, { recursive: true, force: true }); });

 const built = await readFile(await buildPackage(base, join(directory, 'built')));
 const entries = readPackage(built, { integrity: integrity(built) });
 const manifest = JSON.parse(entries.find(entry => entry.path === 'package.json').data);
 const installer = join(directory, 'install.sh');
 await writeFile(installer, entries.find(entry => entry.path === 'install.sh').data);

 const bin = join(directory, 'bin');
 await mkdir(bin);
 await symlink(process.execPath, join(bin, 'node'));
 const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, SHELL: '/bin/sh', TMPDIR: directory, npm_config_registry: registry.url };
 const rer = join(home, '.local/bin/rer');
 const selected = async () => (await run(rer, ['--version'], env)).stdout.trim();

 // A development build is published; install.sh installs it.
 registry.publish(manifest.version, built);
 // Business connect runs directly from the installer without asking the agent
 // to start an app or change PATH, both on first install and on reuse.
 const businessEnv = { ...env, HOME: join(directory, 'business-home') };
 const businessRer = join(businessEnv.HOME, '.local/bin/rer');
 for (let attempt = 0; attempt < 2; attempt++) {
  const connected = await run('sh', [installer, 'business', 'connect', '--help'], businessEnv);
  assert.equal(connected.code, 0, connected.stderr);
  assert.doesNotMatch(connected.stdout + connected.stderr, /rer dev|\bPATH\b/);
  const help = await run(businessRer, ['business', 'connect', '--help'], businessEnv);
  assert.equal(help.code, 0, help.stderr);
  assert.ok(help.stdout.length > 0 && connected.stdout.endsWith(help.stdout), 'the installer runs the requested business command');
 }
 assert.equal((await run(businessRer, ['cli', 'uninstall'], businessEnv)).code, 0);
 const installed = await run('sh', [installer], env);
 assert.equal(installed.code, 0, installed.stderr);
 assert.equal(await selected(), manifest.version);
 assert.deepEqual(await readdir(bin), ['node'], 'installation never writes into another writable PATH directory');
 // The installer's last line puts rer on PATH: in the shell that runs it, and
 // in a new login shell of the person's SHELL that starts without it.
 const activate = output => { const last = output.trimEnd().split('\n').at(-1).trim(); return last.includes('.local/bin') ? last : undefined; };
 const hint = activate(installed.stdout);
 assert.ok(hint, installed.stdout);
 assert.equal(installed.stdout.match(/^Next, /gm)?.length, 1, `one next step, not two: ${installed.stdout}`);
 assert.equal((await run('sh', ['-c', `${hint}\nrer --version`], env)).stdout.trim(), manifest.version);
 assert.equal((await run('sh', ['-l', '-c', 'rer --version'], env)).stdout.trim(), manifest.version, 'a new shell finds rer after the line ran once');

 // The Run page hands its start arguments to install.sh in the same pipeline.
 // Its installed rer also runs with no npx or Node on PATH: the private Node
 // install.sh downloads when there is none stands in as its runtime link.
 const runtime = join(home, '.local/share/rer/node'), installedOnly = { ...env, PATH: join(home, '.local/bin') };
 await symlink(dirname(dirname(process.execPath)), runtime);
 // The managed launcher uses its private Node without making that Node's
 // sibling tools replace tools already selected by the caller.
 await writeFile(join(bin, 'npm'), '#!/bin/sh\nprintf "caller-npm\\n"\n', { mode: 0o755 });
 const checkTool = `import { execFileSync } from 'node:child_process';
if (execFileSync('npm', [], { env: { ...process.env, NODE_OPTIONS: '' }, encoding: 'utf8' }).trim() !== 'caller-npm') throw Error('caller npm was shadowed');`;
 const callerTools = { ...env, NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(checkTool)}` };
 const managed = await run(rer, ['--version'], callerTools);
 assert.equal(managed.code, 0, managed.stderr);
 await rm(join(bin, 'npm'));
 const commands = await runPageCommands();
 assert.equal(commands.length, 1, 'the Run page installs and starts with one command');
 const pipeline = commands[0].split('|');
 assert.equal(pipeline.length, 2, 'the downloaded installer is piped to the shell');
 const [program, ...scriptArguments] = pipeline[1].trim().split(/\s+/);
 const startAt = scriptArguments.indexOf('--');
 assert.ok(startAt >= 0 && scriptArguments.length > startAt + 1, 'the shell forwards start arguments to the installer');
 // Supply the real downloaded script at the network edge. --help exercises
 // argument forwarding without cloning the reference or starting a server.
 const started = await run(program, [...scriptArguments, '--help'], env, await readFile(installer));
 assert.equal(started.code, 0, started.stderr);
 const direct = await run(rer, [...scriptArguments.slice(startAt + 1), '--help'], installedOnly);
 assert.equal(direct.code, 0, `the installed rer runs without Node or npx on PATH: ${direct.stderr}`);
 assert.ok(direct.stdout.trim() && started.stdout.endsWith(direct.stdout), 'the installer runs the Run page’s requested command with its installed rer');
 await rm(runtime);
 const status = JSON.parse((await run(rer, ['cli', 'status', '--json'], env)).stdout);
 assert.equal(status.channel, 'script');
 assert.deepEqual(status.others, []);

 // The clean release is published with a sha512 that does not match its bytes.
 const release = manifest.version.replace(/-.*$/, ''), releaseBytes = repack(entries, release);
 registry.publish(release, releaseBytes, { dist: { integrity: integrity(Buffer.from('other bytes')) } });
 const mismatched = await run('sh', [installer], env);
 assert.notEqual(mismatched.code, 0, 'install.sh refuses a download that does not match its integrity');
 assert.equal(await selected(), manifest.version, 'the previous install is still selected after install.sh refuses');
 const updateMismatched = await run(rer, ['update'], env);
 assert.notEqual(updateMismatched.code, 0, 'rer update refuses a download that does not match its integrity');
 assert.equal(await selected(), manifest.version, 'the previous install is still selected after rer update refuses');

 // Archives with entries that would write outside the package, verified by integrity.
 for (const [index, unsafe] of [
  [{ path: join(directory, 'escaped'), data: Buffer.from('outside'), executable: false }],
  [{ path: 'package/../escaped', data: Buffer.from('outside'), executable: false }],
  [{ path: 'package/global/hard', data: Buffer.alloc(0), type: '1', linkname: 'package/README.md' }],
  [{ path: 'package/global/link', data: Buffer.alloc(0), type: '2', linkname: '/etc' }],
 ].entries()) {
  registry.publish(`${release}-unsafe.${index}`, repack(entries, `${release}-unsafe.${index}`, unsafe));
  const refused = await run('sh', [installer], env);
  assert.notEqual(refused.code, 0, `install.sh refuses ${unsafe[0].path}`);
  assert.equal(await selected(), manifest.version);
  await assert.rejects(access(join(directory, 'escaped')));
 }

 // The release is republished correctly: rer update moves the development build to it.
 registry.publish(release, releaseBytes);
 const updated = await run(rer, ['update'], env);
 assert.equal(updated.code, 0, updated.stderr);
 assert.equal(await selected(), release);
 assert.equal(JSON.parse((await run(rer, ['cli', 'status', '--json'], env)).stdout).channel, 'script', 'rer update keeps the script channel');
 const again = await run(rer, ['update'], env);
 assert.equal(again.code, 0, again.stderr);
 assert.equal(await selected(), release);
 // A foreign command earlier on PATH is preserved; current-shell activation works.
 const foreignBin = join(directory, 'foreign-bin');
 await mkdir(foreignBin);
 await writeFile(join(foreignBin, 'rer'), '#!/bin/sh\nprintf "foreign\\n"\n', { mode: 0o755 });
 const isolated = { ...env, HOME: join(directory, 'activation-home'), PATH: `${foreignBin}:${join(directory, 'activation-home/.local/bin')}:${env.PATH}` };
 const activation = await run('sh', [installer], isolated);
 assert.equal(activation.code, 0, activation.stderr);
 const line = activate(activation.stdout);
 assert.ok(line, activation.stdout);
 assert.ok(activation.stdout.includes(join(foreignBin, 'rer')), 'installation names the existing command it leaves alone');
 assert.equal((await run('sh', ['-c', `${line}\nrer --version`], isolated)).stdout.trim(), release);
 assert.equal((await run('sh', ['-l', '-c', 'rer --version'], isolated)).stdout.trim(), release, 'a new shell puts the installed rer before the foreign one');
 assert.equal((await run(join(foreignBin, 'rer'), [], isolated)).stdout.trim(), 'foreign');
 const activeEnv = { ...isolated, PATH: `${join(isolated.HOME, '.local/bin')}:${isolated.PATH}` };
 const active = await run('sh', [installer], activeEnv);
 assert.equal(active.code, 0, active.stderr);
 assert.equal(activate(active.stdout), undefined, 'no line when the installed launcher is first now and in new shells');
 assert.ok(active.stdout.includes(join(foreignBin, 'rer')), 'a later existing command is also named and preserved');
 assert.deepEqual(await readdir(bin), ['node']);
 // Uninstall removes only recorded links still pointing at this canonical launcher.
 const removed = await run(rer, ['cli', 'uninstall'], env);
 assert.equal(removed.code, 0, removed.stderr);
 await assert.rejects(access(join(bin, 'rer')));
 const activationRer = join(isolated.HOME, '.local/bin/rer');
 assert.equal((await run(activationRer, ['cli', 'uninstall'], isolated)).code, 0);
 assert.equal((await run(join(foreignBin, 'rer'), [], isolated)).stdout.trim(), 'foreign');
});
