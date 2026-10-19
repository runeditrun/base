import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { server, classificationSchema } from './fixtures/business/server.mjs';
import { door } from './fixtures/business/door.mjs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { buildPackage } from '../scripts/rer-package.mjs';
import { integrity, localRegistry } from '../scripts/rer-package/registry.mjs';
import { readPackage, writePackage } from '../global/update/archive.mjs';
import { userInfo } from 'node:os';
import { realpath } from 'node:fs/promises';

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
async function cli(home, args, { terminal = false, npx = false, input = '', columns = 120, onSpawn, onOutput, env: extra = {}, path = process.env.PATH } = {}) {
 await mkdir(home, { recursive: true });
 const env = { PATH: path, HOME: home, RER_NO_UPDATE_CHECK: '1', NODE_OPTIONS: `--import=${fileURLToPath(new URL('./fixtures/business/register.mjs', import.meta.url))}`, TEST_COLUMNS: String(columns), ...extra };
 return new Promise((resolveRun, reject) => {
  const command = terminal ? 'python3' : npx ? 'npx' : process.execPath;
  const parameters = terminal ? [join(fixture, 'terminal.py'), process.execPath, launcher, ...args] : npx ? ['-y', '@runeditrun/rer', ...args] : [launcher, ...args];
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
// The fixture answers polls every second instead of the platform's five.
async function fixtureServer(t) {
 const remote = await server(t);
 remote.state.pollSeconds = 1;
 return remote;
}
const approve = remote => fetch(remote.origin + '/api/business/biz/pairings/pair1/approve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmed: true, confirmation_number: '246810' }) });
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
 const starts = () => remote.state.requests.filter(entry => entry.route === '/api/business/executors/pair' && entry.body.code).length;
 const before = starts(), stateDir = options.env?.RER_BUSINESS_STATE_DIR ?? join(home, '.rer/business');
 remote.state.onSelf = async () => {
  const saved = JSON.parse(await readFile(join(stateDir, 'state.json'), 'utf8'));
  assert.equal(saved.executorId, 'executor1');
  assert.ok((await readFile(join(home, 'fake-keychain.json'), 'utf8')).includes(remote.device), 'credential is stored before activation');
 };
 const result = await connectWhile(home, ['--code','ABCD-1234','--origin',remote.origin], async () => {
  assert.equal(remote.state.active, false, 'an unapproved computer is not active');
  assert.equal((await stat(join(stateDir, 'pairing.json'))).mode & 0o777, 0o600, 'the pairing is saved before waiting');
  await approve(remote);
 }, options);
 remote.state.onSelf = null;
 assert.equal(starts(), before + 1, 'one run redeems the code once and collects its approval');
 // The redeeming request names the computer plainly and the folder connect ran in.
 const redeeming = remote.state.requests.filter(entry => entry.route === '/api/business/executors/pair' && entry.body.code).at(-1).body;
 assert.ok(typeof redeeming.device_name === 'string' && /^[^\x00-\x1f\x7f/\\]{1,64}$/.test(redeeming.device_name) && redeeming.device_name === redeeming.device_name.trim(), `device_name is a plain name of at most 64 characters: ${redeeming.device_name}`);
 assert.ok(!redeeming.device_name.toLowerCase().includes(userInfo().username.toLowerCase()) || userInfo().username.length < 2, 'the name carries no login name');
 assert.equal(redeeming.working_folder, await realpath(home), 'working_folder is the absolute folder connect ran in');
 assert.ok(result.stdout.includes('246810'), 'the browser comparison number is printed');
 assert.equal(result.code, 0, `connect waits and exits 0 once approved and active: ${result.stderr}`);
 assert.equal(remote.state.active, true, 'exit 0 means the server has seen the computer');
 assert.ok(result.stdout.includes('This computer is connected to Business'), result.stdout);
 assert.ok(!result.stdout.includes(remote.device) && !result.stderr.includes(remote.device), 'device credential stays out of both streams');
 return result;
}

test('packed CLI pairs only after number approval and keeps keys and untrusted task text out of agent output', async t => {
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
 const key = 'fixture-vendor-secret-never-output';
 const added = await cli(home, ['business','vendor-key','add','sentry'], { terminal: true, input: key + '\n' });
 assert.equal(added.code, 0); assert.ok(added.stdout.includes('sentry:read'));
 assert.ok(!added.stdout.includes(key) && !added.stderr.includes(key));
 const stored = await readFile(join(home, '.rer/business/state.json'), 'utf8');
 assert.ok(!stored.includes(key) && !stored.includes(remote.device), 'only handles belong in configuration');
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
 remote.state.tasks = [{ task_id: 'export1', kind: 'export.vendor', state: 'ready', runner: 'executor', fence: 0 }];
 const exported = await cli(home, ['business','run','--once']);
 assert.equal(exported.code, 1);
 assert.match(exported.stderr, /unavailable: no-linked-installation/);
 assert.equal(remote.state.released.reason, 'paused');
 assert.ok(remote.state.requests.some(entry => entry.route === '/api/business/tasks/export1/events' && entry.body.event?.payload.question === 'connected_runner_required'));
 assert.equal(remote.state.requests.filter(entry => entry.route === '/api/business/tasks/export1/uploads').length, 0);
 assert.ok(!JSON.stringify(remote.state.requests).includes(key), 'vendor key never reaches the server');
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
 const remote = await fixtureServer(t);
 const redemptions = () => remote.state.requests.filter(entry => entry.body.code).length;
 const pendingHome = join(directory, 'pending-home');
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
 const onPath = join(directory, 'rer-on-path');
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
  const lockedHome = join(directory, `${marker}-home`);
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
  const unlocked = await connect(lockedHome, remote);
  assert.ok(unlocked.stdout.includes('246810'), 'the same code still pairs once the store is available');
  assert.equal((await cli(lockedHome, ['business','disconnect'])).code, 0);
 }

 // An approval near the code's end extends the server's expiry; a later run still collects it.
 const lateHome = join(directory, 'late-approval-home');
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
 const failedHome = join(directory, 'storage-failed-home');
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

test('connect keeps its state where RER_BUSINESS_STATE_DIR says, checks it before redeeming, and asks for choices in plain words', async t => {
 const remote = await fixtureServer(t);
 const redemptions = () => remote.state.requests.filter(entry => entry.body.code).length;
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
 const env = { RER_BUSINESS_STATE_DIR: stateDir, CLAUDECODE: '1' };
 remote.state.optIns = { installPermissions: null, awakeConsent: false, installService: null };
 const paired = await connect(home, remote, { env });
 assert.equal(redemptions(), before + 1, 'the same code pairs once the folder is writable');
 assert.ok(!(await readdir(home)).includes('.rer'), 'nothing is written to ~/.rer when RER_BUSINESS_STATE_DIR is set');
 assert.equal((await stat(join(stateDir, 'state.json'))).mode & 0o777, 0o600);
 for (const choice of ['Add rules so Claude Code never reads your secret files', 'Install the background service']) assert.ok(paired.stdout.includes(choice), paired.stdout);
 const [applied, undecided] = paired.stdout.split('The owner has not chosen yet:');
 assert.ok(applied.includes('Keep this computer awake while it works: not allowed') && !undecided.includes('Keep this computer awake while it works'), 'a decided choice is applied and named, not asked again');
 assert.ok(!paired.stdout.includes('connect again to apply'), 'connect never has to run again: run and next apply later choices');
 assert.ok(!/installPermissions|awakeConsent|installService/.test(paired.stdout + paired.stderr), 'internal names never reach a person');
 const status = await cli(home, ['business','status','--json'], { env });
 assert.equal(JSON.parse(status.stdout).paired, true);
 assert.equal((await cli(home, ['business','disconnect'], { env })).code, 0);
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
  assert.equal((await cli(home, ['business','vendor-key','add','uptimerobot'], { terminal: true, input: 'fixture-read-only-vendor-key\n' })).code, 0);
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
 assert.match(ready.stdout, new RegExp(`Ready for run: this computer's names-only scan of the folders the owner allowed\\. Start it with: RER_BUSINESS_STATE_DIR=${escaped} (?:rer|npx -y @runeditrun/rer) business run\n$`), 'an agent step waits, so next never says Nothing yet');
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

test('an agent exports a vendor into its app\'s import door: next names the owner-typed key step, run sends 64 KiB chunks with fresh grants and leaves a preview, and nothing secret is printed or kept', async t => {
 const remote = await fixtureServer(t), seed = await door(t), home = join(directory, 'export-home'), stateDir = join(home, '.rer-business');
 const env = { RER_BUSINESS_STATE_DIR: stateDir }, escaped = stateDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
 // The shipped adapter's fixed vendor origin is answered at the network edge.
 const vendorEnv = { ...env, NODE_OPTIONS: `--import=${join(fixture, 'register.mjs')} --import=${join(fixture, 'vendor-edge.mjs')}` };
 await connect(home, remote, { env });
 seed.state.stateDir = stateDir;
 // Claim is done and the app's door is on: the export is the agent's step.
 remote.state.door = seed;
 remote.state.tasks = [{ task_id: 'biz:seed:uptime:export:tool1', kind: 'export.vendor', state: 'ready', runner: 'executor', fence: 0, title: 'Export UptimeRobot history', instruction: 'untrusted-run-command-canary' }];
 const outputs = [];
 const next = await cli(home, ['business','next'], { env }); outputs.push(next);
 assert.equal(next.code, 0, next.stderr);
 assert.match(next.stdout, new RegExp(`(?:^|\\n)Agent: biz:seed:uptime:export:tool1\\n[\\s\\S]*ask the owner to type this in their own terminal[\\s\\S]*\\n  RER_BUSINESS_STATE_DIR=${escaped} (?:rer|npx -y @runeditrun/rer) business vendor-key add uptimerobot\\nThen run: RER_BUSINESS_STATE_DIR=${escaped} (?:rer|npx -y @runeditrun/rer) business run\\n$`), next.stdout);
 assert.ok(!next.stdout.includes('Nothing yet') && !next.stdout.includes('untrusted-run-command-canary'), next.stdout);

 // Without the owner's key, run hands the task back as paused and names the owner's command, not "Nothing yet".
 const keyless = await cli(home, ['business','run','--once'], { env: vendorEnv }); outputs.push(keyless);
 assert.equal(keyless.code, 1, keyless.stdout);
 assert.ok(keyless.stderr.includes('business vendor-key add uptimerobot') && !keyless.stdout.includes('Nothing yet'), keyless.stderr);
 assert.equal(remote.state.released.reason, 'paused');
 assert.ok(remote.state.requests.some(entry => entry.route === '/api/business/tasks/biz%3Aseed%3Auptime%3Aexport%3Atool1/events' && entry.body.event?.payload.question === 'owner_required'));
 assert.equal(seed.state.requests.length, 0, 'nothing reaches the door without a key');

 // The owner types the key in a terminal; it goes to the OS credential store (the fixture keychain seam).
 const key = 'fixture-uptimerobot-read-only-key-never-output';
 const added = await cli(home, ['business','vendor-key','add','uptimerobot'], { terminal: true, input: key + '\n', env }); outputs.push(added);
 assert.equal(added.code, 0, added.stderr);
 const stored = await cli(home, ['business','next'], { env }); outputs.push(stored);
 assert.ok(stored.stdout.includes("the owner's read-only UptimeRobot key is stored") && stored.stdout.includes('business vendor-key add uptimerobot'), stored.stdout);

 // An earlier run here was stopped mid-export and Business still holds its lease: next names the export step and run
 // says it waits for that lease to end, never "Nothing yet".
 const [exportTask] = remote.state.tasks;
 remote.state.tasks = [{ ...exportTask, state: 'leased', fence: 3 }];
 const heldNext = await cli(home, ['business','next'], { env }); outputs.push(heldNext);
 const heldRun = await cli(home, ['business','run','--once'], { env: vendorEnv }); outputs.push(heldRun);
 assert.equal(heldRun.code, 0, heldRun.stderr);
 assert.ok(heldNext.stdout.includes('Agent: biz:seed:uptime:export:tool1') && !heldNext.stdout.includes('Nothing yet'), heldNext.stdout);
 assert.ok(heldRun.stdout.includes('Waiting for the server to hand back the task this computer was doing when it stopped; its earlier lease has not ended yet.') && !heldRun.stdout.includes('Nothing yet'), heldRun.stdout);
 assert.equal(seed.state.requests.length, 0, 'nothing reaches the door while the earlier lease holds');
 // The lease ends and Business hands the export back.
 remote.state.tasks = [exportTask];

 const grantsBefore = remote.state.importGrants;
 const exported = await cli(home, ['business','run','--once'], { env: vendorEnv }); outputs.push(exported);
 assert.equal(exported.code, 0, exported.stderr);
 assert.equal(remote.state.phase, 'done', 'Business completed the export after its door held the plan');
 // The completion reports identifiers only: the door's upload and plan and the bundle's hash.
 const completed = remote.state.requests.find(entry => entry.route === '/api/business/tasks/biz%3Aseed%3Auptime%3Aexport%3Atool1/complete');
 assert.deepEqual(completed.body.outputs, { upload_id: seed.state.plans[0].uploadId, plan_id: seed.state.plans[0].planId, bundle_sha256: seed.state.plans[0].bundleSha256 });
 assert.ok(exported.stdout.includes(`Import preview ready in ${seed.origin}: 600 source records; 600 to create, 0 to update, 0 unchanged, 0 rejected. Nothing was imported`), exported.stdout);
 assert.deepEqual((await readFile(join(home, 'vendor-requests.log'), 'utf8')).trim().split('\n'), ['/v3/monitors?limit=200 authorized', '/v3/monitors?limit=200&cursor=page2 authorized'], 'the shipped adapter read the vendor with the stored key');
 // 64 KiB chunks, each with its own single-use grant, then the plan: a preview with no native writes.
 const [upload] = seed.state.uploads.values(), uploads = seed.state.requests.filter(entry => entry.url === '/api/rer/import/uploads');
 assert.ok(upload.totalChunks >= 2 && uploads.length === upload.totalChunks && upload.name === 'uptimerobot-monitors.json', `${upload.totalChunks} chunks`);
 assert.deepEqual(uploads.map(entry => JSON.parse(entry.body).index), [...uploads.keys()]);
 assert.ok(uploads.slice(0, -1).every(entry => Buffer.from(JSON.parse(entry.body).base64, 'base64').length === 65_536));
 const authorizations = seed.state.requests.map(entry => entry.authorization);
 assert.equal(new Set(authorizations).size, authorizations.length, 'every door request carries a fresh grant');
 assert.equal(remote.state.importGrants - grantsBefore, authorizations.length, 'each grant was asked of Business for one request');
 assert.equal(seed.state.plans.length, 1); assert.equal(seed.state.nativeWrites, 0, 'the import is a zero-write preview');
 assert.deepEqual(upload.bytes.toString('utf8').trim().split('\n').flatMap(line => JSON.parse(line).data).map(monitor => monitor.id), Array.from({ length: 600 }, (_, index) => 800000 + index));
 // The bundle was a private 0600 state file while it uploaded, and is gone after completion.
 assert.ok(seed.state.bundleModes.length >= 2 && seed.state.bundleModes.every(mode => mode === 0o600), JSON.stringify(seed.state.bundleModes));
 assert.ok(!(await readdir(stateDir)).some(name => name.endsWith('.bundle')), 'the bundle is removed after completion');
 // The key is never printed, sent to Business or the door, or kept outside the OS store; vendor records are never printed.
 const printed = outputs.map(result => result.stdout + result.stderr).join('');
 assert.ok(!printed.includes(key) && !printed.includes('Fixture monitor'), 'neither the key nor vendor records are printed');
 assert.ok(!JSON.stringify(remote.state.requests).includes(key) && !JSON.stringify(seed.state.requests).includes(key), 'the key reaches neither Business nor the door');
 for (const name of await readdir(stateDir)) assert.ok(!(await readFile(join(stateDir, name), 'utf8')).includes(key), `${name} holds no key`);
 assert.ok((await readFile(join(home, 'fake-keychain.json'), 'utf8')).includes(key), 'the key lives in the OS credential store');
 // With the export done and nothing else waiting, next and run say so.
 assert.ok((await cli(home, ['business','next'], { env })).stdout.endsWith('Nothing yet.\n'));
 assert.equal((await cli(home, ['business','disconnect'], { env })).code, 0);
 await assert.rejects(readFile(join(home, 'fake-keychain.json')), { code: 'ENOENT' }, 'disconnect removes the vendor key');
});

test('an agent catches up and archives a vendor through its app\'s import door, and next names freeze, rollback cards and cancellation as the owner\'s steps with their links', async t => {
 const remote = await fixtureServer(t), seed = await door(t), home = join(directory, 'switch-home'), stateDir = join(home, '.rer-business');
 const env = { RER_BUSINESS_STATE_DIR: stateDir };
 const vendorEnv = { ...env, NODE_OPTIONS: `--import=${join(fixture, 'register.mjs')} --import=${join(fixture, 'vendor-edge.mjs')}` };
 await connect(home, remote, { env });
 seed.state.stateDir = stateDir; remote.state.door = seed;
 const key = 'fixture-uptimerobot-read-only-key-for-the-switch', outputs = [];
 const added = await cli(home, ['business','vendor-key','add','uptimerobot'], { terminal: true, input: key + '\n', env }); outputs.push(added);
 assert.equal(added.code, 0, added.stderr);
 const completed = id => remote.state.requests.find(entry => entry.route === `/api/business/tasks/${encodeURIComponent(id)}/complete`);
 const grantsAsked = id => remote.state.requests.filter(entry => entry.route === `/api/business/tasks/${encodeURIComponent(id)}/import-grants`).map(entry => entry.body);

 // A move's owner steps: next names each with its link and run waits for it; neither offers it as agent work.
 const board = `${remote.origin}/business/biz`, page = `${board}/moves/tool1`;
 for (const [kind, title, words] of [['freeze.vendor', 'Freeze UptimeRobot before the switch', 'freeze UptimeRobot'], ['rollback.dns', 'Undo the DNS switch', 'rollback card'], ['switchoff.cancel', 'Cancel UptimeRobot', 'cancel UptimeRobot at the vendor']]) {
  remote.state.tasks = [{ task_id: `biz:tool1:${kind}`, kind, state: 'ready', runner: 'owner', fence: 0, title, tool_id: 'tool1' }];
  const next = await cli(home, ['business','next'], { env }), waited = await cli(home, ['business','run','--once'], { env }); outputs.push(next, waited);
  assert.equal(next.code, 0, next.stderr); assert.equal(waited.code, 0, waited.stderr);
  assert.ok((`\n${next.stdout}`).includes(`\nOwner: biz:tool1:${kind}\n`) && next.stdout.includes(words) && next.stdout.endsWith(`In the browser: ${page}\n`), next.stdout);
  assert.ok(!next.stdout.includes('Agent:') && !next.stdout.includes('business run') && !next.stdout.includes('vendor-key'), next.stdout);
  assert.ok(waited.stdout.includes(words) && waited.stdout.includes(page), waited.stdout);
 }
 remote.state.tasks = [{ task_id: 'biz:freeze', kind: 'freeze.vendor', state: 'ready', runner: 'owner', fence: 0, title: 'Freeze UptimeRobot before the switch' }];
 const boardNext = await cli(home, ['business','next'], { env });
 assert.ok(boardNext.stdout.endsWith(`In the browser: ${board}\n`), `a step that names no tool links the switch-over board: ${boardNext.stdout}`);
 assert.equal(seed.state.requests.length, 0, 'no owner step reaches the door');

 // A catch-up within the owner's standing approval: 10 new monitors on a 590-monitor import. Next names the agent's
 // own step before an owner step listed ahead of it.
 const ids = Array.from({ length: 600 }, (_, index) => String(800000 + index));
 seed.state.baselines.set('uptimerobot', ids.slice(0, 590)); remote.state.standingApproval = true;
 remote.state.tasks = [remote.state.tasks[0], { task_id: 'biz:tool1:catchup1', kind: 'catchup.vendor', state: 'ready', runner: 'executor', fence: 0, title: 'Bring over recent UptimeRobot changes' }];
 const catchupNext = await cli(home, ['business','next'], { env }); outputs.push(catchupNext);
 assert.ok((`\n${catchupNext.stdout}`).includes('\nAgent: biz:tool1:catchup1\n') && catchupNext.stdout.includes('catch-up') && catchupNext.stdout.includes("read-only UptimeRobot key is stored")
  && /\nThen run: .*business run\n$/.test(catchupNext.stdout), catchupNext.stdout);
 const bounded = await cli(home, ['business','run','--once'], { env: vendorEnv }); outputs.push(bounded);
 assert.equal(bounded.code, 0, bounded.stderr);
 const [standing] = seed.state.plans;
 assert.ok(standing.catchup && standing.standing && standing.records === 600, 'the door planned a catch-up under the standing approval');
 assert.deepEqual(completed('biz:tool1:catchup1').body.outputs, { upload_id: standing.uploadId, plan_id: standing.planId, bundle_sha256: standing.bundleSha256 });
 assert.deepEqual(JSON.parse(seed.state.requests.find(entry => entry.url === '/api/rer/import/plan').body), { uploadId: standing.uploadId, catchup: true });
 assert.ok(bounded.stdout.includes('10 new') && bounded.stdout.includes('590 unchanged') && bounded.stdout.includes('standing catch-up approval'), bounded.stdout);

 // Business applies it under the standing approval. The vendor is then unchanged: its export is the same bundle as
 // that applied plan, and the door plans a catch-up of no changes for this upload, which run completes with.
 seed.apply(standing.planId);
 remote.state.tasks = [{ task_id: 'biz:tool1:catchup-unchanged', kind: 'catchup.vendor', state: 'ready', runner: 'executor', fence: 0, title: 'Bring over recent UptimeRobot changes' }];
 const quiet = await cli(home, ['business','run','--once'], { env: vendorEnv }); outputs.push(quiet);
 assert.equal(quiet.code, 0, quiet.stderr);
 const unchanged = seed.state.plans.at(-1), latest = [...seed.state.uploads.values()].at(-1);
 assert.ok(unchanged.planId !== standing.planId && unchanged.bundleSha256 === standing.bundleSha256 && unchanged.uploadId === latest.id, 'the same bundle planned afresh for this upload');
 assert.ok(unchanged.catchup && unchanged.standing, 'the door planned a catch-up under the standing approval');
 assert.deepEqual(unchanged.preview.summary, { sourceRecords: 600, created: 0, updated: 0, unchanged: 600, gone: 0 });
 assert.deepEqual(completed('biz:tool1:catchup-unchanged').body.outputs, { upload_id: latest.id, plan_id: unchanged.planId, bundle_sha256: unchanged.bundleSha256 });
 assert.ok(/(?:^|\D)0 new/.test(quiet.stdout) && quiet.stdout.includes('600 unchanged') && quiet.stdout.includes('standing catch-up approval'), quiet.stdout);
 seed.apply(unchanged.planId);

 // A catch-up beyond the bound (100 new on 500): the door refuses the standing approval, and run asks for a plan the owner reviews.
 seed.state.baselines.set('uptimerobot', ids.slice(0, 500));
 remote.state.tasks = [{ task_id: 'biz:tool1:catchup2', kind: 'catchup.vendor', state: 'ready', runner: 'executor', fence: 0, title: 'Bring over recent UptimeRobot changes' }];
 const plansBefore = seed.state.plans.length;
 const reviewed = await cli(home, ['business','run','--once'], { env: vendorEnv }); outputs.push(reviewed);
 assert.equal(reviewed.code, 0, reviewed.stderr);
 assert.deepEqual(grantsAsked('biz:tool1:catchup2').filter(body => body.action === 'plan').map(body => body.review ?? false), [false, true]);
 const review = seed.state.plans.at(-1), plans = seed.state.requests.filter(entry => entry.url === '/api/rer/import/plan').slice(-2).map(entry => JSON.parse(entry.body));
 assert.ok(seed.state.plans.length === plansBefore + 1 && review.catchup && !review.standing, 'only the reviewed catch-up plan was kept');
 assert.deepEqual(plans, [{ uploadId: review.uploadId, catchup: true }, { uploadId: review.uploadId, catchup: true }]);
 assert.deepEqual(completed('biz:tool1:catchup2').body.outputs, { upload_id: review.uploadId, plan_id: review.planId, bundle_sha256: review.bundleSha256 });
 assert.ok(reviewed.stdout.includes('100 new') && reviewed.stdout.includes('5% or more') && reviewed.stdout.includes(`approves this catch-up in the browser: ${board}`), reviewed.stdout);

 // The archive: the final export kept by the door and test-restored, by this computer and again by Business.
 remote.state.tasks = [{ task_id: 'biz:tool1:archive', kind: 'switchoff.archive', state: 'ready', runner: 'executor', fence: 0, title: 'Archive UptimeRobot before switching it off' }];
 const archiveNext = await cli(home, ['business','next'], { env }); outputs.push(archiveNext);
 assert.ok((`\n${archiveNext.stdout}`).includes('\nAgent: biz:tool1:archive\n') && archiveNext.stdout.includes('archive') && /\nThen run: .*business run\n$/.test(archiveNext.stdout), archiveNext.stdout);
 const doorBefore = seed.state.requests.length;
 const archived = await cli(home, ['business','run','--once'], { env: vendorEnv }); outputs.push(archived);
 assert.equal(archived.code, 0, archived.stderr);
 const [kept] = seed.state.archives.values(), upload = seed.state.uploads.get(kept.uploadId);
 assert.equal(kept.tool, 'uptimerobot'); assert.ok(kept.bytes.equals(upload.bytes), 'the archive is the exact uploaded export');
 assert.deepEqual(completed('biz:tool1:archive').body.outputs, { archive_id: kept.id, bundle_sha256: upload.bundleSha256 });
 const calls = seed.state.requests.slice(doorBefore).map(entry => entry.url.slice('/api/rer/import/'.length));
 assert.deepEqual(calls, [...Array(upload.totalChunks).fill('uploads'), 'archive', 'restore-check']);
 assert.deepEqual(grantsAsked('biz:tool1:archive').map(body => body.action), calls, 'each door request had its own grant from Business');
 assert.equal(seed.state.restoreChecks, 2, 'this computer and then Business test-restored the archive');
 assert.equal(seed.state.nativeWrites, 0, 'neither catch-up planning nor the archive wrote anything native');
 assert.ok(archived.stdout.includes(`business-archive/uptimerobot/${kept.takenAt}`) && archived.stdout.includes('test-restored with no writes'), archived.stdout);
 assert.equal(remote.state.phase, 'done');

 // Nothing secret is printed, sent or kept, and every bundle was a private 0600 file that is gone after completion.
 const printed = outputs.map(result => result.stdout + result.stderr).join('');
 assert.ok(!printed.includes(key) && !printed.includes('Fixture monitor'), 'neither the key nor vendor records are printed');
 assert.ok(!JSON.stringify(remote.state.requests).includes(key) && !JSON.stringify(seed.state.requests).includes(key), 'the key reaches neither Business nor the door');
 assert.ok(seed.state.bundleModes.length >= 6 && seed.state.bundleModes.every(mode => mode === 0o600), JSON.stringify(seed.state.bundleModes));
 for (const name of await readdir(stateDir)) {
  assert.ok(!name.endsWith('.bundle'), `${name}: bundles are removed after completion`);
  assert.ok(!(await readFile(join(stateDir, name), 'utf8')).includes(key), `${name} holds no key`);
 }
 assert.equal((await cli(home, ['business','disconnect'], { env })).code, 0);
});
