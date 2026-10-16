// The script channel through its public doors: the package's own install.sh and
// `rer update`, against a local registry serving the real package tarball.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { buildPackage } from '../../scripts/rer-package.mjs';
import { tarball } from '../../scripts/rer-package/tarball.mjs';
import { integrity, localRegistry } from '../../scripts/rer-package/registry.mjs';
import { readPackage } from '../update/archive.mjs';

const base = resolve(import.meta.dirname, '../..');

function run(program, args, env) {
 return new Promise((resolveRun, reject) => {
  const child = spawn(program, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
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
 return [...html.matchAll(/<pre[^>]*><code>([^<]*)<\/code><\/pre>/g)].map(match => match[1].replace(/&(amp|lt|gt|quot|#39);/g, entity => entities[entity]));
}

// The built package again under another version, optionally with extra raw entries.
function repack(entries, version, extra = []) {
 const files = entries.map(entry => ({ path: `package/${entry.path}`, data: entry.path === 'package.json' ? Buffer.from(JSON.stringify({ ...JSON.parse(entry.data), version }, null, 2) + '\n') : entry.data, executable: entry.executable }));
 return tarball([...files, ...extra], 0);
}

test('install.sh and rer update install verified registry releases, the Run page starts a seed on what install.sh installed, and a bad download leaves the current one', { timeout: 5 * 60_000 }, async t => {
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
 const installed = await run('sh', [installer], env);
 assert.equal(installed.code, 0, installed.stderr);
 assert.equal(await selected(), manifest.version);
 assert.deepEqual(await readdir(bin), ['node'], 'installation never writes into another writable PATH directory');
 const activate = output => output.split('\n').find(line => line.includes('export PATH='))?.split('export PATH=')[1];
 const hint = activate(installed.stdout);
 assert.ok(hint, installed.stdout);
 assert.equal((await run('sh', ['-c', `export PATH=${hint}\nrer --version`], env)).stdout.trim(), manifest.version);

 // The Run page's step 2 runs on what install.sh put on PATH and nothing else:
 // no npx and no Node on PATH. The private Node install.sh downloads when there
 // is none stands in as its runtime link.
 const commands = await runPageCommands(), installLine = commands.findIndex(command => /\| *sh$/.test(command));
 assert.ok(installLine >= 0 && commands.length > installLine + 1, `the Run page installs rer, then starts the seed: ${commands.join(' / ')}`);
 const runtime = join(home, '.local/share/rer/node'), installedOnly = { ...env, PATH: join(home, '.local/bin') };
 await symlink(dirname(dirname(process.execPath)), runtime);
 for (const command of commands.slice(installLine + 1)) {
  const program = command.split(/\s+/)[0], found = await run('/bin/sh', ['-c', `command -v '${program}'`], installedOnly);
  assert.equal(found.code, 0, `${program} (from "${command}") is not on the PATH install.sh gives`);
  const started = await run(found.stdout.trim(), ['--version'], installedOnly);
  assert.equal(started.code, 0, `${program} does not run on the PATH install.sh gives: ${started.stderr}`);
 }
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
 assert.equal((await run('sh', ['-c', `export PATH=${line}\nrer --version`], isolated)).stdout.trim(), release);
 assert.equal((await run(join(foreignBin, 'rer'), [], isolated)).stdout.trim(), 'foreign');
 const activeEnv = { ...isolated, PATH: `${join(isolated.HOME, '.local/bin')}:${isolated.PATH}` };
 const active = await run('sh', [installer], activeEnv);
 assert.equal(active.code, 0, active.stderr);
 assert.equal(activate(active.stdout), undefined, 'no activation needed when the installed launcher is first');
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
