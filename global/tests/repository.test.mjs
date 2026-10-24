// Installed repository commands preserve release tags and stop at install/setup
// on one reused checkout. Every source and dependency below is local.
import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildPackage } from '../../scripts/rer-package.mjs';
import { run } from './harness.mjs';
import { isolatedQueue } from '../../cli/fixtures/queue.mjs';
import { offlineRepository } from './fixtures/offline-repository.mjs';

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

 // Without git, nothing is fetched: the refusal names the missing tool and how
 // to install it, with exit 3 and the stable code git_missing.
 const nodeOnly = join(directory, 'node-only');
 await mkdir(nodeOnly);
 await symlink(process.execPath, join(nodeOnly, 'node'));
 const noGit = await run(installed, ['dev', pathToFileURL(remote).href, '--dir', join(directory, 'no-git'), '--json'], { cwd: directory, env: { ...env, PATH: nodeOnly } });
 assert.equal(noGit.code, 3, noGit.stderr + noGit.stdout);
 assert.equal(JSON.parse(noGit.stdout.trim().split('\n')[0]).code, 'git_missing');
 await assert.rejects(access(join(directory, 'no-git')), 'nothing was cloned');
 // The source is not a runnable checkout, so the launch stops after the clone.
 const clone = join(directory, 'app');
 await run(installed, ['dev', pathToFileURL(remote).href, '--dir', clone], { cwd: directory, env });
 const checkout = await run('git', ['-C', clone, 'checkout', '--quiet', 'v1.0.0'], { env });
 assert.equal(checkout.code, 0, checkout.stderr);
 assert.equal((await run('git', ['-C', clone, 'show', 'HEAD:release.txt'], { env })).stdout, 'v1.0.0\n');
 assert.equal((await status()).channel, initial.channel, 'repository startup preserves the installed channel');
});

test('rer install <repo> then rer setup stop at their phases offline, reuse the clone and refuse another origin', { timeout: 60000 }, async t => {
 const directory = await mkdtemp(join(tmpdir(), 'rer-phases-'));
 const source = join(directory, 'source'), home = join(directory, 'home'), app = join(directory, 'app');
 t.after(() => rm(directory, { recursive: true, force: true }));
 await Promise.all([mkdir(source), mkdir(home)]);
 const env = await isolatedQueue(t, { PATH: process.env.PATH, HOME: home, CI: 'true',
  RER_NO_UPDATE_CHECK: '1', RER_NODE_AUTO: '0', RER_DOOR_DIR: join(directory, 'door'),
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  npm_config_store_dir: join(directory, 'store'), npm_config_offline: 'true',
  ...Object.fromEntries(['NODE_OPTIONS', 'TMPDIR', 'COREPACK_HOME'].filter(name => process.env[name]).map(name => [name, process.env[name]])),
 });
 const checked = async (program, args, cwd = directory) => {
  const result = await run(program, args, { cwd, env });
  assert.equal(result.code, 0, result.stderr + result.stdout);
  return result.stdout.trim();
 };
 const tarball = await buildPackage(base, join(directory, 'built'));
 const unpacked = join(directory, 'rer'); await mkdir(unpacked);
 await checked('tar', ['-xzf', tarball, '-C', unpacked]);
 await checked(process.execPath, [join(unpacked, 'package/global/rer.mjs'), 'cli', 'install']);
 const rer = join(home, '.local/bin/rer');
 await offlineRepository(source, tarball, args => checked('pnpm', args, source));
 const git = (cwd, ...args) => checked('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', ...args], cwd);
 await git(source, 'init', '--quiet'); await git(source, 'add', '.'); await git(source, 'commit', '--quiet', '-m', 'Offline repository');
 const remote = pathToFileURL(join(directory, 'app.git')).href;
 await git(source, 'clone', '--quiet', '--bare', source, join(directory, 'app.git'));
 const describe = async () => JSON.parse(await checked(rer, ['describe', '--cwd', app, '--json']));
 const exists = path => access(path).then(() => true, () => false);
 const listed = async () => JSON.parse(await checked(rer, ['list', directory, '--json'])).checkouts.find(entry => entry.name === 'app');

 await checked(rer, ['install', remote, '--dir', app]);
 assert.equal(await exists(join(app, 'node_modules/@runeditrun/rer/bin/rer.mjs')), true, 'install links the actual package');
 assert.equal(await exists(join(app, '.dev.vars')), false, 'install must not set up an owner');
 assert.equal((await describe()).local.prepared, false);
 const head = await git(app, 'rev-parse', 'HEAD');
 await writeFile(join(app, 'untracked-marker.txt'), 'kept');

 await checked(rer, ['setup', remote, '--dir', app, '--owner-email', 'owner@example.test']);
 assert.equal(await readFile(join(app, 'untracked-marker.txt'), 'utf8'), 'kept', 'setup reuses the clone');
 assert.equal(await git(app, 'rev-parse', 'HEAD'), head);
 assert.equal((await stat(join(app, '.dev.vars'))).mode & 0o777, 0o600);
 const prepared = (await describe()).local;
 assert.equal(prepared.prepared, true);
 assert.equal(new URL(prepared.origin).hostname, '127.0.0.1');
 assert.match(await readFile(join(app, '.dev.vars'), 'utf8'), /^OWNER_EMAIL=owner@example\.test$/m);
 const checkout = await listed();
 assert.deepEqual([checkout.prepared, checkout.url], [true, null], 'setup starts no server');
 const settings = await readFile(join(app, '.dev.vars'), 'utf8');
 await checked(rer, ['setup', remote, '--dir', app]);
 assert.equal(await readFile(join(app, '.dev.vars'), 'utf8'), settings, 'repeat setup keeps saved settings');

 const other = join(directory, 'other.git');
 await git(source, 'clone', '--quiet', '--bare', source, other);
 const refused = await run(rer, ['install', pathToFileURL(other).href, '--dir', app], { cwd: directory, env });
 assert.notEqual(refused.code, 0);
 assert.equal(await git(app, 'remote', 'get-url', 'origin'), remote);
 assert.equal(await readFile(join(app, 'untracked-marker.txt'), 'utf8'), 'kept');
 assert.equal(await readFile(join(app, '.dev.vars'), 'utf8'), settings);
});
