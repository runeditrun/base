import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { server, classificationSchema } from './fixtures/business/server.mjs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { buildPackage } from '../scripts/rer-package.mjs';
import { integrity } from '../scripts/rer-package/registry.mjs';
import { readPackage, writePackage } from '../global/update/archive.mjs';

const base = resolve(import.meta.dirname, '..');
const fixture = join(import.meta.dirname, 'fixtures/business');
let directory, launcher;
before(async () => {
 directory = await mkdtemp(join(base, '.business-connect-'));
 const bytes = await readFile(await buildPackage(base, join(directory, 'package')));
 const packed = join(directory, 'packed');
 await writePackage(readPackage(bytes, { integrity: integrity(bytes) }), packed);
 launcher = join(packed, 'global/rer.mjs');
});
after(() => directory && rm(directory, { recursive: true, force: true }));

async function cli(home, args, { terminal = false, input = '', columns = 120, onSpawn, path = process.env.PATH } = {}) {
 await mkdir(home, { recursive: true });
 const env = { PATH: path, HOME: home, RER_NO_UPDATE_CHECK: '1', NODE_OPTIONS: `--import=${fileURLToPath(new URL('./fixtures/business/register.mjs', import.meta.url))}`, TEST_COLUMNS: String(columns) };
 return new Promise((resolveRun, reject) => {
  const command = terminal ? 'python3' : process.execPath;
  const parameters = terminal ? [join(fixture, 'terminal.py'), process.execPath, launcher, ...args] : [launcher, ...args];
  const child = spawn(command, parameters, { cwd: home, env, stdio: ['pipe','pipe','pipe'] });
  onSpawn?.(child);
  let stdout = '', stderr = '';
  const timer = setTimeout(() => child.kill('SIGKILL'), 40000);
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.once('error', error => { clearTimeout(timer); reject(error); });
  child.once('close', code => { clearTimeout(timer); resolveRun({ code, stdout, stderr }); });
  child.stdin.end(input);
 });
}
async function connect(home, remote, options = {}) {
 const starts = () => remote.state.requests.filter(entry => entry.route === '/api/business/executors/pair' && entry.body.code).length;
 const before = starts();
 const pending = await cli(home, ['business','connect','--code','ABCD-1234','--origin',remote.origin]);
 assert.equal(pending.code, 0, pending.stderr);
 assert.ok(pending.stdout.includes('246810'));
 assert.equal(remote.state.active, false, 'an unapproved computer is not active');
 assert.equal((await stat(join(home, '.rer/business/pairing.json'))).mode & 0o777, 0o600);
 await fetch(remote.origin + '/api/business/biz/pairings/pair1/approve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmed: true, confirmation_number: '246810' }) });
 assert.equal(remote.state.active, false, 'browser approval alone does not activate a computer');
 remote.state.onSelf = async () => {
  const saved = JSON.parse(await readFile(join(home, '.rer/business/state.json'), 'utf8'));
  assert.equal(saved.executorId, 'executor1');
  assert.ok((await readFile(join(home, 'fake-keychain.json'), 'utf8')).includes(remote.device), 'credential is stored before activation');
 };
 const result = await cli(home, ['business','connect','--origin',remote.origin], options);
 assert.equal(starts(), before + 1, 'later connect resumes the same server pairing instead of redeeming another code');
 assert.ok(result.stdout.includes('246810'), 'the browser comparison number survives the turn boundary');
 assert.equal(result.code, 0, `CLI pairs after browser number approval; approved=${remote.state.approved}; printed_number=${result.stdout.includes('Confirmation number:')}; paired=${result.stdout.includes('Business paired.')}; credential_error=${result.stderr.includes('OS credential storage')}; generic=${result.stderr.includes('Business command failed')}`);
 assert.ok(!result.stdout.includes(remote.device) && !result.stderr.includes(remote.device), 'device credential stays out of both streams');
 return result;
}

test('packed CLI pairs only after number approval and keeps keys and untrusted task text out of agent output', async t => {
 const remote = await server(t), home = join(directory, 'pair-home');
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
 const remote = await server(t), home = join(directory, 'lease-home');
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
 assert.ok(!JSON.stringify(remote.state.requests).includes('fixture-private-version-never-export'));
 assert.equal((await cli(home, ['business','disconnect'])).code, 0);
});

test('browser opt-ins work without terminal prompts, failed storage never activates, and disconnect revokes before removing local additions', async t => {
 const remote = await server(t);
 const pendingHome = join(directory, 'pending-home');
 const pendingArgs = ['business','connect','--code','ABCD-1234','--origin',remote.origin];
 assert.equal((await cli(pendingHome, pendingArgs)).code, 0);
 const savedPending = JSON.parse(await readFile(join(pendingHome, '.rer/business/pairing.json'), 'utf8'));
 const repeated = await cli(pendingHome, ['business','connect']);
 assert.equal(repeated.code, 0); assert.ok(repeated.stdout.includes(savedPending.confirmation_number));
 assert.equal(remote.state.requests.filter(entry => entry.body.code).length, 1);
 remote.state.pairingRefused = true;
 assert.equal((await cli(pendingHome, ['business','connect'])).code, 1);
 assert.ok(!(await readdir(join(pendingHome, '.rer/business'))).includes('pairing.json'));
 remote.state.pairingRefused = false;
 await cli(pendingHome, pendingArgs);
 const expired = JSON.parse(await readFile(join(pendingHome, '.rer/business/pairing.json'), 'utf8'));
 expired.expires_at = new Date(Date.now() - 1000).toISOString();
 await writeFile(join(pendingHome, '.rer/business/pairing.json'), JSON.stringify(expired));
 const beforeExpiry = remote.state.requests.length;
 assert.equal((await cli(pendingHome, ['business','connect'])).code, 1);
 assert.equal(remote.state.requests.length, beforeExpiry, 'expired pairing is never polled or silently replaced');
 assert.equal((await cli(pendingHome, ['business','disconnect'])).code, 0);

 // A later turn is told the command that works from its own shell.
 const onPath = join(directory, 'rer-on-path');
 await mkdir(onPath, { recursive: true }); await writeFile(join(onPath, 'rer'), '#!/bin/sh\n', { mode: 0o755 });
 const withoutRer = await cli(pendingHome, pendingArgs, { path: '/usr/bin:/bin' });
 assert.ok(withoutRer.stdout.includes(`run npx -y @runeditrun/rer business connect --origin ${remote.origin} again`), withoutRer.stdout);
 const withRer = await cli(pendingHome, ['business','connect'], { path: `${onPath}:/usr/bin:/bin` });
 assert.ok(withRer.stdout.includes(`run rer business connect --origin ${remote.origin} again`), withRer.stdout);
 assert.equal((await cli(pendingHome, ['business','disconnect'])).code, 0);

 // Without an OS credential store the one-use code is never redeemed.
 const lockedHome = join(directory, 'no-store-home');
 await mkdir(lockedHome); await writeFile(join(lockedHome, 'no-credential-store'), '');
 const redemptions = () => remote.state.requests.filter(entry => entry.body.code).length;
 const beforeLocked = redemptions();
 const locked = await cli(lockedHome, pendingArgs);
 assert.equal(locked.code, 1); assert.match(locked.stderr, /OS credential storage/);
 assert.equal(redemptions(), beforeLocked, 'the code is not redeemed when its credential could not be stored');
 assert.deepEqual(await readdir(lockedHome), ['no-credential-store']);
 await rm(join(lockedHome, 'no-credential-store'));
 const unlocked = await cli(lockedHome, pendingArgs);
 assert.equal(unlocked.code, 0, unlocked.stderr); assert.ok(unlocked.stdout.includes('246810'), 'the same code still pairs once the store is available');
 assert.equal((await cli(lockedHome, ['business','disconnect'])).code, 0);

 // An approval near the code's end extends the server's expiry; a later turn still collects it.
 const lateHome = join(directory, 'late-approval-home');
 remote.state.pairingSeconds = 5;
 assert.equal((await cli(lateHome, pendingArgs)).code, 0);
 const redeemed = Date.now();
 const late = await fetch(remote.origin + '/api/business/biz/pairings/pair1/approve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmed: true, confirmation_number: '246810' }) });
 assert.equal(late.status, 200);
 delete remote.state.pairingSeconds;
 await delay(Math.max(0, redeemed + 5500 - Date.now()));
 const collected = await cli(lateHome, ['business','connect']);
 assert.equal(collected.code, 0, collected.stderr); assert.ok(collected.stdout.includes('Business paired.'));
 assert.equal((await cli(lateHome, ['business','disconnect'])).code, 0);

 const failedHome = join(directory, 'storage-failed-home');
 await mkdir(failedHome); await writeFile(join(failedHome, 'fail-credential-store'), '');
 await cli(failedHome, pendingArgs);
 remote.state.approved = true;
 const authenticated = () => remote.state.requests.filter(entry => entry.authorization === `Bearer ${remote.device}`).length;
 const beforeFailure = authenticated();
 const failed = await cli(failedHome, ['business','connect']);
 assert.equal(failed.code, 1); assert.match(failed.stderr, /OS credential storage/);
 assert.equal(authenticated(), beforeFailure, 'failed credential storage sends no activation or other device-authenticated request');
 assert.equal(remote.state.active, false);
 const unrevoked = await cli(failedHome, ['business','disconnect']);
 assert.equal(unrevoked.code, 0);
 assert.ok(!unrevoked.stdout.includes('Device revoked') && unrevoked.stdout.includes(`${remote.origin}/business`), 'without a stored credential nothing is revoked, and the browser is named for it');

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
  const optedIn = await connect(home, remote, { terminal: columns === 43, columns });
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

test('vendor exports strip credential values before upload, keeping every record, empty credential fields and pagination', async t => {
 const { exportVendor } = await import('./business/vendors/index.mjs');
 const key = 'fixture-vendor-read-key', apiKey = 'fixture-account-api-key-value', password = 'fixture-basic-auth-pass';
 const secrets = [key, apiKey, password, 'fixture-header-secret', 'fixture-integration-key'];
 // Uptime's UptimeRobot v3 fixture shape: every monitor carries apiKey, one checks a user:pass@ URL.
 const monitors = [
  { id: 9000001, url: 'https://shop.example.com/', customHttpHeaders: null, psps: [{ id: 5, isPasswordSet: false }], apiKey: null },
  { id: 9000009, url: 'https://api.partner.example.net/v1/health', customHttpHeaders: { 'X-Api-Key': 'fixture-header-secret' }, apiKey: '' },
  { id: 9000012, url: `https://user:${password}@staging.example.com/`, customHttpHeaders: null, apiKey },
 ];
 const responses = new Map(Object.entries({
  'https://api.uptimerobot.com/v3/monitors?limit=200': { data: monitors.slice(0, 2), nextLink: 'https://api.uptimerobot.com/v3/monitors?cursor=page-2' },
  'https://api.uptimerobot.com/v3/monitors?cursor=page-2': { data: monitors.slice(2), nextLink: null },
  'https://api.pagerduty.com/users?limit=100&offset=0': { users: [{ id: 'PUSER01', name: 'Fixture Responder', integration_key: 'fixture-integration-key', html_url: 'https://fixture.pagerduty.com/users/PUSER01' }], limit: 100, offset: 0, more: false },
  'https://api.pagerduty.com/schedules?limit=100&offset=0': { schedules: [], limit: 100, offset: 0, more: false },
  'https://api.pagerduty.com/escalation_policies?limit=100&offset=0': { escalation_policies: [], limit: 100, offset: 0, more: false },
 }));
 const original = globalThis.fetch;
 t.after(() => { globalThis.fetch = original; });
 // The network edge: each vendor API answers its fixed pages.
 globalThis.fetch = async url => {
  const body = responses.get(String(url));
  return body ? new Response(JSON.stringify(body)) : new Response('{}', { status: 404 });
 };
 const collect = async (vendor, inputs) => { const items = []; for await (const item of exportVendor(vendor, { key, inputs })) items.push(item); return items; };
 const uptime = await collect('uptimerobot', {}), text = Buffer.concat(uptime.map(item => item.bytes)).toString();
 const pages = text.trim().split('\n').map(line => JSON.parse(line));
 assert.deepEqual(pages.map(page => page.data.map(monitor => monitor.id)), [[9000001, 9000009], [9000012]], 'every record is kept');
 assert.deepEqual(pages.map(page => page.nextLink), ['https://api.uptimerobot.com/v3/monitors?cursor=page-2', null]);
 assert.deepEqual([pages[0].data[0].apiKey, pages[0].data[1].apiKey, pages[0].data[0].psps[0].isPasswordSet], [null, '', false], 'empty credential fields stay as they are');
 assert.equal(pages[0].data[1].customHttpHeaders['X-Api-Key'], '[removed]');
 assert.deepEqual([pages[1].data[0].url, pages[1].data[0].apiKey], ['https://removed@staging.example.com/', '[removed]']);
 const pagerduty = await collect('pagerduty', { start: '2026-10-01T00:00:00.000Z', end: '2026-10-08T00:00:00.000Z' });
 const bundle = JSON.parse(Buffer.concat(pagerduty.map(item => item.bytes)).toString());
 assert.deepEqual(bundle.users[0].users[0], { id: 'PUSER01', name: 'Fixture Responder', integration_key: '[removed]', html_url: 'https://fixture.pagerduty.com/users/PUSER01' }, 'a credential field no longer refuses the export');
 const emitted = JSON.stringify([text, bundle, uptime.map(item => item.checkpoint), pagerduty.map(item => item.checkpoint)]);
 for (const secret of secrets) assert.ok(!emitted.includes(secret), 'no credential value is emitted for upload');
});
