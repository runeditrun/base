// rer install, setup and dev <repo> through the installed command's door: the clone
// it makes can check out an older release tag with no further fetch, and each verb
// stops at its documented phase on the same acquired checkout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildPackage } from '../../scripts/rer-package.mjs';
import { exportReference } from '../../scripts/export-reference.mjs';
import { run } from './harness.mjs';

const base = resolve(import.meta.dirname, '../..');

test('rer dev <repo> clones every release tag, so git checkout <tag> works in the clone', { timeout: 60000 }, async t => {
 const directory = await mkdtemp(join(tmpdir(), 'rer-clone-')), source = join(directory, 'source'), home = join(directory, 'home');
 t.after(() => rm(directory, { recursive: true, force: true }));
 await Promise.all([mkdir(source), mkdir(home)]);
 // The packed rer, as a person installs it.
 const unpacked = join(directory, 'rer');
 await mkdir(unpacked);
 assert.equal((await run('tar', ['-xzf', await buildPackage(base, join(directory, 'built')), '-C', unpacked])).code, 0);
 const rer = join(unpacked, 'package/global/rer.mjs');
 const env = { PATH: process.env.PATH, HOME: home, RER_NO_UPDATE_CHECK: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
 assert.equal((await run(process.execPath, [rer, 'cli', 'install'], { env: { ...env, RER_INSTALL_CHANNEL: 'script' } })).code, 0);
 const installed = join(home, '.local/bin/rer');
 const status = async () => JSON.parse((await run(installed, ['cli', 'status', '--json'], { env })).stdout);
 const initial = await status();
 const git = async (...args) => { const result = await run('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', ...args], { cwd: source, env }); assert.equal(result.code, 0, result.stderr); return result.stdout.trim(); };
 await git('init', '--quiet');
 await writeFile(join(source, 'release.txt'), 'v1.0.0\n');
 await git('add', '.'); await git('commit', '--quiet', '-m', 'First release'); await git('tag', 'v1.0.0');
 await writeFile(join(source, 'release.txt'), 'main\n');
 await git('commit', '--quiet', '-am', 'Later work');
 const remote = join(directory, 'app.git');
 await git('clone', '--quiet', '--bare', source, remote);

 // The source is not a runnable checkout, so the launch stops after the clone.
 const clone = join(directory, 'app');
 await run(installed, ['dev', pathToFileURL(remote).href, '--dir', clone], { cwd: directory, env });
 const checkout = await run('git', ['-C', clone, 'checkout', '--quiet', 'v1.0.0'], { env });
 assert.equal(checkout.code, 0, checkout.stderr);
 assert.equal((await run('git', ['-C', clone, 'show', 'HEAD:release.txt'], { env })).stdout, 'v1.0.0\n');
 assert.equal((await status()).channel, initial.channel, 'repository startup preserves the installed channel');
});

test('rer install <repo> then rer setup <repo> stop at their phases on one reused clone and refuse another origin', { timeout: 300000 }, async t => {
 const directory = await mkdtemp(join(tmpdir(), 'rer-phases-')), source = join(directory, 'source'), home = join(directory, 'home'), app = join(directory, 'app');
 t.after(() => rm(directory, { recursive: true, force: true }));
 await mkdir(home);
 const unpacked = join(directory, 'rer');
 await mkdir(unpacked);
 assert.equal((await run('tar', ['-xzf', await buildPackage(base, join(directory, 'built')), '-C', unpacked])).code, 0);
 // Resolve the prepared dependency store before isolating HOME, and never fetch
 // missing packages during this local repository journey.
 const store = await run('pnpm', ['store', 'path'], { cwd: join(base, 'default-seed') });
 assert.equal(store.code, 0, store.stderr);
 const env = { PATH: process.env.PATH, HOME: home, RER_NO_UPDATE_CHECK: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', CI: 'true',
  npm_config_store_dir: store.stdout.trim(), npm_config_offline: 'true',
  RER_JOBS_DIR: join(directory, 'jobs'), RER_SERVERS_DIR: join(directory, 'servers'), RER_JOBS_LOAD_THRESHOLD: '100000', RER_JOBS_MIN_FREE_MEMORY_BYTES: '0', RER_SERVERS_LOAD_THRESHOLD: '100000', RER_SERVERS_MIN_MEMORY_BYTES: '0' };
 assert.equal((await run(process.execPath, [join(unpacked, 'package/global/rer.mjs'), 'cli', 'install'], { env: { ...env, RER_INSTALL_CHANNEL: 'script' } })).code, 0);
 const rer = join(home, '.local/bin/rer');
 const git = async (cwd, ...args) => { const result = await run('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', ...args], { cwd, env }); assert.equal(result.code, 0, result.stderr); return result.stdout.trim(); };
 // A runnable edition behind a local remote: the same reference a person clones.
 await exportReference(base, source);
 await git(source, 'init', '--quiet'); await git(source, 'add', '-A'); await git(source, 'commit', '--quiet', '-m', 'Reference');
 const remote = pathToFileURL(join(directory, 'app.git')).href;
 await git(source, 'clone', '--quiet', '--bare', source, join(directory, 'app.git'));
 const exists = path => access(path).then(() => true, () => false);
 const listed = async () => JSON.parse((await run(rer, ['list', directory, '--json'], { cwd: directory, env })).stdout).checkouts.find(entry => entry.name === 'app');

 const installed = await run(rer, ['install', remote, '--dir', app], { cwd: directory, env });
 assert.equal(installed.code, 0, installed.stderr);
 assert.equal(await exists(join(app, 'node_modules')), true, 'install installs the dependencies');
 assert.equal(await exists(join(app, '.dev.vars')), false, 'install sets up no owner');
 assert.equal((await listed()).prepared, false);
 const head = await git(app, 'rev-parse', 'HEAD');
 await writeFile(join(app, 'untracked-marker.txt'), 'kept');

 const prepared = await run(rer, ['setup', remote, '--dir', app], { cwd: directory, env });
 assert.equal(prepared.code, 0, prepared.stderr);
 assert.equal(await readFile(join(app, 'untracked-marker.txt'), 'utf8'), 'kept', 'setup reuses the clone instead of cloning again');
 assert.equal(await git(app, 'rev-parse', 'HEAD'), head);
 assert.equal((await stat(join(app, '.dev.vars'))).mode & 0o777, 0o600, 'setup writes the owner settings privately');
 const checkout = await listed();
 assert.deepEqual([checkout.prepared, checkout.url], [true, null], 'set up, and nothing is started');

 const settings = await readFile(join(app, '.dev.vars'), 'utf8');
 assert.equal((await run(rer, ['setup', remote, '--dir', app], { cwd: directory, env })).code, 0, 'setting up again resumes');
 assert.equal(await readFile(join(app, '.dev.vars'), 'utf8'), settings, 'the saved settings are kept');

 // Another origin never takes over this folder.
 const other = join(directory, 'other.git');
 await git(source, 'clone', '--quiet', '--bare', source, other);
 const refused = await run(rer, ['install', pathToFileURL(other).href, '--dir', app], { cwd: directory, env });
 assert.notEqual(refused.code, 0, 'a folder holding another repository is refused');
 assert.equal(await git(app, 'remote', 'get-url', 'origin'), remote, 'its origin is untouched');
 assert.equal(await readFile(join(app, 'untracked-marker.txt'), 'utf8'), 'kept');
});
