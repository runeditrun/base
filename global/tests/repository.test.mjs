// Installed repository commands preserve release tags and stop at install/setup
// on one reused checkout. Every source and dependency below is local.
import test from 'node:test';
import assert from 'node:assert/strict';
import { watch } from 'node:fs';
import { access, appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildPackage } from '../../scripts/rer-package.mjs';
import { run } from './harness.mjs';
import { isolatedQueue } from '../../cli/fixtures/queue.mjs';
import { offlineRepository } from './fixtures/offline-repository.mjs';
import { server } from '../../cli/fixtures/business/server.mjs';
import { setTimeout as delay } from 'node:timers/promises';

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

test('rer install <repo> then rer setup stop at their phases offline, reuse the clone and refuse another origin', { timeout: 60000 }, async t => {
 const directory = await mkdtemp(join(tmpdir(), '.business-connect-repository-'));
 const source = join(directory, 'source'), home = join(directory, 'home'), app = join(directory, 'app');
 const platform = await server(t); platform.state.pollSeconds = 1;
 t.after(() => rm(directory, { recursive: true, force: true }));
 await Promise.all([mkdir(source), mkdir(home)]);
 const env = await isolatedQueue(t, { PATH: process.env.PATH, HOME: home, CI: 'true',
  NODE_OPTIONS: `--import=${fileURLToPath(new URL('../../cli/fixtures/business/register.mjs', import.meta.url))}`,
  RER_NO_UPDATE_CHECK: '1', RER_NODE_AUTO: '0', RER_DOOR_DIR: join(directory, 'door'),
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  npm_config_store_dir: join(directory, 'store'), npm_config_offline: 'true',
  ...Object.fromEntries(['TMPDIR', 'COREPACK_HOME'].filter(name => process.env[name]).map(name => [name, process.env[name]])),
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

 const carry = join(app, '.rer/local/business.json'), observed = join(app, 'carry-observed.json');
 await appendFile(join(app, 'adapter.mjs'), `
import { readFile, writeFile } from 'node:fs/promises';
if (process.argv.includes('setup')) await writeFile('carry-observed.json', await readFile('.rer/local/business.json', 'utf8').catch(error => { if (error.code === 'ENOENT') return 'null'; throw error; }));
`);
 const pairing = run(rer, ['business', 'connect', '--code', 'ABCD-1234', '--origin', platform.origin], { cwd: directory, env });
 const until = Date.now() + 10000;
 while (!platform.state.requests.some(item => item.body.code) && Date.now() < until) await delay(25);
 assert.equal((await fetch(platform.origin + '/api/business/biz/pairings/pair1/approve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmed: true, confirmation_number: '246810' }) })).status, 200);
 const paired = await pairing; assert.equal(paired.code, 0, paired.stderr);
 assert.ok(!await exists(carry), 'connect has no carry to write without a live checkout');
 const selfReads = () => platform.state.requests.filter(item => item.route === '/api/business/executors/self' && item.method === 'GET').length;
 const beforeSetup = selfReads();
 await checked(rer, ['setup', remote, '--dir', app, '--owner-email', 'owner@example.test']);
 assert.equal(selfReads(), beforeSetup + 1, 'installed repository setup makes one self read');
 const firstCarry = await readFile(carry, 'utf8');
 assert.equal(await readFile(observed, 'utf8'), firstCarry, 'the pinned setup sees the carry before it loads its adapter');
 assert.equal(JSON.parse(firstCarry).name, 'synthetic-base-1');
 assert.equal((await stat(carry)).mode & 0o777, 0o600);
 assert.equal((await stat(join(app, '.rer/local'))).mode & 0o777, 0o700);
 t.diagnostic(await checked('ls', ['-ld', join(app, '.rer/local'), carry])); t.diagnostic(firstCarry.trim());

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
 const changes = [], watcher = watch(carry, event => changes.push(event));
 try {
  await checked(rer, ['setup', remote, '--dir', app]);
  await delay(100);
  assert.deepEqual(changes, [], 'an unchanged carry must not restart a watching seed');
 } finally { watcher.close(); }
 assert.equal(await readFile(join(app, '.dev.vars'), 'utf8'), settings, 'repeat setup keeps saved settings');
 assert.equal(await readFile(carry, 'utf8'), firstCarry, 'unchanged repository setup leaves carry byte-identical');
 platform.state.business.name = 'synthetic-base-2';
 const beforeLocalSetup = selfReads();
 await checked(rer, ['setup', '--cwd', app]);
 assert.equal(selfReads(), beforeLocalSetup + 1, 'installed checkout setup reads once even when delegated to a pinned launcher');
 const changedCarry = await readFile(carry, 'utf8');
 assert.equal(JSON.parse(changedCarry).name, 'synthetic-base-2');
 assert.equal(await readFile(observed, 'utf8'), changedCarry, 'checkout setup sees the refresh before the pinned verb runs');
 t.diagnostic(await checked('ls', ['-ld', join(app, '.rer/local'), carry])); t.diagnostic(changedCarry.trim());
 const beforeHelp = selfReads();
 await checked(rer, ['setup', '--help', '--cwd', app]);
 await checked(rer, ['dev', '--help', '--cwd', app]);
 await checked(rer, ['demo', '--help', '--cwd', app]);
 assert.equal(selfReads(), beforeHelp, 'help and demo help never refresh');
 await platform.close();
 const unreachable = await run(rer, ['setup', '--cwd', app], { cwd: directory, env });
 assert.equal(unreachable.code, 0, unreachable.stderr);
 assert.equal(await readFile(carry, 'utf8'), changedCarry, 'unreachable platform leaves carry byte-identical');
 const warnings = unreachable.stderr.trim().split('\n').filter(line => line.startsWith('Business carry at '));
 assert.equal(warnings.length, 1); assert.ok(warnings[0].includes(platform.origin));
 assert.ok(!unreachable.stderr.includes(platform.device)); t.diagnostic(warnings[0]);
 await rm(carry);
 const unpaired = await run(rer, ['setup', '--cwd', app], { cwd: directory, env: { ...env, RER_BUSINESS_STATE_DIR: join(directory, 'unpaired') } });
 assert.equal(unpaired.code, 0, unpaired.stderr);
 assert.ok(!await exists(carry), 'unpaired launch writes nothing');
 assert.equal(await readFile(observed, 'utf8'), 'null');
 t.diagnostic('unpaired setup: no carry; unreachable setup: exit 0 and unchanged bytes; repeated setup: unchanged bytes');


 const other = join(directory, 'other.git');
 await git(source, 'clone', '--quiet', '--bare', source, other);
 const refused = await run(rer, ['install', pathToFileURL(other).href, '--dir', app], { cwd: directory, env });
 assert.notEqual(refused.code, 0);
 assert.equal(await git(app, 'remote', 'get-url', 'origin'), remote);
 assert.equal(await readFile(join(app, 'untracked-marker.txt'), 'utf8'), 'kept');
 assert.equal(await readFile(join(app, '.dev.vars'), 'utf8'), settings);
});
