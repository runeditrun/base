import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, Server } from 'node:http';
import { createHash } from 'node:crypto';
import { server, classificationSchema } from './fixtures/business/server.mjs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { buildPackage } from '../scripts/rer-package.mjs';
import { integrity, localRegistry } from '../scripts/rer-package/registry.mjs';
import { readPackage, writePackage } from '../global/update/archive.mjs';
import { userInfo } from 'node:os';
import { realpath } from 'node:fs/promises';
import { identity } from '../modules/job-queue/identity.mjs';
import { appSignInHelp } from './app-address.mjs';

const base = resolve(import.meta.dirname, '..');
const fixture = join(import.meta.dirname, 'fixtures/business');
let directory, launcher, packed;
before(async () => {
 directory = await mkdtemp(join(base, '.business-connect-'));
 const bytes = await readFile(await buildPackage(base, join(directory, 'package')));
 const files = readPackage(bytes, { integrity: integrity(bytes) });
 // The same tarball, for npx through a loopback registry.
 packed = { bytes, version: JSON.parse(files.find(file => file.path === 'package.json').data).version };
 await writePackage(files, join(directory, 'packed'));
 launcher = join(directory, 'packed', 'global/rer.mjs');
});
after(() => directory && rm(directory, { recursive: true, force: true }));

// npx: the command as the platform's prompt gives it, in its own process group
// as a terminal starts it, so a signal to the group reaches npx and rer alike.
async function cli(home, args, { terminal = false, npx = false, installed = false, input = '', columns = 120, onSpawn, onOutput, env: extra = {}, path = process.env.PATH } = {}) {
 await mkdir(home, { recursive: true });
 const env = { PATH: path, HOME: home, RER_NO_UPDATE_CHECK: '1', NODE_OPTIONS: `--import=${fileURLToPath(new URL('./fixtures/business/register.mjs', import.meta.url))}`, TEST_COLUMNS: String(columns), ...extra };
 return new Promise((resolveRun, reject) => {
  const command = terminal ? 'python3' : npx ? 'npx' : installed ? join(home, '.local/bin/rer') : process.execPath;
  const parameters = terminal ? [join(fixture, 'terminal.py'), process.execPath, launcher, ...args] : npx ? ['-y', '@runeditrun/rer', ...args] : installed ? args : [launcher, ...args];
  const child = spawn(command, parameters, { cwd: home, env, stdio: ['pipe','pipe','pipe'], detached: npx });
  onSpawn?.(child);
  let stdout = '', stderr = '';
  const timer = setTimeout(() => child.kill('SIGKILL'), 40000);
  child.stdout.on('data', chunk => { stdout += chunk; onOutput?.(stdout, child); });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.once('error', error => { clearTimeout(timer); reject(error); });
  child.once('close', code => { clearTimeout(timer); resolveRun({ code, stdout, stderr }); });
  child.stdin.end(input);
 });
}
test('Business entry points expose setup before advanced commands and preserve the selected pairing destination', async t => {
 const home = join(directory, 'handoff-home');
 const outputs = await Promise.all([['business'], ['business', '--help'], ['business', 'next', '--help'], ['business', 'done', '--help']].map(args => cli(home, args)));
 for (const result of outputs) {
  assert.equal(result.code, 0);
  assert.equal(result.stdout.split('\n').filter(line => line === appSignInHelp).length, 1);
  const [lead, ...secondary] = result.stdout.trim().split(/\n\s*\n/);
  assert.equal(lead.match(/\brer business connect\b/g)?.length, 1, 'one setup action leads help');
  assert.ok(!/^\s*token(?:\s|$)/m.test(lead), 'advanced commands stay out of the lead');
  assert.ok(secondary.some(section => /^\S[^\n]*\n/.test(section) && /^ +token(?:\s|$)/m.test(section)),
   'the token command remains in a separate, headed section after setup');
 }
 const remote = await fixtureServer(t);
 for (const terminal of [false, true]) {
  const result = await cli(home, ['business', 'connect', '--origin', remote.origin], { terminal });
  assert.equal(result.code, 1, 'the no-code handoff does not redeem or alter pairing');
  const text = result.stdout + result.stderr;
  const urls = text.match(/https?:\/\/[^\s;]+/g);
  assert.deepEqual(urls, [remote.origin + '/business'], 'one browser link, for the selected app');
  assert.ok(!text.includes('app.runeditrun.com'), 'an explicitly selected app is preserved');
  assert.equal(remote.state.requests.length, 0);
 }
});

test('Business verb help explains each command without pairing or reading a session file', async t => {
 const home = join(directory, 'verb-help-home');
 for (const verb of ['setup', 'connect', 'run', 'token']) {
  const result = await cli(home, ['business', verb, '--help']);
  t.diagnostic(`rer business ${verb} --help\n${result.stdout}`);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`Usage: rer business ${verb}(?:\\s|$)`));
  if (verb === 'setup') {
   assert.equal(result.stdout.split('\n').filter(line => line === appSignInHelp).length, 1);
   assert.match(result.stdout, /--session-file FILE[^\n]*signed-in session/i);
   assert.match(result.stdout, /Create the Business[^\n]*demo company/i);
  }
 }
 const badOrigin = await cli(home, ['business', 'connect', '--origin', 'http://example.test']);
 assert.equal(badOrigin.code, 1);
 assert.match(badOrigin.stderr, /origin must be an HTTPS origin.*HTTP is allowed only on loopback/);
 assert.ok(!badOrigin.stderr.includes('Advanced commands'));
 assert.deepEqual(await readdir(home), [], 'help creates no pairing or credentials');
});

test('Business check-ins carry listed prepared and live apps, preserve settings and explain skipped apps', async t => {
 const remote = await fixtureServer(t), home = join(directory, 'unread-carry-home');
 const checkout = join(home, 'scratch-app'), live = join(home, 'live-app'), registry = join(home, 'registry');
 const carryFile = root => join(root, '.rer/local/business.json');
 for (const root of [checkout, live]) {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify({ version: 2, seedContract: { profile: 'first-party' } }));
  await writeFile(join(root, 'settings.json'), JSON.stringify({ name: 'Owner app name', accent: '#123456' }));
  await mkdir(join(root, 'scripts'));
  await writeFile(join(root, 'scripts/rer.mjs'), `process.stdout.write(JSON.stringify({ local: { prepared: true } }));`);
 }
 await mkdir(registry);
 const settings = await readFile(join(checkout, 'settings.json'), 'utf8');
 const owner = await identity(); t.after(() => owner.close());
 const register = roots => writeFile(join(registry, 'state.json'), JSON.stringify({ running: roots.map(checkout => ({ checkout, mode: 'dev', owner: owner.info })) }));
 const env = { RER_SERVERS_DIR: registry };
 await register([live]); // scratch-app is prepared on disk, never started or carried.
 const skipped = join(home, 'independent-app');
 await mkdir(skipped);
 await writeFile(join(skipped, 'OPERATIONS.json'), JSON.stringify({ version: 2, commands: {} }));
 const unprepared = join(home, 'unprepared-app');
 await mkdir(join(unprepared, 'scripts'), { recursive: true });
 await writeFile(join(unprepared, 'OPERATIONS.json'), JSON.stringify({ version: 2, seedContract: { profile: 'first-party' } }));
 await writeFile(join(unprepared, 'scripts/rer.mjs'), `process.stdout.write(JSON.stringify({ local: { prepared: false } }));`);
 const interrupted = join(home, 'interrupted-app'), broken = join(home, 'broken-app');
 for (const root of [interrupted, broken]) {
  await mkdir(join(root, 'scripts'), { recursive: true });
  await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify({ version: 2, seedContract: { profile: 'first-party' } }));
 }
 await writeFile(join(interrupted, 'scripts/rer.mjs'), `process.stdout.write(JSON.stringify({ local: { prepared: true } }));`);
 const launch = join(registry, 'launches', `interrupted-app-${createHash('sha256').update(interrupted).digest('hex').slice(0, 12)}`);
 await mkdir(launch, { recursive: true });
 await writeFile(join(launch, 'setup.json'), JSON.stringify({ state: 'running', at: Date.now() }));
 await register([live, interrupted]); // A live registry entry cannot finish setup.
 await writeFile(join(broken, 'scripts/rer.mjs'), `console.error('synthetic describe cause'); process.exit(7);`);
 const listed = await cli(home, ['list', '--json'], { env });
 assert.equal(listed.code, 0, listed.stderr);
 assert.ok(JSON.parse(listed.stdout).checkouts.some(app => app.path === checkout && app.profile === 'first-party' && app.launchable && app.prepared));
 const apps = JSON.parse(listed.stdout).checkouts;
 assert.equal(apps.find(app => app.path === interrupted).prepared, false);
 const cause = apps.find(app => app.path === broken).reason;
 assert.match(cause, /rer describe fails here: synthetic describe cause/);
 const unpaired = await cli(home, ['business', 'next'], { env });
 assert.equal(unpaired.code, 1);
 for (const root of [checkout, live]) await assert.rejects(stat(carryFile(root)), { code: 'ENOENT' });
 // connect and browser approval are the existing opt-in to carry; the three
 // independent computer permissions do not decide Business profile sharing.
 remote.state.optIns = { installPermissions: false, awakeConsent: false, installService: false };
 const paired = await connect(home, remote, { env });
 assert.ok(paired.stdout.includes('2 local app carry files'), paired.stdout);
 assert.ok(paired.stderr.includes(JSON.stringify(skipped)) && paired.stderr.includes('not first-party'), paired.stderr);
 assert.ok(paired.stderr.includes(JSON.stringify(unprepared)) && paired.stderr.includes('not set up yet: run rer setup'), paired.stderr);
 await assert.rejects(stat(carryFile(unprepared)), { code: 'ENOENT' });
 for (const root of [interrupted, broken]) await assert.rejects(stat(carryFile(root)), { code: 'ENOENT' });
 assert.ok(paired.stderr.includes(JSON.stringify(interrupted)) && paired.stderr.includes('not set up yet'), paired.stderr);
 assert.ok(paired.stderr.includes(cause), paired.stderr);
 t.diagnostic(`interrupted-app: list prepared=false; carry skipped (not set up); broken-app: ${cause} in list and carry`);
 t.diagnostic(`listed stopped checkout received carry; skipped ${skipped}: not first-party`);
 await register([live]); // The first checkout is stopped, but custody remains in carried.json.
 const first = await readFile(carryFile(checkout), 'utf8');
 for (const args of [['next'], ['run', '--once']]) {
  remote.state.business = { ...remote.state.business, name: `synthetic-base-${args[0]}`, brand_color: args[0] === 'next' ? '#AABBCC' : '#112233', logo_url: 'https://example.test/logo.png' };
  const result = await cli(home, ['business', ...args], { env });
  t.diagnostic(`rer business ${args.join(' ')}\n${result.stdout}`);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.stdout.includes('2 local app carry files'), result.stdout);
  assert.doesNotMatch(result.stdout + result.stderr, /now show/i);
  for (const root of [checkout, live]) {
   assert.ok(result.stdout.includes(carryFile(root)), result.stdout);
   const carried = JSON.parse(await readFile(carryFile(root), 'utf8'));
   assert.deepEqual([carried.name, carried.accent, carried.logo_url], [remote.state.business.name, remote.state.business.brand_color.toLowerCase(), remote.state.business.logo_url]);
   assert.equal(await readFile(join(root, 'settings.json'), 'utf8'), settings, 'app-owned and user-edited settings are preserved');
   assert.equal((await stat(carryFile(root))).mode & 0o777, 0o600);
  }
 }
 assert.notEqual(await readFile(carryFile(checkout), 'utf8'), first);
 const current = new Map(await Promise.all([checkout, live].map(async root => [root, await readFile(carryFile(root), 'utf8')])));
 for (const args of [['next'], ['run', '--once'], ['run', '--once']]) {
  const result = await cli(home, ['business', ...args], { env });
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.stdout.includes('No local app carry files changed'), result.stdout);
  assert.ok(!result.stdout.includes('Refreshed ') && !result.stdout.includes('Wrote '), result.stdout);
  for (const root of [checkout, live]) assert.equal(await readFile(carryFile(root), 'utf8'), current.get(root), 'no-change check-ins preserve bytes and refreshed_at');
 }
 assert.equal((await cli(home, ['business', 'disconnect'], { env })).code, 0);
 assert.equal((await cli(home, ['business', 'next'], { env })).code, 1);
 for (const root of [checkout, live]) {
  await assert.rejects(stat(carryFile(root)), { code: 'ENOENT' });
  assert.equal(await readFile(join(root, 'settings.json'), 'utf8'), settings, 'opting out removes only carry');
 }
});

test('failed scans name Retry while consent-pending scans still ask for permission', async t => {
 const remote = await fixtureServer(t), home = join(directory, 'scan-state-home');
 await connect(home, remote);
 for (const verb of [['next'], ['run', '--once']]) {
  remote.state.localScan = { allowed: false, paths: [], state: 'blocked' };
  const pending = await cli(home, ['business', ...verb]);
  assert.equal(pending.code, 0, pending.stderr);
  assert.match(pending.stdout, /Waiting for the owner to allow scanning/);
  assert.doesNotMatch(pending.stdout, /Retry/);
  remote.state.localScan = { allowed: true, paths: [home], state: 'failed' };
  const failed = await cli(home, ['business', ...verb]);
  assert.equal(failed.code, 0, failed.stderr);
  assert.match(failed.stdout, /scan failed/);
  assert.match(failed.stdout, /Retry on Your tools/);
  assert.doesNotMatch(failed.stdout, /They allow it/);
  t.diagnostic(`${verb.join(' ')}: consent pending asks for permission; failed scan names Retry on Your tools`);
 }
});

test('Business next echoes the installed launcher or npx invocation and open choices appear once per run', async t => {
 const remote = await fixtureServer(t), home = join(directory, 'echo-home');
 await connect(home, remote);
 const installed = await cli(home, ['cli', 'install']);
 assert.equal(installed.code, 0, installed.stderr);
 const bin = join(home, '.local/bin');
 const result = await cli(home, ['business', 'next'], { installed: true, path: `${bin}:${process.env.PATH}` });
 assert.equal(result.code, 0, result.stderr);
 assert.match(result.stdout, /run rer business next/);
 assert.doesNotMatch(result.stdout, /npx -y/);
 const registry = await localRegistry(); t.after(registry.close);
 registry.publish(packed.version, packed.bytes);
 const npx = await cli(home, ['business', 'next'], { npx: true, path: `${bin}:${process.env.PATH}`, env: { 'npm_config_@runeditrun:registry': `${registry.url}/`, npm_config_cache: join(home, 'npm-cache'), npm_config_audit: 'false', npm_config_fund: 'false' } });
 assert.equal(npx.code, 0, npx.stderr);
 assert.match(npx.stdout, /run npx -y @runeditrun\/rer business next/);
 assert.equal(result.stdout.match(/The owner has not chosen yet:/g)?.length, 1);
 assert.equal(npx.stdout.match(/The owner has not chosen yet:/g)?.length, 1);
 // The undecided set changes between check-ins in the same long-running command.
 let checks = 0, runner;
 remote.state.onSelf = async () => {
  remote.state.optIns = ++checks === 1 ? {} : { awakeConsent: false };
  if (checks === 2) setTimeout(() => runner.kill('SIGTERM'), 250);
 };
 const running = await cli(home, ['business', 'run'], { onSpawn: child => { runner = child; } });
 assert.equal(running.code, 0, running.stderr);
 assert.equal(running.stdout.match(/The owner has not chosen yet:/g)?.length, 1);
 assert.equal(checks, 2);
 assert.equal(running.stdout.match(/No local app carry files changed/g)?.length, 1);
 assert.equal(running.stdout.match(/No local apps were found/g)?.length, 1);
 t.diagnostic('unchanged empty carry set: 2 check-ins; 1 summary; 1 no-local-apps line');
 t.diagnostic('installed: rer business next; npx: npx -y @runeditrun/rer business next; changing open choices printed once');
});

test('two Businesses on one origin revoke independently in either order and legacy origin keys revoke once', async t => {
 const remotes = await Promise.all(['one', 'two'].map(businessId => server(t, { businessId })));
 for (const remote of remotes) { remote.state.pollSeconds = 1; remote.state.optIns = { installPermissions: false, awakeConsent: false, installService: false }; }
 let selected = remotes[0];
 const proxy = createServer(async (req, res) => {
  const remote = remotes.find(remote => req.headers.authorization === `Bearer ${remote.device}`) ?? selected;
  let body = ''; for await (const chunk of req) body += chunk;
  const response = await fetch(remote.origin + req.url, { method: req.method, headers: { 'content-type': 'application/json', ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}) }, ...(body ? { body } : {}) });
  res.writeHead(response.status, { 'content-type': 'application/json' }); res.end(await response.text());
 });
 await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
 t.after(() => new Promise(resolve => { proxy.close(resolve); proxy.closeAllConnections(); }));
 const origin = `http://127.0.0.1:${proxy.address().port}`;
 for (const order of [[0, 1], [1, 0]]) {
  const home = join(directory, `two-business-${order.join('')}`), envs = remotes.map((_, i) => ({ RER_BUSINESS_STATE_DIR: join(home, `business-${i}`) }));
  for (const [i, remote] of remotes.entries()) {
   selected = remote;
   const paired = await connectWhile(home, ['--code', 'ABCD-1234', '--origin', origin], () => approve(remote), { env: envs[i] });
   assert.equal(paired.code, 0, paired.stderr);
  }
  assert.equal(Object.keys(JSON.parse(await readFile(join(home, 'fake-keychain.json'), 'utf8'))).length, 2);
  for (const i of order) {
   const revoked = await cli(home, ['business', 'disconnect'], { env: envs[i] });
   assert.equal(revoked.code, 0, revoked.stderr);
   assert.match(revoked.stdout, /Device revoked/);
  }
  await assert.rejects(stat(join(home, 'fake-keychain.json')), { code: 'ENOENT' });
  t.diagnostic(`two Businesses on one origin: disconnect order ${order.join(',')}: Device revoked twice`);
 }
 const home = join(directory, 'legacy-key-home'); selected = remotes[0];
 const paired = await connectWhile(home, ['--code', 'ABCD-1234', '--origin', origin], () => approve(selected));
 assert.equal(paired.code, 0, paired.stderr);
 const { credentialHandle } = await import('./business/state.mjs');
 const path = join(home, '.rer/business/state.json'), state = JSON.parse(await readFile(path, 'utf8'));
 delete state.credentialVersion; await writeFile(path, JSON.stringify(state));
 await writeFile(join(home, 'fake-keychain.json'), JSON.stringify({ [credentialHandle(origin)]: selected.device }));
 const revoked = await cli(home, ['business', 'disconnect']);
 assert.equal(revoked.code, 0, revoked.stderr); assert.match(revoked.stdout, /Device revoked/);
 const again = await cli(home, ['business', 'disconnect']);
 assert.equal(again.code, 0, again.stderr); assert.match(again.stdout, /Nothing was revoked/);
 t.diagnostic('legacy per-origin key: Device revoked once; a repeat revokes nothing');
});

// The fixture answers polls every second instead of the platform's five.
async function fixtureServer(t) {
 const remote = await server(t);
 remote.state.pollSeconds = 1;
 return remote;
}
const deviceOwner = (remote, action) => fetch(`${remote.origin}/api/business/${remote.state.business.id}/device-pairings/${remote.state.devicePairing.id}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_code: remote.state.devicePairing.user_code }) });
const approve = remote => remote.state.devicePairing ? deviceOwner(remote, 'approve') : fetch(remote.origin + '/api/business/biz/pairings/pair1/approve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmed: true, confirmation_number: '246810' }) });
const starts = remote => remote.state.requests.filter(entry => entry.route === '/api/business/executors/device-pairings' || entry.route === '/api/business/executors/pair' && entry.body.code).length;
const waiting = 'Keep this command running.';
// Runs connect in the foreground and, once it prints the number and waits,
// calls act(child) (approve, interrupt or nothing). Resolves with the finished run.
async function connectWhile(home, args, act, options = {}) {
 let printed;
 const shown = new Promise(resolve => { printed = resolve; });
 const run = cli(home, ['business', 'connect', ...args], { ...options, onOutput: (stdout, child) => { if (stdout.includes(waiting)) printed(child); } });
 const child = await Promise.race([shown, run.then(() => null)]);
 if (child) await act(child);
 return run;
}
async function connect(home, remote, options = {}) {
 const startCount = () => starts(remote);
 const before = startCount(), stateDir = options.env?.RER_BUSINESS_STATE_DIR ?? join(home, '.rer/business');
 remote.state.onSelf = async () => {
  const saved = JSON.parse(await readFile(join(stateDir, 'state.json'), 'utf8'));
  assert.equal(saved.executorId, 'executor1');
  assert.ok((await readFile(join(home, 'fake-keychain.json'), 'utf8')).includes(remote.device), 'credential is stored before activation');
 };
 const result = await connectWhile(home, ['--business',remote.state.business.id,'--origin',remote.origin], async () => {
  assert.equal(remote.state.active, false, 'an unapproved computer is not active');
  assert.equal((await stat(join(stateDir, 'pairing.json'))).mode & 0o777, 0o600, 'the pairing is saved before waiting');
  await approve(remote);
 }, options);
 remote.state.onSelf = null;
 assert.equal(startCount(), before + 1, 'one run starts one pairing and collects its approval');
 // The start request names the computer plainly and the folder connect ran in.
 const redeeming = remote.state.requests.filter(entry => entry.route === '/api/business/executors/device-pairings').at(-1).body;
 assert.ok(typeof redeeming.device_name === 'string' && /^[^\x00-\x1f\x7f/\\]{1,64}$/.test(redeeming.device_name) && redeeming.device_name === redeeming.device_name.trim(), `device_name is a plain name of at most 64 characters: ${redeeming.device_name}`);
 assert.ok(!redeeming.device_name.toLowerCase().includes(userInfo().username.toLowerCase()) || userInfo().username.length < 2, 'the name carries no login name');
 assert.equal(redeeming.working_folder, await realpath(home), 'working_folder is the absolute folder connect ran in');
 assert.match(result.stdout, /^Code: [2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}\r?\nApprove at: http:\/\/127\.0\.0\.1:\d+\/business\/biz\/pair#[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}\r?\n/);
 assert.equal(result.code, 0, `connect waits and exits 0 once approved and active: ${result.stderr}`);
 assert.equal(remote.state.active, true, 'exit 0 means the server has seen the computer');
 assert.ok(result.stdout.includes('This computer is connected to Business'), result.stdout);
 assert.ok(!result.stdout.includes(remote.device) && !result.stderr.includes(remote.device), 'device credential stays out of both streams');
 return result;
}

test('packed CLI pairs only after browser approval and keeps keys and untrusted task text out of agent output', async t => {
 const remote = await fixtureServer(t), home = join(directory, 'pair-home');
 await connect(home, remote);
 remote.state.root = join(home, 'canary-tree');
 await mkdir(join(remote.state.root, 'secrets'), { recursive: true });
 await writeFile(join(remote.state.root, 'package.json'), JSON.stringify({ dependencies: { 'fixture-library': 'fixture-private-version-never-export' } }));
 await mkdir(join(remote.state.root, '.github/workflows'), { recursive: true });
 await writeFile(join(remote.state.root, '.github/workflows/deploy-stage.yml'), 'jobs:\n  deploy:\n    env:\n      TOKEN: ${{ secrets.FIXTURE_CI_API_TOKEN }}\n');
 await writeFile(join(remote.state.root, '.env'), 'FIXTURE_PROVIDER_KEY=fixture-env-never-export');
 await writeFile(join(remote.state.root, 'secrets/credential.json'), 'fixture-denied-value-never-export');
 remote.state.tasks = [{ task_id: 'biz:discover-local', kind: 'discover.local', state: 'ready', runner: 'executor', fence: 0 }];
 remote.state.destination = '/api/business/tasks/biz:discover-local/uploads';
 const discovered = await cli(home, ['business','run','--once']);
 assert.equal(discovered.code, 0, discovered.stderr); assert.equal(remote.state.phase, 'done');
 const outbound = JSON.stringify(remote.state.requests) + discovered.stdout + discovered.stderr;
 for (const canary of ['fixture-private-version-never-export','fixture-env-never-export','fixture-denied-value-never-export']) assert.ok(!outbound.includes(canary), 'private canary values stay out of uploads, events and both output streams');
 assert.ok(remote.state.uploads.some(document => document.signals.some(signal => signal.value === 'fixture-library')));
 assert.ok(remote.state.uploads.some(document => document.signals.some(signal => signal.value === 'FIXTURE_CI_API_TOKEN')), 'ordinary workflow paths survive scanner and upload detection');
 delete remote.state.destination;
 remote.state.tasks = [{ task_id: 'biz:encoded-local', kind: 'discover.local', state: 'ready', runner: 'executor', fence: 0 }];
 assert.equal((await cli(home, ['business','run','--once'])).code, 0, 'percent-encoded task upload destination also works');
 for (const destination of [
  'https://other.invalid/api/business/tasks/biz:bad-local/uploads',
  remote.origin + '/api/business/tasks/biz:bad-local/uploads',
  '/api/business/tasks/another-task/uploads', '/api/business/tasks/biz:bad-local/events',
  '/api/business/tasks/biz:bad-local%2Fuploads', '/api/business/tasks/biz:bad-local/uploads?extra=1',
  '/api/business/tasks/biz:bad-local/uploads#extra', '/api/business/tasks/biz%ZZ/uploads',
 ]) {
  remote.state.tasks = [{ task_id: 'biz:bad-local', kind: 'discover.local', state: 'ready', runner: 'executor', fence: 0 }];
  remote.state.destination = destination;
  const uploaded = remote.state.uploads.length;
  const refused = await cli(home, ['business','run','--once']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /invalid upload destination/, `refused ${destination}; phase=${remote.state.phase}; released=${remote.state.released?.reason}`);
  assert.equal(remote.state.uploads.length, uploaded);
  assert.equal(remote.state.released.reason, 'failed', 'invalid destinations are reported through the failure call');
  assert.equal(remote.state.phase, 'failed', 'failed tasks do not stay leased');
 }
 delete remote.state.destination;
 const stored = await readFile(join(home, '.rer/business/state.json'), 'utf8');
 assert.ok(!stored.includes(remote.device), 'only handles belong in configuration');
 const question = { tool_id: 'tool1', vendor_id: 'sentry', answer_schema: classificationSchema };
 remote.state.tasks = [{ task_id: 'question1', kind: 'classify.row', state: 'ready', runner: 'executor', fence: 0, question, instruction: 'untrusted-run-command-canary' }];
 for (const columns of [160,43]) {
  const next = await cli(home, ['business','next'], { terminal: true, columns });
  assert.equal(next.code, 0); assert.ok(next.stdout.includes('question1')); assert.ok(!next.stdout.includes('untrusted-run-command-canary'));
 }
 remote.state.refuseQuestion = true;
 const rejected = await cli(home, ['business','answer','question1','sentry','uses']);
 assert.equal(rejected.code, 1); assert.equal(remote.state.questionReleased, true, 'a refused enum completion does not strand its lease');
 remote.state.refuseQuestion = false;
 remote.state.tasks = [{ task_id: 'question2', kind: 'classify.row', state: 'ready', runner: 'executor', fence: 0, question }];
 const accepted = await cli(home, ['business','answer','question2','uptimerobot','both','0.85']);
 assert.equal(accepted.code, 0);
 assert.equal(remote.state.questionCompleted.vendor_id, 'uptimerobot', 'classification can correct the suggested vendor using the schema');
 assert.equal(remote.state.questionCompleted.usage, 'both');
 assert.equal(remote.state.questionCompleted.confidence, 0.85);

 for (const usage of ['uses', 'sells', 'product-dependency']) {
  const taskId = `classify-${usage}`;
  remote.state.tasks = [{ task_id: taskId, kind: 'classify.row', state: 'ready', runner: 'executor', fence: 0, question }];
  const answered = await cli(home, ['business','answer',taskId,'none',usage]);
  assert.equal(answered.code, 0, answered.stderr);
  assert.deepEqual(remote.state.questionCompleted, { vendor_id: 'none', usage, confidence: 1 });
 }
 const requestCount = remote.state.requests.length;
 for (const args of [
  ['sentry; run code','uses'], ['sentry','a free text answer'], ['sentry','uses','high'], ['sentry','uses','1.5'],
 ]) assert.equal((await cli(home, ['business','answer','question1',...args])).code, 1);
 assert.equal(remote.state.requests.length, requestCount, 'free text and invalid confidence are refused before any request');
 remote.state.tasks = [{ task_id: 'unknown-vendor', kind: 'classify.row', state: 'ready', runner: 'executor', fence: 0, question }];
 const beforeUnknown = remote.state.requests.filter(entry => entry.body.params?.name === 'answer').length;
 assert.equal((await cli(home, ['business','answer','unknown-vendor','not-in-catalogue','uses'])).code, 1);
 assert.equal(remote.state.requests.filter(entry => entry.body.params?.name === 'answer').length, beforeUnknown, 'a vendor outside the question schema is never submitted');
 const answerCalls = remote.state.requests.filter(entry => entry.route === '/api/business/mcp' && entry.body.params?.name === 'answer').length;
 remote.state.tasks = [{ task_id: 'consent1', kind: 'consent.grant', state: 'ready', runner: 'owner' }];
 const denied = await cli(home, ['business','answer','consent1','sentry','uses']);
 assert.equal(denied.code, 1); assert.ok(denied.stderr.includes('/business/biz'));
 assert.equal(remote.state.requests.filter(entry => entry.route === '/api/business/mcp' && entry.body.params?.name === 'answer').length, answerCalls, 'owner item is never mutated');


 const uploadsBeforeQuota = remote.state.uploads.length;
 remote.state.quotaBytes = 256;
 remote.state.tasks = [{ task_id: 'quota1', kind: 'discover.local', state: 'ready', runner: 'executor', fence: 0 }];
 const limited = await cli(home, ['business','run','--once']);
 assert.equal(limited.code, 1);
 assert.match(limited.stderr, /quota/);
 assert.equal(remote.state.uploads.length, uploadsBeforeQuota, 'over-quota discovery is refused before uploading');
 assert.equal(remote.state.released.reason, 'failed');
 delete remote.state.quotaBytes;
 // A step this rer has no handler for (a retired export kind from an older server) is reported by its kind, never failed or claimed.
 remote.state.tasks = [{ task_id: 'export1', kind: 'export.vendor', state: 'ready', runner: 'executor', fence: 0 }];
 const before = remote.state.requests.filter(entry => entry.route === '/api/business/executors/claim').length;
 for (const verb of ['run', 'next']) {
  const unhandled = await cli(home, ['business', verb, ...(verb === 'run' ? ['--once'] : [])]);
  assert.equal(unhandled.code, 0, unhandled.stderr);
  assert.ok(unhandled.stdout.includes('does not handle (export.vendor)'), unhandled.stdout);
 }
 assert.equal(remote.state.requests.filter(entry => entry.route === '/api/business/executors/claim').length, before, 'an unhandled kind is never claimed');
 assert.equal((await cli(home, ['business','disconnect'])).code, 0);
});

test('a killed packed supervisor resumes a lapsed lease from its acknowledged scan checkpoint', async t => {
 const remote = await fixtureServer(t), home = join(directory, 'lease-home');
 await connect(home, remote);
 remote.state.root = join(home, 'canary-tree'); await mkdir(remote.state.root);
 const dependencies = Object.fromEntries(Array.from({ length: 1800 }, (_, index) => [`fixture-library-${String(index).padStart(4, '0')}`, 'fixture-private-version-never-export']));
 await writeFile(join(remote.state.root, 'package.json'), JSON.stringify({ dependencies }));
 remote.state.tasks = [{ task_id: 'discover1', kind: 'discover.local', state: 'ready', runner: 'executor', fence: 0 }];
 let child;
 remote.state.onHeartbeat = () => {
  if (remote.state.checkpoint.page === 1) { remote.state.onHeartbeat = null; child.kill('SIGKILL'); }
 };
 const killed = await cli(home, ['business','run','--once'], { onSpawn: process => { child = process; } });
 assert.equal(killed.code, null, `task is killed after its first acknowledged page: ${killed.stderr}`);
 assert.equal(remote.state.checkpoint.page, 1); assert.ok(remote.state.checkpoint.total > 1);
 // The server expires the lease and retains the checkpoint before the next claim.
 remote.state.phase = 'ready'; remote.state.fence++;
 const status = await cli(home, ['business','status','--json']);
 assert.equal(JSON.parse(status.stdout).checkpoint.saved, true);
 const resumed = await cli(home, ['business','run','--once']);
 assert.equal(resumed.code, 0, 'same immutable snapshot resumes under the new fence');
 assert.equal(remote.state.phase, 'done');
 const names = remote.state.uploads.flatMap(document => document.signals.map(signal => signal.value));
 assert.equal(names.length, Object.keys(dependencies).length);
 assert.equal(new Set(names).size, names.length, 'acknowledged first page is not uploaded again');
 assert.equal(remote.state.checkpoint.page, remote.state.checkpoint.total);
 remote.state.revoked = true;
 assert.equal((await cli(home, ['business','run','--once'])).code, 0, 'revocation stops the supervisor cleanly');
 const revoked = await cli(home, ['business','status','--json']);
 assert.equal(JSON.parse(revoked.stdout).paired, false, 'revoked device credential is removed locally');
 assert.equal(JSON.parse(revoked.stdout).revoked, true, 'status says revoked, never paired');
 assert.ok(!JSON.stringify(remote.state.requests).includes('fixture-private-version-never-export'));
 assert.equal((await cli(home, ['business','disconnect'])).code, 0);
});

test('connect waits for approval, resumes after an interruption, names real causes, and never redeems a code it cannot keep', async t => {
 const legacy = join(directory, 'legacy-code'); await mkdir(legacy);
 const remote = await fixtureServer(t);
 const redemptions = () => remote.state.requests.filter(entry => entry.body.code).length;
 const pendingHome = join(legacy, 'pending-home');
 const pendingArgs = ['--code','ABCD-1234','--origin',remote.origin];

 // Ctrl-C while waiting keeps the redeemed pairing; the next run resumes it and waits for approval.
 const interrupted = await connectWhile(pendingHome, pendingArgs, child => child.kill('SIGINT'));
 assert.equal(interrupted.code, 130, interrupted.stderr);
 assert.match(interrupted.stderr, /Stopped waiting for approval\. The pairing is saved: run .* business connect --origin http:\/\/127\.0\.0\.1:\d+ to resume it/);
 const savedPending = JSON.parse(await readFile(join(pendingHome, '.rer/business/pairing.json'), 'utf8'));
 const resumed = await connectWhile(pendingHome, [], () => approve(remote));
 assert.equal(resumed.code, 0, resumed.stderr);
 assert.ok(resumed.stdout.includes(savedPending.confirmation_number), 'the resumed run shows the same number');
 assert.equal(redemptions(), 1, 'resuming never redeems the code again');
 assert.equal(remote.state.active, true);
 assert.equal((await cli(pendingHome, ['business','disconnect'])).code, 0);

 // A refused or expired pairing ends the wait with the server's reason and drops the saved pairing.
 remote.state.pairingRefused = true;
 const refused = await cli(pendingHome, ['business','connect',...pendingArgs]);
 assert.equal(refused.code, 1);
 assert.ok(refused.stderr.includes('the server said: Pairing expired or used') && !refused.stderr.includes('Business command failed'), refused.stderr);
 assert.ok(!(await readdir(join(pendingHome, '.rer/business'))).includes('pairing.json'));
 remote.state.pairingRefused = false;
 remote.state.pairingSeconds = 2;
 const unapproved = await cli(pendingHome, ['business','connect',...pendingArgs]);
 delete remote.state.pairingSeconds;
 assert.equal(unapproved.code, 1, 'nobody approved before the code expired');
 assert.ok(unapproved.stdout.includes(waiting) && unapproved.stderr.includes('Pairing expired or used'), unapproved.stderr);
 const wrongCode = await cli(pendingHome, ['business','connect','--code','WXYZ-9999','--origin',remote.origin]);
 assert.equal(wrongCode.code, 1);
 assert.ok(wrongCode.stderr.includes('did not accept code WXYZ-9999') && wrongCode.stderr.includes('Pairing expired or used'), wrongCode.stderr);
 const unreachable = await cli(pendingHome, ['business','connect','--code','ABCD-1234','--origin','http://127.0.0.1:9']);
 assert.equal(unreachable.code, 1);
 assert.match(unreachable.stderr, /^Could not reach the Business server at http:\/\/127\.0\.0\.1:9: /, unreachable.stderr);
 const expired = JSON.parse(JSON.stringify(savedPending));
 expired.expires_at = new Date(Date.now() - 1000).toISOString();
 await mkdir(join(pendingHome, '.rer/business'), { recursive: true });
 await writeFile(join(pendingHome, '.rer/business/pairing.json'), JSON.stringify(expired));
 const beforeExpiry = remote.state.requests.length;
 assert.equal((await cli(pendingHome, ['business','connect'])).code, 1);
 assert.equal(remote.state.requests.length, beforeExpiry, 'expired pairing is never polled or silently replaced');
 assert.equal((await cli(pendingHome, ['business','disconnect'])).code, 0);

 // The waiting line names the command that works from the agent's own shell.
 const onPath = join(legacy, 'rer-on-path');
 await mkdir(onPath, { recursive: true }); await writeFile(join(onPath, 'rer'), '#!/bin/sh\n', { mode: 0o755 });
 const withoutRer = await connectWhile(pendingHome, pendingArgs, child => child.kill('SIGTERM'), { path: '/usr/bin:/bin' });
 assert.equal(withoutRer.code, 143);
 assert.ok(withoutRer.stdout.includes(`run npx -y @runeditrun/rer business connect --origin ${remote.origin} to resume this pairing`), withoutRer.stdout);
 const withRer = await connectWhile(pendingHome, [], child => child.kill('SIGINT'), { path: `${onPath}:/usr/bin:/bin` });
 assert.ok(withRer.stdout.includes(`run rer business connect --origin ${remote.origin} to resume this pairing`), withRer.stdout);
 assert.equal((await cli(pendingHome, ['business','disconnect'])).code, 0);

 // Without an OS credential store, or with one that reads but refuses writes
 // (as an agent sandbox does), the one-use code is never redeemed.
 for (const marker of ['no-credential-store', 'fail-credential-store', 'sandboxed-credential-store']) {
  const lockedHome = join(legacy, `${marker}-home`);
  await mkdir(lockedHome); await writeFile(join(lockedHome, marker), '');
  const beforeLocked = redemptions();
  const locked = await cli(lockedHome, ['business','connect',...pendingArgs]);
  assert.equal(locked.code, 1); assert.match(locked.stderr, /^OS credential storage could not (?:read|save) a credential: .*Nothing was sent, so the pairing code still works\./);
  assert.equal(redemptions(), beforeLocked, 'the code is not redeemed when its credential could not be stored');
  if (marker === 'sandboxed-credential-store') {
   // A Codex user is told to approve running this one connect command outside the sandbox.
   assert.ok(locked.stderr.includes('Operation not permitted') && locked.stderr.includes('approve running it outside the sandbox'), locked.stderr);
   assert.match(locked.stderr, new RegExp(`Approve this command outside the sandbox: (?:rer|npx -y @runeditrun/rer) business connect --code ABCD-1234 --origin ${remote.origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\. Every other business command runs inside the sandbox\\.`));
  }
  assert.deepEqual(await readdir(lockedHome), [marker]);
  await rm(join(lockedHome, marker));
  const unlocked = await connectWhile(lockedHome, pendingArgs, () => approve(remote));
  assert.ok(unlocked.stdout.includes('246810'), 'the same code still pairs once the store is available');
  assert.equal((await cli(lockedHome, ['business','disconnect'])).code, 0);
 }

 // An approval near the code's end extends the server's expiry; a later run still collects it.
 const lateHome = join(legacy, 'late-approval-home');
 remote.state.pairingSeconds = 3;
 const stopped = await connectWhile(lateHome, pendingArgs, child => child.kill('SIGINT'));
 assert.equal(stopped.code, 130);
 const redeemed = Date.now();
 assert.equal((await approve(remote)).status, 200);
 delete remote.state.pairingSeconds;
 await delay(Math.max(0, redeemed + 3500 - Date.now()));
 const collected = await cli(lateHome, ['business','connect']);
 assert.equal(collected.code, 0, collected.stderr); assert.ok(collected.stdout.includes('This computer is connected to Business'));
 assert.equal((await cli(lateHome, ['business','disconnect'])).code, 0);

 // A store that fails after approval never activates the computer.
 const failedHome = join(legacy, 'storage-failed-home');
 const authenticated = () => remote.state.requests.filter(entry => entry.authorization === `Bearer ${remote.device}`).length;
 const beforeFailure = authenticated();
 const failed = await connectWhile(failedHome, pendingArgs, async () => {
  await writeFile(join(failedHome, 'fail-credential-store'), '');
  await approve(remote);
 });
 assert.equal(failed.code, 1); assert.match(failed.stderr, /OS credential storage could not save/);
 assert.equal(authenticated(), beforeFailure, 'failed credential storage sends no activation or other device-authenticated request');
 assert.equal(remote.state.active, false);
 const unrevoked = await cli(failedHome, ['business','disconnect']);
 assert.equal(unrevoked.code, 0);
 assert.ok(!unrevoked.stdout.includes('Device revoked') && unrevoked.stdout.includes(`${remote.origin}/business`), 'without a stored credential nothing is revoked, and the browser is named for it');
});

test('connect starts and resumes device approval, respects poll intervals and preserves credentials and legacy compatibility', async t => {
 const remote = await fixtureServer(t), home = join(directory, 'pending-home');
 const args = ['--business', 'biz', '--origin', remote.origin];
 const pendingPath = join(home, '.rer/business/pairing.json');
 const readPending = async () => JSON.parse(await readFile(pendingPath, 'utf8'));
 const absent = () => assert.rejects(stat(pendingPath), { code: 'ENOENT' });
 const proof = (point, input, result) => t.diagnostic(`PROBE gr-base-pairing-device-1 ${point}: ${input} -> exit=${result.code}; stdout=${JSON.stringify(result.stdout.replaceAll(remote.state.devicePairing?.user_code ?? 'unused', '[user-code]'))}; stderr=${JSON.stringify(result.stderr)}`);

 // Both durable-write probes must complete before the start endpoint is hit.
 for (const marker of ['no-credential-store', 'fail-credential-store', 'sandboxed-credential-store']) {
  const lockedHome = join(directory, `${marker}-home`);
  await mkdir(lockedHome); await writeFile(join(lockedHome, marker), '');
  const before = starts(remote);
  const locked = await cli(lockedHome, ['business', 'connect', ...args]);
  assert.equal(locked.code, 1); assert.match(locked.stderr, /OS credential storage could not (?:read|save)/);
  assert.equal(starts(remote), before, 'a refused store never starts a pairing');
  if (marker === 'sandboxed-credential-store') assert.match(locked.stderr, /Approve this command outside the sandbox: .* business connect --business biz --origin/);
  assert.deepEqual(await readdir(lockedHome), [marker]);
  await rm(join(lockedHome, marker));
  await connect(lockedHome, remote, { env: { WSL_DISTRO_NAME: 'synthetic-test' } });
  assert.equal(remote.state.requests.findLast(item => item.route === '/api/business/executors/device-pairings').body.os, 'wsl');
  assert.equal((await cli(lockedHome, ['business', 'disconnect'])).code, 0);
 }
 const blockedHome = join(directory, 'blocked-state-home'); await mkdir(blockedHome);
 const blocked = join(blockedHome, 'not-a-folder'); await writeFile(blocked, '');
 const beforeBlocked = starts(remote);
 const stateRefused = await cli(blockedHome, ['business', 'connect', ...args], { env: { RER_BUSINESS_STATE_DIR: join(blocked, 'state') } });
 assert.equal(stateRefused.code, 1); assert.equal(starts(remote), beforeBlocked);
 assert.match(stateRefused.stderr, /Business cannot save its state/);

 // Overlapping starts share one pending pairing, even before the first start
 // response arrives. The lock ends after the save, so both commands can wait.
 const concurrent = await fixtureServer(t), concurrentHome = join(directory, 'concurrent-pairing-home');
 let started, release;
 const atStart = new Promise(resolve => { started = resolve; });
 const startResponse = new Promise(resolve => { release = resolve; });
 concurrent.state.onStart = async () => { started(); await startResponse; };
 const concurrentArgs = ['business', 'connect', '--business', 'biz', '--origin', concurrent.origin, '--timeout', '0'];
 const firstRun = cli(concurrentHome, concurrentArgs);
 await Promise.race([atStart, firstRun.then(result => assert.fail(`connect ended before starting: ${result.stderr}`))]);
 let spawned;
 const secondSpawned = new Promise(resolve => { spawned = resolve; });
 const secondRun = cli(concurrentHome, concurrentArgs, { onSpawn: spawned });
 await secondSpawned; await delay(300); release();
 const concurrentRuns = await Promise.all([firstRun, secondRun]);
 assert.deepEqual(concurrentRuns.map(result => result.code), [75, 75]);
 assert.equal(starts(concurrent), 1, 'concurrent connects start only one pairing');
 assert.equal(concurrentRuns[0].stdout.split('\n').slice(0, 2).join('\n'), concurrentRuns[1].stdout.split('\n').slice(0, 2).join('\n'), 'both runs show the same owner code and link');
 await assert.rejects(stat(join(concurrentHome, '.rer/business/pairing.lock')), { code: 'ENOENT' });
 assert.equal((await cli(concurrentHome, ['business', 'disconnect'])).code, 0);

 const before = starts(remote), issuesBefore = remote.state.credentialIssues ?? 0;
 const waitingRun = await cli(home, ['business', 'connect', ...args, '--timeout', '1']);
 assert.equal(waitingRun.code, 75, waitingRun.stderr);
 const pending = await readPending();
 assert.equal((await stat(pendingPath)).mode & 0o777, 0o600);
 assert.equal(pending.flow, 'device');
 assert.ok(waitingRun.stdout.startsWith(`Code: ${pending.user_code}\nApprove at: ${remote.origin}/business/biz/pair#${pending.user_code}\n`));
 assert.equal(waitingRun.stdout.split(pending.user_code).length - 1, 2, 'only the two fixed lines carry the code');
 assert.ok(!waitingRun.stderr.includes(pending.user_code));
 proof('A', '--timeout 1; pairing kept', waitingRun);
 for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  const interrupted = await connectWhile(home, args, child => child.kill(signal));
  assert.equal(interrupted.code, code, interrupted.stderr);
  assert.equal((await readPending()).device_code, pending.device_code);
  assert.ok(interrupted.stdout.startsWith(waitingRun.stdout.split('\n').slice(0, 2).join('\n') + '\n'));
  proof('A', signal, interrupted);
 }
 assert.equal(starts(remote), before + 1, 'timeouts and signals resume without starting another pairing');
 // Another origin or Business cannot replace the live pairing.
 for (const other of [['--business', 'other', '--origin', remote.origin], ['--business', 'biz', '--origin', 'https://example.test']]) {
  assert.equal((await cli(home, ['business', 'connect', ...other])).code, 1);
  assert.equal((await readPending()).device_code, pending.device_code);
 }

 // Force slow_down once; the next request must wait the returned six seconds.
 remote.state.slowDown = true;
 const slow = await cli(home, ['business', 'connect', ...args, '--timeout', '2']);
 assert.equal(slow.code, 75, slow.stderr);
 const slowed = await readPending(); assert.equal(slowed.interval, 6);
 assert.equal((await approve(remote)).status, 200);
 const earliest = remote.state.devicePairing.lastPoll + 6000;
 const resumed = await cli(home, ['business', 'connect', ...args, '--timeout', '30']);
 assert.equal(resumed.code, 0, resumed.stderr);
 assert.ok(Date.now() >= earliest, 'slow_down survives resume and is honoured before polling again');
 assert.equal(starts(remote), before + 1);
 assert.equal(remote.state.credentialIssues, issuesBefore + 1, 'one issue per successful fixture pairing');
 await absent(); assert.equal(remote.state.active, true);
 const second = await fetch(remote.origin + '/api/business/executors/device-pairings/poll', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device_code: pending.device_code }) });
 assert.equal(second.status, 410); assert.equal((await second.json()).code, 'pairing_used');
 assert.equal(remote.state.credentialIssues, issuesBefore + 1);
 const pairedState = JSON.parse(await readFile(join(home, '.rer/business/state.json'), 'utf8'));
 assert.equal(pairedState.businessId, 'biz'); assert.equal(pairedState.origin, remote.origin);
 const reconnect = await cli(home, ['business', 'connect', ...args]); assert.equal(reconnect.code, 0, reconnect.stderr);
 const selfBefore = remote.state.requests.length;
 const wrongBusiness = await cli(home, ['business', 'connect', '--business', 'other', '--origin', remote.origin]);
 assert.equal(wrongBusiness.code, 1); assert.equal(remote.state.requests.length, selfBefore);
 assert.match(wrongBusiness.stderr, /RER_BUSINESS_STATE_DIR/);
 proof('A', '--timeout 30; browser approved', resumed);

 // Count sentinel occurrences without writing or printing the values. Only
 // the existing OS-store seam contains the credential; pairing.json is gone.
 const streams = waitingRun.stdout + waitingRun.stderr + slow.stdout + slow.stderr + resumed.stdout + resumed.stderr;
 assert.equal(streams.split(pending.device_code).length - 1, 0);
 assert.equal(streams.split(remote.device).length - 1, 0);
 async function files(path) {
  const entries = await readdir(path, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? files(join(path, entry.name)) : readFile(join(path, entry.name), 'utf8').then(text => [{ name: entry.name, text }])))).flat();
 }
 const localFiles = await files(home);
 assert.equal(localFiles.filter(file => file.name !== 'fake-keychain.json').reduce((n, file) => n + file.text.split(remote.device).length - 1, 0), 0);
 for (const sentinel of [pending.device_code, pending.user_code]) assert.ok(localFiles.every(file => !file.text.includes(sentinel)));
 const events = JSON.stringify(remote.state.requests.filter(item => /events|complete/.test(item.route)));
 for (const sentinel of [pending.device_code, pending.user_code, remote.device]) assert.ok(!events.includes(sentinel));
 t.diagnostic('PROBE gr-base-pairing-device-1 B: sentinel scan -> device/credential streams=0; files outside store=0; user-code files/events=0; second poll HTTP=410 pairing_used; credential issue delta=1');
 assert.equal((await cli(home, ['business', 'disconnect'])).code, 0);

 // All terminal refusal codes clear the pending file and name the cause.
 for (const [code, status] of [['pairing_denied', 410], ['pairing_expired', 410], ['pairing_used', 410], ['pairing_unknown', 401], ['business_paused', 409]]) {
  remote.state.pollRefusal = [status, code];
  const ended = await cli(home, ['business', 'connect', ...args]);
  assert.equal(ended.code, 1); assert.ok(ended.stderr.includes(code)); await absent();
  proof('A', code, ended);
 }
 delete remote.state.pollRefusal;
 const denied = await connectWhile(home, args, () => {
  remote.state.refusalText = [remote.state.devicePairing.device_code, remote.state.devicePairing.user_code, remote.device].join(' ');
  return deviceOwner(remote, 'deny');
 });
 assert.equal(denied.code, 1); assert.match(denied.stderr, /pairing_denied/); await absent();
 for (const sentinel of [remote.state.devicePairing.device_code, remote.state.devicePairing.user_code, remote.device]) assert.ok(!denied.stderr.includes(sentinel), 'untrusted refusal prose cannot echo a secret');
 delete remote.state.refusalText;
 remote.state.pairingSeconds = 1;
 const expired = await cli(home, ['business', 'connect', ...args]);
 assert.equal(expired.code, 1); assert.match(expired.stderr, /pairing_expired/); await absent();
 delete remote.state.pairingSeconds;
 remote.state.paused = true;
 const paused = await connectWhile(home, args, async () => {
  assert.equal((await approve(remote)).status, 409, 'paused start is allowed, approval is refused');
  remote.state.paused = false; assert.equal((await approve(remote)).status, 200); remote.state.paused = true;
 });
 assert.equal(paused.code, 1); assert.match(paused.stderr, /business_paused/); await absent();
 remote.state.paused = false;

 // Server expiry is authoritative after a late approval, even after the
 // original deadline passed. keep_until retains the device code for collection.
 remote.state.pairingSeconds = 1;
 assert.equal((await cli(home, ['business', 'connect', ...args, '--timeout', '0'])).code, 75);
 assert.equal((await approve(remote)).status, 200);
 delete remote.state.pairingSeconds;
 await delay(1100);
 const collecting = await readPending(), collectionStarts = starts(remote);
 const legacyWhileCollecting = await cli(home, ['business', 'connect', '--code', 'ABCD-1234', '--origin', remote.origin]);
 assert.equal(legacyWhileCollecting.code, 1);
 assert.equal((await readPending()).device_code, collecting.device_code, 'another flow cannot discard a live collection window');
 assert.equal(starts(remote), collectionStarts);
 assert.equal((await cli(home, ['business', 'connect', ...args])).code, 0);
 assert.equal((await cli(home, ['business', 'disconnect'])).code, 0);

 // Local retention ends: remove the old record and start fresh once.
 assert.equal((await cli(home, ['business', 'connect', ...args, '--timeout', '0'])).code, 75);
 const old = await readPending(); old.keep_until = new Date(Date.now() - 1000).toISOString();
 await writeFile(pendingPath, JSON.stringify(old));
 const oldStarts = starts(remote);
 assert.equal((await cli(home, ['business', 'connect', ...args, '--timeout', '0'])).code, 75);
 assert.equal(starts(remote), oldStarts + 1);
 assert.notEqual((await readPending()).device_code, old.device_code);
 assert.equal((await cli(home, ['business', 'disconnect'])).code, 0);

 // Malformed or off-origin links are never saved or printed.
 for (const patch of [{ device_code: 'invalid' }, { user_code: 'AAAA-0000' }, { user_code: ['WDJB-MJHT'] }, { verification_uri: 'https://other.test/business/biz/pair' }, { verification_uri_complete: remote.origin + '/business/biz/pair?code=WDJB-MJHT' }, { business_id: 'other' }, { expires_in: 901 }, { interval: 0 }, { expires_at: 'invalid' }]) {
  remote.state.startPatch = patch;
  const invalid = await cli(home, ['business', 'connect', ...args, '--timeout', '0']);
  assert.equal(invalid.code, 1); assert.equal(invalid.stdout, ''); await absent();
 }
 delete remote.state.startPatch;
 for (const patch of [{ business_id: 'other' }, { device_credential: 'invalid' }, { executor_id: '../bad' }]) {
  remote.state.pairedPatch = patch;
  const invalid = await connectWhile(home, args, () => approve(remote));
  assert.equal(invalid.code, 1); assert.equal(remote.state.active, false); await absent();
 }
 delete remote.state.pairedPatch;
 // A network failure preserves the record for a later retry.
 const offline = await fixtureServer(t), offlineHome = join(directory, 'offline-home');
 assert.equal((await cli(offlineHome, ['business', 'connect', '--business', 'biz', '--origin', offline.origin, '--timeout', '0'])).code, 75);
 await offline.close();
 const unreachable = await cli(offlineHome, ['business', 'connect', '--business', 'biz', '--origin', offline.origin, '--timeout', '3']);
 assert.equal(unreachable.code, 1); assert.match(unreachable.stderr, /Could not reach/);
 assert.equal(JSON.parse(await readFile(join(offlineHome, '.rer/business/pairing.json'), 'utf8')).flow, 'device');

 const authenticated = () => remote.state.requests.filter(entry => entry.authorization === `Bearer ${remote.device}`).length;
 const beforeFailure = authenticated();
 const failed = await connectWhile(home, args, async () => {
  await writeFile(join(home, 'fail-credential-store'), ''); await approve(remote);
 });
 assert.equal(failed.code, 1); assert.match(failed.stderr, /OS credential storage could not save/);
 assert.equal(authenticated(), beforeFailure, 'failed credential storage sends no activation or other device-authenticated request'); await absent();
 await rm(join(home, 'fail-credential-store'));
 for (const options of [['--business', 'biz', '--code', 'ABCD-1234'], ['--business', '../bad'], ['--business', 'biz', '--timeout', '-1'], ['--business', 'biz', '--timeout', '901'], ['--business', 'biz', '--timeout', '1.5'], ['--business', 'biz', '--origin', 'http://example.test']]) {
  const invalid = await cli(home, ['business', 'connect', ...options]); assert.equal(invalid.code, 2);
 }
 const badUsage = await cli(home, ['business', 'connect', '--business']);
 assert.equal(badUsage.code, 2); t.diagnostic('PROBE gr-base-pairing-device-1 A: missing/invalid flags -> exit=2; requests=0');
 const help = await cli(home, ['business', 'connect', '--help']);
 assert.equal(help.code, 0); assert.match(help.stdout, /--business/); assert.match(help.stdout, /--code/); assert.match(help.stdout, /--timeout/);
});

test('connect keeps its state where RER_BUSINESS_STATE_DIR says, checks it before redeeming, and asks for choices in plain words', async t => {
 const remote = await fixtureServer(t);
 const redemptions = () => starts(remote);
 const home = join(directory, 'state-dir-home'), work = join(home, 'work');
 await mkdir(work, { recursive: true }); await writeFile(join(work, 'not-a-folder'), '');
 const blocked = join(work, 'not-a-folder', 'state');
 const before = redemptions();
 const refused = await cli(home, ['business','connect','--code','ABCD-1234','--origin',remote.origin], { env: { RER_BUSINESS_STATE_DIR: blocked } });
 assert.equal(refused.code, 1);
 assert.ok(refused.stderr.startsWith(`Business cannot save its state in ${blocked}: `) && refused.stderr.includes('Nothing was sent, so the pairing code still works.') && refused.stderr.includes('RER_BUSINESS_STATE_DIR') && !refused.stderr.includes('RER_STATE_DIR'), refused.stderr);
 assert.equal(redemptions(), before, 'an unwritable state folder stops connect before the code is redeemed');

 const stateDir = join(work, '.rer-business');
 await mkdir(stateDir); await writeFile(join(stateDir, 'keep.txt'), 'not rer');
 const registry = join(work, 'registry'), checkout = join(work, 'synthetic-base-1'), live = join(work, 'synthetic-base-2');
 const owner = await identity(); t.after(() => owner.close());
 for (const root of [checkout, live]) {
  await mkdir(root); await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify({ version: 2, seedContract: { profile: 'first-party' } }));
  await mkdir(join(root, 'scripts'));
  await writeFile(join(root, 'scripts/rer.mjs'), `process.stdout.write(JSON.stringify({ local: { prepared: true } }));`);
 }
 await mkdir(registry);
 const register = roots => writeFile(join(registry, 'state.json'), JSON.stringify({ running: roots.map(checkout => ({ checkout, mode: 'dev', owner: owner.info })) }));
 await register([checkout]);
 const env = { RER_BUSINESS_STATE_DIR: stateDir, RER_SERVERS_DIR: registry, CLAUDECODE: '1' };
 const carryFile = root => join(root, '.rer/local/business.json');
 const proof = async root => {
  const text = await readFile(carryFile(root), 'utf8');
  assert.ok(!text.includes(remote.device));
  t.diagnostic(spawnSync('ls', ['-ld', join(root, '.rer/local'), carryFile(root)], { encoding: 'utf8' }).stdout.trim());
  t.diagnostic(text.trim());
  assert.equal((await stat(join(root, '.rer/local'))).mode & 0o777, 0o700);
  assert.equal((await stat(carryFile(root))).mode & 0o777, 0o600);
  return text;
 };
 remote.state.optIns = { installPermissions: null, awakeConsent: false, installService: null };
 const paired = await connect(home, remote, { env });
 assert.equal(redemptions(), before + 1, 'the same code pairs once the folder is writable');
 const firstCarry = await proof(checkout), carried = JSON.parse(firstCarry);
 assert.deepEqual(carried, { version: 1, origin: remote.origin, business_id: 'biz', business_url: remote.origin + '/business/biz',
  name: 'synthetic-base-1', legal_name: null, accent: '#264f45', logo_url: null, refreshed_at: carried.refreshed_at });
 assert.equal(new Date(carried.refreshed_at).toISOString(), carried.refreshed_at);
 assert.deepEqual(JSON.parse(await readFile(join(stateDir, 'carried.json'), 'utf8')), [checkout]);
 assert.equal((await stat(join(stateDir, 'carried.json'))).mode & 0o777, 0o600);
 assert.equal((await cli(home, ['business','connect'], { env })).code, 0);
 assert.equal(await readFile(carryFile(checkout), 'utf8'), firstCarry, 'a re-connect preserves unchanged bytes');
 remote.state.business = { ...remote.state.business, name: 'synthetic-base-2', legal_name: 'synthetic-base-3', brand_color: 'invalid', logo_url: 'http://example.test/logo.png' };
 const selfReads = () => remote.state.requests.filter(item => item.route === '/api/business/executors/self' && item.method === 'GET').length;
 const beforeRun = selfReads();
 assert.equal((await cli(home, ['business','run','--once'], { env })).code, 0);
 assert.equal(selfReads(), beforeRun + 1, 'run once reads self once');
 const refreshed = JSON.parse(await proof(checkout));
 assert.deepEqual([refreshed.name, refreshed.legal_name, refreshed.accent, refreshed.logo_url], ['synthetic-base-2', 'synthetic-base-3', null, null]);
 assert.notEqual(refreshed.refreshed_at, carried.refreshed_at);
 const changedCarry = await readFile(carryFile(checkout), 'utf8');
 remote.state.business.id = 'synthetic-base-4';
 const mismatched = await cli(home, ['business','connect'], { env });
 assert.equal(mismatched.code, 0); assert.equal(await readFile(carryFile(checkout), 'utf8'), changedCarry);
 assert.equal(mismatched.stderr.trim().split('\n').length, 1); assert.ok(mismatched.stderr.includes(remote.origin) && mismatched.stderr.includes('another Business'));
 await rm(carryFile(checkout));
 assert.equal((await cli(home, ['business','connect'], { env })).code, 0);
 await assert.rejects(stat(carryFile(checkout)), { code: 'ENOENT' });
 remote.state.business = undefined;
 assert.equal((await cli(home, ['business','connect'], { env })).code, 0);
 await assert.rejects(stat(carryFile(checkout)), { code: 'ENOENT' });
 remote.state.business = { id: 'biz', name: 'synthetic-base-2', legal_name: null, brand_color: '#264F45', logo_url: 'https://example.test/logo.png' };
 assert.equal((await cli(home, ['business','connect'], { env })).code, 0);
 const finalCarry = await proof(checkout);
 // A recorded path alone is not authority: recheck eligibility, the fixed
 // carry location, and this Business's generated document before refreshing.
 await register([]);
 const invalid = Object.fromEntries(['missing', 'removed-carry', 'foreign', 'unrelated', 'repurposed', 'unreadable', 'linked', 'linked-root'].map(name => [name, join(work, name)]));
 for (const [name, root] of Object.entries(invalid)) {
  if (['missing', 'linked-root'].includes(name)) continue;
  await mkdir(join(root, '.rer/local'), { recursive: true });
  await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify({ version: 2, seedContract: { profile: 'first-party' } }));
  await mkdir(join(root, 'scripts'));
  await writeFile(join(root, 'scripts/rer.mjs'), `process.stdout.write(JSON.stringify({ local: { prepared: true } }));`);
  if (name !== 'removed-carry') await writeFile(carryFile(root), finalCarry);
 }
 const foreign = { ...JSON.parse(finalCarry), business_id: 'synthetic-foreign', business_url: remote.origin + '/business/synthetic-foreign' };
 await writeFile(carryFile(invalid.foreign), JSON.stringify(foreign));
 await writeFile(carryFile(invalid.unrelated), JSON.stringify({ name: 'Owner setting', accent: '#abcdef', custom: true }));
 await writeFile(join(invalid.repurposed, 'OPERATIONS.json'), JSON.stringify({ version: 2 }));
 await rm(join(invalid.unreadable, 'OPERATIONS.json')); await mkdir(join(invalid.unreadable, 'OPERATIONS.json'));
 await rm(join(invalid.linked, '.rer'), { recursive: true }); await symlink(join(invalid.unrelated, '.rer'), join(invalid.linked, '.rer'), 'dir');
 await symlink(invalid.unrelated, invalid['linked-root'], 'dir');
 const kept = new Map(await Promise.all(['foreign', 'unrelated', 'repurposed', 'unreadable'].map(async name => [name, await readFile(carryFile(invalid[name]), 'utf8')])));
 const custody = [checkout, ...Object.values(invalid), 'relative-path'];
 await writeFile(join(stateDir, 'carried.json'), JSON.stringify(custody));
 // name/accent inside this generated file are carry-owned under the existing
 // writer semantics. Native app settings are asserted separately above.
 await writeFile(carryFile(checkout), JSON.stringify({ ...JSON.parse(finalCarry), name: 'Edited carry cache', accent: '#aabbcc' }));
 remote.state.business.name = 'synthetic-base-current';
 const isolated = await cli(home, ['business', 'next'], { env });
 assert.equal(isolated.code, 0, isolated.stderr);
 assert.ok(isolated.stdout.includes('1 local app carry file for'), isolated.stdout);
 assert.ok(isolated.stdout.includes(carryFile(checkout)), isolated.stdout);
 assert.equal(JSON.parse(await readFile(carryFile(checkout), 'utf8')).name, remote.state.business.name);
 assert.equal(JSON.parse(await readFile(carryFile(checkout), 'utf8')).accent, '#264f45');
 for (const root of Object.values(invalid)) assert.ok(isolated.stderr.includes(JSON.stringify(root)), isolated.stderr);
 assert.ok(isolated.stderr.includes('the existing file is not a carry for this paired Business'), isolated.stderr);
 assert.ok(isolated.stderr.includes('the carry path is linked or not a regular file'), isolated.stderr);
 assert.ok(!isolated.stderr.includes('rer describe fails here'), 'custody refusals reach the carry writer after preparation succeeds');
 assert.ok(isolated.stderr.includes('relative-path'), isolated.stderr);
 for (const [name, bytes] of kept) assert.equal(await readFile(carryFile(invalid[name]), 'utf8'), bytes, `${name} is untouched`);
 for (const name of ['missing', 'removed-carry']) await assert.rejects(stat(carryFile(invalid[name])), { code: 'ENOENT' });
 const unchanged = await cli(home, ['business', 'run', '--once'], { env });
 assert.equal(unchanged.code, 0, unchanged.stderr);
 assert.ok(unchanged.stdout.includes('No local app carry files changed') && !unchanged.stdout.includes('Refreshed '), unchanged.stdout);
 t.diagnostic('recorded stopped carry refreshed; missing/removed/foreign/unrelated/repurposed/unreadable/linked/relative paths refused independently; app and unrelated bytes preserved');
 await writeFile(join(stateDir, 'carried.json'), JSON.stringify([checkout]));
 // One recorded checkout is no longer live. The other live checkout was never recorded.
 await mkdir(join(live, '.rer/local'), { recursive: true, mode: 0o700 });
 await writeFile(carryFile(live), finalCarry, { mode: 0o600 });
 await proof(live); await register([live]);

 assert.ok(!(await readdir(home)).includes('.rer'), 'nothing is written to ~/.rer when RER_BUSINESS_STATE_DIR is set');
 assert.equal((await stat(join(stateDir, 'state.json'))).mode & 0o777, 0o600);
 for (const choice of ['Add rules so Claude Code never reads your secret files', 'Install the background service']) assert.ok(paired.stdout.includes(choice), paired.stdout);
 const [applied, undecided] = paired.stdout.split('The owner has not chosen yet:');
 assert.ok(applied.includes('Keep this computer awake while it works: not allowed') && !undecided.includes('Keep this computer awake while it works'), 'a decided choice is applied and named, not asked again');
 assert.ok(!paired.stdout.includes('connect again to apply'), 'connect never has to run again: run and next apply later choices');
 assert.ok(!/installPermissions|awakeConsent|installService/.test(paired.stdout + paired.stderr), 'internal names never reach a person');
 const status = await cli(home, ['business','status','--json'], { env });
 assert.equal(JSON.parse(status.stdout).paired, true);
 // A server revocation must retain the carry custody record until disconnect,
 // including an earlier checkout that is no longer in the live registry.
 remote.state.revoked = true;
 const revokedRun = await cli(home, ['business','run','--once'], { env });
 assert.equal(revokedRun.code, 0, revokedRun.stderr);
 assert.equal(JSON.parse((await cli(home, ['business','status','--json'], { env })).stdout).revoked, true);
 assert.deepEqual(JSON.parse(await readFile(join(stateDir, 'carried.json'), 'utf8')), [checkout]);
 assert.equal((await cli(home, ['business','disconnect'], { env })).code, 0);
 await assert.rejects(stat(carryFile(checkout)), { code: 'ENOENT' });
 await assert.rejects(stat(carryFile(live)), { code: 'ENOENT' });
 t.diagnostic('disconnect: recorded carry absent; live unrecorded carry absent; carried.json removed');
 assert.deepEqual(await readdir(stateDir), ['keep.txt'], 'disconnect removes only its own files from a named folder');
 delete remote.state.optIns;

 // RER_STATE_DIR is rer demo's variable: Business keeps to ~/.rer/business when only that is set.
 assert.ok((await cli(home, ['business','--help'])).stdout.includes('$RER_BUSINESS_STATE_DIR') && !(await cli(home, ['business','--help'])).stdout.includes('$RER_STATE_DIR'));
 const demoHome = join(directory, 'demo-state-home'), demoState = join(demoHome, 'demo-state');
 await connect(demoHome, remote, { env: { RER_STATE_DIR: demoState } });
 assert.equal((await stat(join(demoHome, '.rer/business/state.json'))).mode & 0o777, 0o600);
 assert.ok(!(await readdir(demoHome)).includes('demo-state'), 'RER_STATE_DIR is never read or written by Business');
 assert.equal((await cli(demoHome, ['business','disconnect'], { env: { RER_STATE_DIR: demoState } })).code, 0);
});

test('browser opt-ins apply without terminal prompts, and disconnect revokes before removing local additions', async t => {
 const remote = await fixtureServer(t);
 const undecidedHome = join(directory, 'undecided-home');
 remote.state.selfMissing = true;
 const undecided = await connect(undecidedHome, remote);
 assert.ok(undecided.stdout.includes(remote.origin + '/business/biz/settings'));
 assert.ok(!(await readdir(undecidedHome)).includes('.claude'));
 assert.equal((await cli(undecidedHome, ['business','status','--json'])).stdout.includes('not_installed'), true);
 assert.equal((await cli(undecidedHome, ['business','connect'])).code, 0, 'connect again on a server without the route stays undecided');
 const unsupported = await cli(undecidedHome, ['business','disconnect']);
 assert.equal(unsupported.code, 0, unsupported.stderr);
 assert.ok(unsupported.stdout.includes('still connected') && unsupported.stdout.includes(remote.origin + '/business/biz/settings') && !unsupported.stdout.includes('Device revoked'));
 assert.equal(remote.state.revoked, false);
 assert.ok((await readFile(join(undecidedHome, 'fake-keychain.json'), 'utf8')).includes(remote.device), 'an unrevoked device keeps its credential');
 remote.state.selfMissing = false;
 remote.state.optIns = { installPermissions: false, awakeConsent: false, installService: false };
 const declined = await cli(undecidedHome, ['business','connect']);
 assert.equal(declined.code, 0); assert.ok(!declined.stdout.includes('[yes/no]'));
 assert.ok(!(await readdir(undecidedHome)).includes('.claude'));
 assert.equal(JSON.parse(await readFile(join(undecidedHome, '.rer/business/state.json'), 'utf8')).awakeConsent, false);
 assert.equal((await cli(undecidedHome, ['business','disconnect'])).code, 0);

 remote.state.optIns = { installPermissions: true, awakeConsent: true, installService: true };
 for (const columns of [160, 43]) {
  const home = join(directory, `cleanup-${columns}-home`);
  await mkdir(join(home, '.claude'), { recursive: true });
  const prior = { permissions: { deny: ['Read(existing/**)'] }, theme: 'dark' };
  await writeFile(join(home, '.claude/settings.json'), JSON.stringify(prior));
  const baseline = await readdir(home);
  const optedIn = await connect(home, remote, { terminal: columns === 43, columns, env: { CLAUDECODE: '1' } });
  assert.ok(!optedIn.stdout.includes('[yes/no]'), 'browser decisions never need terminal answers');
  assert.equal(JSON.parse(await readFile(join(home, '.rer/business/state.json'), 'utf8')).awakeConsent, true);
  const status = await cli(home, ['business','status','--json']);
  assert.equal(status.code, 0); assert.equal(JSON.parse(status.stdout).service, 'running');
  // A read-only key stored by an earlier rer stays recorded by handle; disconnect still removes it.
  const keychainFile = join(home, 'fake-keychain.json'), stateFile = join(home, '.rer/business/state.json'), handle = 'vendor:uptimerobot:read';
  await writeFile(keychainFile, JSON.stringify({ ...JSON.parse(await readFile(keychainFile, 'utf8')), [handle]: 'fixture-read-only-vendor-key' }));
  await writeFile(stateFile, JSON.stringify({ ...JSON.parse(await readFile(stateFile, 'utf8')), vendorHandles: [handle] }), { mode: 0o600 });
  remote.state.revokeRefused = true;
  const refused = await cli(home, ['business','disconnect']);
  assert.equal(refused.code, 1);
  assert.ok(refused.stderr.includes('still connected') && !(refused.stdout + refused.stderr).includes('Device revoked'));
  assert.equal(remote.state.revoked, false);
  assert.ok((await readFile(join(home, 'fake-keychain.json'), 'utf8')).includes(remote.device), 'failed server revocation preserves the credential for retry');
  remote.state.revokeRefused = false;
  const revoked = await cli(home, ['business','disconnect']);
  assert.equal(revoked.code, 0); assert.ok(revoked.stdout.includes('Device revoked'));
  assert.equal(remote.state.revoked, true);
  assert.deepEqual(JSON.parse(await readFile(join(home, '.claude/settings.json'), 'utf8')), prior);
  assert.deepEqual(await readdir(home), baseline, 'service files, parents, keychain items, state and permission additions are removed');
 }
});

test('paired guidance names one applying command and run and next apply later browser choices without reconnecting', async t => {
 const remote = await fixtureServer(t);
 for (const terminal of [false, true]) {
  for (const command of ['next', 'run']) {
   const home = join(directory, `later-choices-${command}-${terminal}`);
   remote.state.optIns = { installPermissions: null, awakeConsent: null, installService: null };
   const paired = await connect(home, remote, { terminal, env: { CLAUDECODE: '1' } });
   assert.match(paired.stdout, /\bbusiness next\b/);
   // An already-paired invocation emits just the successful connection guidance,
   // without the earlier instruction for resuming a pending approval.
   const connected = await cli(home, ['business', 'connect'], { terminal, env: { CLAUDECODE: '1' } });
   assert.equal(connected.code, 0, connected.stderr);
   assert.deepEqual([...new Set(Array.from(connected.stdout.matchAll(/\bbusiness (\w+)\b/g), match => match[1]))], ['next']);
   assert.doesNotMatch(connected.stdout + connected.stderr, /\bconnect\b/);
   assert.ok(!(await readdir(home)).includes('.claude'));
   remote.state.optIns = { installPermissions: true, awakeConsent: true, installService: true };
   const applied = await cli(home, ['business', command, ...(command === 'run' ? ['--once'] : [])], { terminal, env: { CLAUDECODE: '1' } });
   assert.equal(applied.code, 0, applied.stderr);
   assert.equal(JSON.parse(await readFile(join(home, '.rer/business/state.json'), 'utf8')).awakeConsent, true);
   assert.ok((await readdir(join(home, '.claude'))).includes('settings.json'));
   const status = await cli(home, ['business', 'status', '--json']);
   assert.equal(JSON.parse(status.stdout).service, 'running');
   assert.equal(starts(remote), 1, 'applying choices never starts another pairing');
   assert.equal((await cli(home, ['business', 'disconnect'])).code, 0);
   remote.state.requests.length = 0;
  }
 }
});

test('inside an agent sandbox run and next apply the owner\'s choices for its agent and say what they wait for, run.lock never outlives run, and disconnect tells the truth', async t => {
 // A Claude Code computer, whose shell profile also exports CODEX_HOME (it still pairs as Claude Code); the Codex one follows at the end.
 const remote = await fixtureServer(t), home = join(directory, 'sandbox-home'), stateDir = join(home, '.rer-business'), env = { RER_BUSINESS_STATE_DIR: stateDir, CLAUDECODE: '1', CODEX_HOME: join(directory, 'codex-profile-home') };
 await mkdir(home, { recursive: true });
 const folder = await realpath(home), lock = join(stateDir, 'run.lock');
 remote.state.optIns = { installPermissions: null, awakeConsent: null, installService: null };
 const paired = await connect(home, remote, { env });
 assert.ok(paired.stdout.includes('the run and next commands apply the choices at their next check-in, so connect does not need to run again') && !paired.stdout.includes('connect again to apply'), paired.stdout);

 // Before the owner allows its folder, run says exactly what it waits for.
 const waitingRun = await cli(home, ['business','run','--once'], { env });
 assert.equal(waitingRun.code, 0, waitingRun.stderr);
 assert.ok(waitingRun.stdout.includes(`Waiting for the owner to allow scanning ${folder} (names only). They allow it on Your tools: ${remote.origin}/business/biz/tools`) && waitingRun.stdout.endsWith('Nothing yet.\n'), waitingRun.stdout);
 await assert.rejects(stat(lock), { code: 'ENOENT' }, 'run --once removes run.lock');

 // The owner chooses in the browser; the next check-in applies what it can and names what it cannot.
 remote.state.optIns = { installPermissions: true, awakeConsent: true, installService: false };
 // A place this session cannot write, as ~/.claude is inside an agent sandbox (also when tests run as root).
 await writeFile(join(home, '.claude'), '');
 const next = await cli(home, ['business','next'], { env });
 assert.equal(next.code, 0, next.stderr);
 assert.ok(next.stdout.includes("Applied the owner's choices for this computer:\n  - Keep this computer awake while it works: allowed") && next.stdout.includes('Install the background service: not allowed'), next.stdout);
 assert.match(next.stdout, /Not applied yet: Add rules so Claude Code never reads your secret files\. Business could not \w+ \S*\.claude\S*: .*\(E[A-Z]+\)\. The run and next commands try again at each check-in/);
 assert.ok(next.stdout.includes(`RER_BUSINESS_STATE_DIR=${stateDir} `) && next.stdout.endsWith(`Waiting for the owner to allow scanning ${folder} (names only). They allow it on Your tools: ${remote.origin}/business/biz/tools\nNothing yet.\n`), next.stdout);
 assert.equal(JSON.parse(await readFile(join(stateDir, 'state.json'), 'utf8')).awakeConsent, true);
 await rm(join(home, '.claude'));
 const appliedRun = await cli(home, ['business','run','--once'], { env });
 assert.ok(appliedRun.stdout.includes('Add rules so Claude Code never reads your secret files: allowed') && !appliedRun.stdout.includes('Keep this computer awake'), 'each choice is applied and named once');
 assert.ok(JSON.parse(await readFile(join(home, '.claude/settings.json'), 'utf8')).permissions.deny.includes('Read(**/.env)'));
 assert.ok(!(await cli(home, ['business','next'], { env })).stdout.includes('Applied'), 'unchanged choices are not applied again');

 // A long run explains itself and removes run.lock when its terminal closes.
 let hangUp = true;
 const hungUp = await cli(home, ['business','run'], { env, onOutput: (stdout, child) => { if (hangUp && stdout.includes('Waiting for the owner')) { hangUp = false; child.kill('SIGHUP'); } } });
 assert.equal(hungUp.code, 0, hungUp.stderr);
 assert.ok(hungUp.stdout.startsWith("Business run is working this computer's tasks") && hungUp.stdout.includes('stopped (SIGHUP); run.lock removed'), hungUp.stdout);
 await assert.rejects(stat(lock), { code: 'ENOENT' });
 // A lock left by a killed run (its process is gone, or it has not been refreshed) is cleared on the next start.
 const gone = spawn(process.execPath, ['-e', '']); await new Promise(resolve => gone.once('close', resolve));
 for (const [pid, age] of [[gone.pid, 0], [process.pid, 600]]) {
  await writeFile(lock, String(pid)); const then = new Date(Date.now() - age * 1000); await utimes(lock, then, then);
  const restarted = await cli(home, ['business','run','--once'], { env });
  assert.equal(restarted.code, 0, `stale lock (${age ? 'not refreshed' : 'dead process'}) is cleared: ${restarted.stderr}`);
 }
 await writeFile(lock, String(process.pid));
 const competing = await cli(home, ['business','run','--once'], { env });
 assert.equal(competing.code, 1); assert.match(competing.stderr, /already running for this computer \(process \d+\)/);
 await rm(lock);

 // Once its scan is done, run says it waits for the owner's next step.
 remote.state.root = join(home, 'project'); await mkdir(remote.state.root);
 await writeFile(join(remote.state.root, 'package.json'), JSON.stringify({ dependencies: { algoliasearch: '5.0.0' } }));
 remote.state.tasks = [{ task_id: 'sandbox-discover', kind: 'discover.local', state: 'ready', runner: 'executor', fence: 0 }];
 // next has nothing to answer, and says run has work and how to start it.
 const ready = await cli(home, ['business','next'], { env }), escaped = stateDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
 assert.match(ready.stdout, new RegExp(`Ready for run: this computer's names-only scan of the folders the owner allowed\\. Start it with: RER_BUSINESS_STATE_DIR=${escaped} (?:rer|npx -y @runeditrun/rer) business run --once\n$`), 'an agent step waits, so next never says Nothing yet');
 const scanned = await cli(home, ['business','run','--once'], { env });
 assert.equal(scanned.code, 0, scanned.stderr); assert.equal(remote.state.phase, 'done');
 assert.ok(scanned.stdout.includes('Scanning this computer\'s allowed folders for tool names') && scanned.stdout.includes('discover.local completed'), scanned.stdout);

 // Ctrl-C in the terminal that started run through npx, as the prompt says:
 // the SIGINT reaches npx and run together, and npx forwards it to run again.
 // Here Ctrl-C comes again while run hands its lease back, so run certainly
 // gets SIGINT after its first one. It still finishes the handback, removes
 // run.lock and says it stopped.
 const registry = await localRegistry(); t.after(registry.close);
 registry.publish(packed.version, packed.bytes);
 remote.state.root = join(home, 'large-project'); await mkdir(remote.state.root);
 await writeFile(join(remote.state.root, 'package.json'), JSON.stringify({ dependencies: Object.fromEntries(Array.from({ length: 1800 }, (_, index) => [`fixture-library-${index}`, '1.0.0'])) }));
 remote.state.tasks = [{ task_id: 'npx-discover', kind: 'discover.local', state: 'ready', runner: 'executor', fence: 0 }];
 let group;
 remote.state.onHeartbeat = () => { if (remote.state.checkpoint.page === 1) { remote.state.onHeartbeat = null; process.kill(-group.pid, 'SIGINT'); } };
 remote.state.onRelease = () => { remote.state.onRelease = null; process.kill(-group.pid, 'SIGINT'); };
 const npm = { 'npm_config_@runeditrun:registry': `${registry.url}/`, npm_config_cache: join(directory, 'npm-cache'), npm_config_update_notifier: 'false' };
 // npx's own exit status is npm's, and on Linux npm can exit by the signal
 // while run is still handing its lease back, so the test reads run's own
 // output, which is complete once every process holding it has exited.
 const interrupted = await cli(home, ['business','run'], { npx: true, env: { ...env, ...npm }, onSpawn: child => { group = child; } });
 assert.ok(interrupted.stdout.includes('Scanning this computer\'s allowed folders') && interrupted.stdout.endsWith(`Business supervisor stopped (SIGINT); run.lock removed. Run RER_BUSINESS_STATE_DIR=${stateDir} npx -y @runeditrun/rer business run again to continue from the saved checkpoint.\n`), `${interrupted.stdout}\n${interrupted.stderr}`);
 assert.equal(remote.state.released?.reason, 'handover', 'the lease is handed back');
 assert.equal(remote.state.phase, 'ready');
 await assert.rejects(stat(lock), { code: 'ENOENT' });

 remote.state.tasks = [];
 assert.ok((await cli(home, ['business','run','--once'], { env })).stdout.includes(`Waiting for the next task. Nothing needs this computer until the owner moves the plan forward: ${remote.origin}/business/biz`));

 // Inside the sandbox the OS store refuses removal: the server revokes first,
 // disconnect exits 0, says what is still stored and names the one command.
 await writeFile(join(home, 'sandboxed-credential-store'), '');
 const sandboxed = await cli(home, ['business','disconnect'], { env });
 assert.equal(sandboxed.code, 0, sandboxed.stderr);
 assert.equal(remote.state.revoked, true, 'the server revokes before anything local');
 assert.ok(sandboxed.stdout.startsWith('Revoked on the server; the local credential is still stored.'), sandboxed.stdout);
 assert.ok(sandboxed.stdout.includes(`run outside the agent sandbox or in your own terminal:\n  RER_BUSINESS_STATE_DIR=${stateDir} `) && /business disconnect\n/.test(sandboxed.stdout), sandboxed.stdout);
 if (process.platform === 'darwin') assert.ok(sandboxed.stdout.includes('security exited with status 161'), sandboxed.stdout);
 assert.ok((await readFile(join(home, 'fake-keychain.json'), 'utf8')).includes(remote.device), 'the refused removal left the credential');
 const status = await cli(home, ['business','status'], { env });
 assert.ok(status.stdout.startsWith('Business: revoked on the server; the local credential is still stored.') && !status.stdout.includes('paired'), status.stdout);
 assert.deepEqual(JSON.parse((await cli(home, ['business','status','--json'], { env })).stdout).revoked, true);
 for (const verb of [['next'], ['run','--once'], ['connect']]) {
  const refused = await cli(home, ['business', ...verb], { env });
  assert.equal(refused.code, 1); assert.ok(refused.stderr.includes('This computer was revoked on the server; the local credential is still stored.'), refused.stderr);
 }
 // The named command, outside the sandbox, finishes.
 await rm(join(home, 'sandboxed-credential-store'));
 const finished = await cli(home, ['business','disconnect'], { env });
 assert.equal(finished.code, 0, finished.stderr); assert.ok(finished.stdout.includes('Device was already revoked'), finished.stdout);
 await assert.rejects(readFile(join(home, 'fake-keychain.json')), { code: 'ENOENT' });
 assert.ok(!(await readdir(home)).includes('.rer-business'));

 // On a Codex computer the secret-file rules have nothing to apply to: nothing
 // is written under ~/.claude, nothing asks for a run outside the sandbox, and
 // that is said once, whatever the owner chose. A default Codex install sets
 // CODEX_THREAD_ID but not CODEX_HOME, and Codex is told apart before Claude Code.
 const codexHome = join(directory, 'codex-home'), codexEnv = { RER_BUSINESS_STATE_DIR: join(codexHome, '.rer-business'), CODEX_THREAD_ID: 'thread-1', CLAUDECODE: '1' };
 remote.state.optIns = { installPermissions: null, awakeConsent: null, installService: null };
 const codex = await connect(codexHome, remote, { env: codexEnv });
 const notApplicable = 'Secret-file rules do not apply on Codex: Business has no way yet to stop Codex from reading your secret files';
 assert.ok(codex.stdout.includes(notApplicable) && codex.stdout.includes('The owner has not chosen yet:') && !codex.stdout.includes('never reads your secret files'), codex.stdout);
 remote.state.optIns = { installPermissions: true, awakeConsent: false, installService: false };
 const codexNext = await cli(codexHome, ['business','next'], { env: codexEnv });
 assert.equal(codexNext.code, 0, codexNext.stderr);
 assert.ok(codexNext.stdout.includes("Applied the owner's choices for this computer:\n  - Keep this computer awake while it works: not allowed"), codexNext.stdout);
 const codexRun = await cli(codexHome, ['business','run','--once'], { env: codexEnv });
 assert.equal(codexRun.code, 0, codexRun.stderr);
 for (const later of [codexNext, codexRun]) assert.ok(!/secret files|Claude Code|outside the agent sandbox/.test(later.stdout + later.stderr), later.stdout);
 assert.ok(!(await readdir(codexHome)).includes('.claude'), 'nothing is written under ~/.claude');
 assert.equal((await cli(codexHome, ['business','disconnect'], { env: codexEnv })).code, 0);
 assert.equal(remote.state.agentKind, 'codex');

 // An agent that is neither (no marker at all) is reported as other, and the
 // rules do not apply to it either.
 const otherHome = join(directory, 'other-home'), otherEnv = { RER_BUSINESS_STATE_DIR: join(otherHome, '.rer-business') };
 remote.state.optIns = { installPermissions: null, awakeConsent: null, installService: null };
 const other = await connect(otherHome, remote, { env: otherEnv });
 assert.equal(remote.state.agentKind, 'other');
 assert.equal(other.stdout.split('Secret-file rules do not apply on this computer').length - 1, 1, other.stdout);
 remote.state.optIns = { installPermissions: true, awakeConsent: false, installService: false };
 for (const command of [['business','next'], ['business','run','--once']]) {
  const later = await cli(otherHome, command, { env: otherEnv });
  assert.equal(later.code, 0, later.stderr);
  assert.ok(!/secret files|Claude Code|outside the agent sandbox/.test(later.stdout + later.stderr), later.stdout);
 }
 assert.ok(!(await readdir(otherHome)).includes('.claude'), 'nothing is written under ~/.claude');
 assert.equal((await cli(otherHome, ['business','disconnect'], { env: otherEnv })).code, 0);
});

test('a Move in step names the seed\'s own Move in page and how to export, and finishes with a note; nothing is exported or claimed by run', async t => {
 const remote = await fixtureServer(t), home = join(directory, 'move-in-home');
 await connect(home, remote);
 remote.state.optIns = { installPermissions: false, awakeConsent: false, installService: false };
 // The step as Business sends it: its view of the seed's pinned importers.json row.
 const formatLink = 'https://github.com/just-every/run-lamp/blob/0123456789abcdef0123456789abcdef01234567/docs/LEGACY-EXPORT.md';
 const view = (move_in, app_address = 'https://status.example.test') => ({ tool: 'Sorry', vendor_id: 'sorry', decision: 'moves', app: 'lamp', app_name: 'Lamp', app_address, move_in,
  instructions: 'Open Lamp’s Move in page and follow its steps there.' });
 const declared = { state: 'declared', address: 'https://status.example.test/app/move-in', path: '/app/move-in', accepts: ['file', 'key'],
  export: 'In Sorry, open Settings, then Export, and download the JSON file.', format: formatLink };
 const move_in = view(declared);
 remote.state.tasks = [{ task_id: 'biz:move-in:sorry', kind: 'move.in', state: 'ready', runner: 'executor', fence: 0, title: 'Move Sorry into Lamp', move_in }];
 const next = await cli(home, ['business', 'next']);
 assert.equal(next.code, 0, next.stderr);
 for (const line of ['Agent: biz:move-in:sorry', 'Move Sorry into Lamp', 'https://status.example.test/app/move-in', 'a file export from the old tool', "a read-only key for the old tool", 'In Sorry, open Settings, then Export', 'docs/LEGACY-EXPORT.md', 'rer business done biz:move-in:sorry --note'])
  assert.ok(next.stdout.includes(line), `${line}\n${next.stdout}`);
 const running = await cli(home, ['business', 'run', '--once']);
 assert.equal(running.code, 0, running.stderr);
 assert.match(running.stdout, /A Move in step waits for this computer's agent/);
 assert.equal(remote.state.requests.filter(entry => entry.route === '/api/business/executors/claim').length, 0, 'run never claims a Move in step');
 // A declared page on an app without an address yet names the page's path.
 remote.state.tasks = [{ task_id: 'biz:move-in:pending', kind: 'move.in', state: 'ready', runner: 'executor', fence: 0, move_in: view({ ...declared, address: null }, null) }];
 const pending = await cli(home, ['business', 'next']);
 assert.ok(pending.stdout.includes('/app/move-in on the seed, once it has an address') && pending.stdout.includes('In Sorry, open Settings, then Export'), pending.stdout);
 // A seed that declares no Move in page says so, and never guesses one.
 remote.state.tasks = [{ task_id: 'biz:move-in:none', kind: 'move.in', state: 'ready', runner: 'executor', fence: 0, move_in: { ...view({ state: 'not_declared' }), tool: 'NewTool' } }];
 const undeclared = await cli(home, ['business', 'next']);
 assert.ok(undeclared.stdout.includes('declares no Move in page') && undeclared.stdout.includes('https://status.example.test') && !undeclared.stdout.includes('/app/move-in'), undeclared.stdout);
 // A seed with its own import format but no importer for the tool links that format.
 remote.state.tasks = [{ task_id: 'biz:move-in:format', kind: 'move.in', state: 'ready', runner: 'executor', fence: 0, move_in: { ...view({ state: 'format', format: formatLink }), tool: 'NewTool' } }];
 const formatOnly = await cli(home, ['business', 'next']);
 assert.ok(formatOnly.stdout.includes('declares no Move in page') && formatOnly.stdout.includes(formatLink) && !formatOnly.stdout.includes('/app/move-in'), formatOnly.stdout);
 // Server text that looks like a credential, or an address with credentials, never reaches the agent's output.
 remote.state.tasks = [{ task_id: 'biz:move-in:unsafe', kind: 'move.in', state: 'ready', runner: 'executor', fence: 0,
  move_in: view({ ...declared, address: 'https://owner:fixture-password@status.example.test/app/move-in', path: '/app/move-in?token=sk_live_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4',
   format: formatLink.replace('LEGACY-EXPORT', 'sk_live_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4'), export: 'Use key sk_live_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4' }) }];
 const unsafe = await cli(home, ['business', 'next']);
 assert.ok(!unsafe.stdout.includes('fixture-password') && !unsafe.stdout.includes('sk_live_') && unsafe.stdout.includes('declares no Move in page'), unsafe.stdout);
 remote.state.tasks = [{ task_id: 'biz:move-in:sorry', kind: 'move.in', state: 'ready', runner: 'executor', fence: 0, move_in }];
 const finished = await cli(home, ['business', 'done', 'biz:move-in:sorry', '--note', 'Moved 214 tickets; dry run counts matched.']);
 assert.equal(finished.code, 0, finished.stderr);
 assert.deepEqual(remote.state.moveInCompleted, { note: 'Moved 214 tickets; dry run counts matched.' });
 assert.equal((await cli(home, ['business', 'done', 'biz:move-in:sorry'])).code, 2, 'a note is required');
 remote.state.tasks = [{ task_id: 'question9', kind: 'classify.row', state: 'ready', runner: 'executor', fence: 0 }];
 assert.equal((await cli(home, ['business', 'done', 'question9', '--note', 'x'])).code, 1, 'only a Move in step finishes with a note');
 assert.equal((await cli(home, ['business', 'disconnect'])).code, 0);
});

test('a refused claim fails once with its original message, clears the saved claim and retries at the next check-in', async t => {
 const remote = await fixtureServer(t), home = join(directory, 'claim-refusal-home'), stateDir = join(home, '.rer-business');
 const env = { RER_BUSINESS_STATE_DIR: stateDir };
 await connect(home, remote, { env });
 remote.state.optIns = { installPermissions: false, awakeConsent: false, installService: false };
 const task = id => ({ task_id: id, kind: 'discover.local', state: 'ready', runner: 'executor', fence: 0 });
 const claimCount = () => remote.state.requests.filter(request => request.route === '/api/business/executors/claim').length;

 // Only the network edge is overridden for a genuinely malformed body.
 let rawClaim = null;
 const emit = Server.prototype.emit;
 t.mock.method(Server.prototype, 'emit', function (event, request, response) {
  if (event === 'request' && rawClaim !== null && request.socket.localPort === Number(new URL(remote.origin).port) && request.url === '/api/business/executors/claim') {
   let body = '';
   request.on('data', chunk => { body += chunk; });
   request.on('end', () => {
    remote.state.requests.push({ route: request.url, body: JSON.parse(body) });
    response.writeHead(409, { 'content-type': 'application/json' }); response.end(rawClaim);
   });
   return true;
  }
  return emit.apply(this, arguments);
 });
 // Every claim refusal fails
 // once, but clears progress and retries at the next continuous check-in.
 for (const [status, code, state, raw] of [[403, 'business_catchup_approval_required'], [500, 'business_export_inputs_required', 'waiting_for_owner'],
  [409, 'business_export_inputs_required'], [409, 'another_conflict', 'waiting_for_owner'], [409, 'business_catchup_grant_ended'], [409, 'business_paused'], [409], [409, undefined, undefined, '{"error":']]) {
  remote.state.tasks = [task(`biz:refused:${status}:${code}`)];
  const message = raw ?? `original refusal ${status}`;
  remote.state.claimRefusal = [{ error: message, code, ...(state ? { state } : {}) }, status];
  rawClaim = raw ?? null;
  for (const args of status === 409 ? [['run', '--once']] : [['run', '--once'], ['run']]) {
   const refused = await cli(home, ['business', ...args], { env });
   assert.equal(refused.code, 1);
   assert.ok(refused.stderr.includes(`HTTP ${status}`) && refused.stderr.includes(message), refused.stderr);
  }
  if (status === 409) {
   assert.deepEqual(JSON.parse(await readFile(join(stateDir, 'progress.json'), 'utf8')), {}, 'once clears a refused claim');
   const claims = claimCount(); let retryChecked = false, runner, stopTimer;
   remote.state.onSelf = async () => {
    if (claimCount() === claims) return;
    assert.deepEqual(JSON.parse(await readFile(join(stateDir, 'progress.json'), 'utf8')), {}, 'the refused claim is gone before retry');
    retryChecked = true; stopTimer = setTimeout(() => runner.kill('SIGTERM'), 250);
   };
   const continuous = await cli(home, ['business', 'run'], { env, onSpawn: child => { runner = child; } });
   clearTimeout(stopTimer); remote.state.onSelf = null;
   assert.equal(continuous.code, 0, continuous.stderr);
   assert.equal(continuous.stderr, '');
   assert.ok(retryChecked, 'continuous survives to its next check-in');
   const retried = remote.state.requests.filter(request => request.route === '/api/business/executors/claim').slice(claims);
   assert.equal(retried.length, 2, 'one fresh claim after the check-in');
   assert.notEqual(retried[0].body.claim_id, retried[1].body.claim_id, 'the retry never replays the refused claim');
   assert.deepEqual(JSON.parse(await readFile(join(stateDir, 'progress.json'), 'utf8')), {}, 'no stale pendingClaim after retry');
  }
  t.diagnostic(`PROBE refused: HTTP ${status} ${code ?? 'no code'} ${raw ? 'malformed body' : ''} -> once exit=1, original message retained; continuous ${status === 409 ? 'retries with cleared progress' : 'exit=1'}`);
 }
 remote.state.claimRefusal = null;
 const ended = await deviceOwner(remote, 'approve');
 assert.equal(ended.status, 409);
 assert.equal((await ended.json()).status, 'connected');
});
