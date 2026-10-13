import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, readdir, rm, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { exportReference } from '../scripts/export-reference.mjs';

// The only fake is the official download edge. The real exported dispatcher,
// discovery, checksum verification and private-cache cleanup run unchanged.
test('public runtime bootstrap refuses unverified downloads and gives private, bounded recovery before adapter effects', async t => {
 const directory = await mkdtemp(join(tmpdir(), 'rer-node-'));
 t.after(() => rm(directory, { recursive: true, force: true }));
 const root = join(directory, 'reference'), home = join(directory, 'home');
 await mkdir(home); await exportReference(resolve(import.meta.dirname, '..'), root);
 const pin = '0.0.1', pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
 pkg.engines.node = pin;
 await writeFile(join(root, 'package.json'), JSON.stringify(pkg));
 await writeFile(join(root, '.node-version'), pin);
 // Exports may retain a project-owned nvm declaration; keep the fixture coherent.
 try { await readFile(join(root, '.nvmrc')); await writeFile(join(root, '.nvmrc'), pin); } catch {}
 const trace = join(directory, 'requests.jsonl'), edge = join(directory, 'download-edge.mjs');
 await writeFile(edge, `import { appendFileSync } from 'node:fs';
globalThis.fetch = async url => {
 appendFileSync(${JSON.stringify(trace)}, JSON.stringify(url)+'\\n');
 if (process.env.NODE_EDGE_OFFLINE) throw Error('offline');
 return new Response(url.endsWith('SHASUMS256.txt') ? '0'.repeat(64)+'  node-v${pin}-'+process.platform+'-'+process.arch+'.tar.gz\\n' : 'Unverified bytes must never be extracted');
};\n`);
 const env = { ...process.env, HOME: home, CI: 'true', NODE_OPTIONS: `--import=${pathToFileURL(edge).href}` };
 delete env.RER_NODE_AUTO;
 const run = (args, extra = {}) => spawnSync(process.execPath, [join(root, 'scripts/rer.mjs'), args[0], '--cwd', root, '--json', ...args.slice(1)], { cwd: directory, env: { ...env, ...extra }, encoding: 'utf8', timeout: 15000 });
 for (const args of [['install', '--help'], ['install', '--unsupported']]) {
  const result = run(args);
  assert.equal(result.status, args.includes('--help') ? 0 : 2, result.stderr);
 }
 await assert.rejects(readFile(trace), { code: 'ENOENT' });
 const optedOut = run(['install'], { RER_NODE_AUTO: '0' });
 assert.equal(optedOut.status, 3); await assert.rejects(readFile(trace), { code: 'ENOENT' });
 for (const extra of [{ NODE_EDGE_OFFLINE: '1' }, {}]) {
  const result = run(['install'], extra);
  assert.equal(result.status, 3, result.stderr);
  const events = result.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1).ok, false); assert.equal(events.filter(event => event.event === 'result').length, 1);
  assert.equal(events.find(event => event.event === 'error').code, 'missing_input');
  assert.match(events.find(event => event.event === 'error').message, /npm exec .* -- node /);
  assert.deepEqual(await readdir(join(home, '.rer/node')), []);
  await assert.rejects(readFile(join(root, '.seed/installer/state.json')), { code: 'ENOENT' });
 }
 assert.ok((await readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse).every(url => url.startsWith('https://nodejs.org/dist/')));
 // Independently authored projects keep ownership of the contract and raw tail.
 const descriptor = JSON.parse(await readFile(join(root, 'OPERATIONS.json'), 'utf8'));
 delete descriptor.seedContract;
 await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify(descriptor));
 const secretArgument = 'https://service.invalid/?token=private-fixture';
 const privateFailure = run(['verify', '--', secretArgument], { RER_NODE_AUTO: '0' });
 assert.equal(privateFailure.status, 3);
 assert.ok(!privateFailure.stdout.includes(secretArgument));
});

// A runtime that has just passed its receipt check is the one place rer can tell
// a quarantine copy from a live one: the copy is stale, and include/ is unused.
test('using a verified cached Node release removes its stale quarantine copies and unused headers', async t => {
 const directory = await mkdtemp(join(tmpdir(), 'rer-node-tidy-'));
 t.after(() => rm(directory, { recursive: true, force: true }));
 const root = join(directory, 'reference'), home = join(directory, 'home'), pin = '0.0.2';
 await mkdir(home); await exportReference(resolve(import.meta.dirname, '..'), root);
 const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
 pkg.engines.node = pin;
 await writeFile(join(root, 'package.json'), JSON.stringify(pkg));
 await writeFile(join(root, '.node-version'), pin);
 try { await readFile(join(root, '.nvmrc')); await writeFile(join(root, '.nvmrc'), pin); } catch {}
 const cache = join(home, '.rer/node'), name = `node-v${pin}-${process.platform}-${process.arch}`, live = join(cache, name);
 await mkdir(join(live, 'bin'), { recursive: true, mode: 0o700 });
 for (const path of [join(home, '.rer'), cache, live, join(live, 'bin')]) await chmod(path, 0o700);
 const binary = join(live, 'bin/node');
 await writeFile(binary, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo v${pin}; fi\nexit 0\n`, { mode: 0o700 });
 await writeFile(join(live, '.rer-verified.json'), JSON.stringify({ version: pin, releaseSha256: 'a'.repeat(64), binarySha256: createHash('sha256').update(await readFile(binary)).digest('hex') }), { mode: 0o600 });
 await mkdir(join(live, 'include/node'), { recursive: true }); await writeFile(join(live, 'include/node/node.h'), '// headers');
 const quarantine = `${live}.quarantine-1791663661435`;
 await mkdir(join(quarantine, 'bin'), { recursive: true }); await writeFile(join(quarantine, 'bin/node'), 'old');
 const other = join(cache, 'node-v9.9.9-other.quarantine-1');
 await mkdir(other);
 const doctor = () => {
  const output = spawnSync(process.execPath, [join(root, 'scripts/rer.mjs'), 'doctor', '--cwd', root, '--json'], { cwd: directory, env: { ...process.env, HOME: home, RER_SERVERS_DIR: join(directory, 'servers') }, encoding: 'utf8', timeout: 60000 });
  return JSON.parse(output.stdout.trim().split('\n').find(line => line.includes('"diagnostics"'))).diagnostics.warnings;
 };
 // Doctor names the leftover copy and a second cached release before anything is removed.
 await mkdir(join(cache, 'node-v9.9.9-darwin-arm64'));
 const warned = doctor();
 assert.ok(warned.some(text => text.includes(`${name}.quarantine-1791663661435`) && text.includes('rm -r')), warned.join('\n'));
 assert.ok(warned.some(text => text.includes('holds 2 releases')), warned.join('\n'));
 await rm(join(cache, 'node-v9.9.9-darwin-arm64'), { recursive: true });
 const result = spawnSync(process.execPath, [join(root, 'scripts/rer.mjs'), 'dev', '--cwd', root, '--json'], { cwd: directory, env: { ...process.env, HOME: home, CI: 'true', RER_SERVERS_DIR: join(directory, 'servers') }, encoding: 'utf8', timeout: 60000 });
 assert.ok(result.stdout.includes('node-selection'), result.stdout + result.stderr);
 assert.deepEqual((await readdir(cache)).sort(), [name, 'node-v9.9.9-other.quarantine-1'].sort());
 assert.deepEqual((await readdir(live)).sort(), ['.rer-verified.json', 'bin']);
 assert.ok(doctor().every(text => !text.includes(`${name}.quarantine-`)), 'the removed copy is no longer reported');
});
