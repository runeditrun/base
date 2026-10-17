import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { classifierJourney, modelShim } from './fixtures/business/classifier-journey.mjs';
import { server, classificationSchema } from './fixtures/business/server.mjs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPackage } from '../scripts/rer-package.mjs';
import { integrity } from '../scripts/rer-package/registry.mjs';
import { readPackage, writePackage } from '../global/update/archive.mjs';

const base = resolve(import.meta.dirname, '..');
const fixture = join(import.meta.dirname, 'fixtures/business');
let directory, launcher;
before(async () => {
 directory = await mkdtemp(join(base, '.business-connect-'));
 await mkdir(join(directory, 'tmp'));
 await modelShim(join(directory, 'models'), 'claude');
 await modelShim(join(directory, 'models'), 'codex');
 const bytes = await readFile(await buildPackage(base, join(directory, 'package')));
 const packed = join(directory, 'packed');
 await writePackage(readPackage(bytes, { integrity: integrity(bytes) }), packed);
 launcher = join(packed, 'global/rer.mjs');
});
after(() => directory && rm(directory, { recursive: true, force: true }));

async function cli(home, args, { terminal = false, input = '', approve, columns = 120, onSpawn, path = `${join(directory, 'models/bin')}:${process.env.PATH}`, questionCli = 'none' } = {}) {
 await mkdir(home, { recursive: true });
 const env = { PATH: path, TMPDIR: join(directory, 'tmp'), MCP_CONFIG: 'fixture-untrusted-mcp', CODEX_INSTRUCTIONS: 'fixture-untrusted-instructions', TEST_QUESTION_CLI: questionCli, HOME: home, RER_NO_UPDATE_CHECK: '1', NODE_OPTIONS: `--import=${fileURLToPath(new URL('./fixtures/business/register.mjs', import.meta.url))}`, TEST_COLUMNS: String(columns) };
 return new Promise((resolveRun, reject) => {
  const command = terminal ? 'python3' : process.execPath;
  const parameters = terminal ? [join(fixture, 'terminal.py'), process.execPath, launcher, ...args] : [launcher, ...args];
  const child = spawn(command, parameters, { cwd: home, env, stdio: ['pipe','pipe','pipe'] });
  onSpawn?.(child);
  let stdout = '', stderr = '', approving = false;
  const timer = setTimeout(() => child.kill('SIGKILL'), 40000);
  child.stdout.on('data', chunk => {
   stdout += chunk;
   if (approve && !approving && stdout.includes('246810')) { approving = true; void approve(); }
  });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.once('error', error => { clearTimeout(timer); reject(error); });
  child.once('close', code => { clearTimeout(timer); resolveRun({ code, stdout, stderr }); });
  child.stdin.end(input);
 });
}
async function connect(home, remote, options = {}) {
 const result = await cli(home, ['business','connect','--code','ABCD-1234','--origin',remote.origin], {
  ...options, approve: () => fetch(remote.origin + '/api/business/biz/pairings/pair1/approve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmed: true, confirmation_number: '246810' }) }),
 });
 assert.equal(result.code, 0, `CLI pairs after browser number approval; approved=${remote.state.approved}; printed_number=${result.stdout.includes('Confirmation number:')}; paired=${result.stdout.includes('Business paired.')}; credential_error=${result.stderr.includes('OS credential storage')}; generic=${result.stderr.includes('Business command failed')}`);
 assert.ok(!result.stdout.includes(remote.device) && !result.stderr.includes(remote.device), 'device credential stays out of both streams');
 return result;
}

test('packed CLI pairs only after number approval and keeps keys and untrusted task text out of agent output', async t => {
 const remote = await server(t), home = join(directory, 'pair-home');
 await connect(home, remote);
 assert.equal(JSON.parse((await cli(home, ['business','status','--json'])).stdout).questions_cli, 'none');
 assert.ok(!remote.state.requests.find(request => request.body.code)?.body.capabilities.includes('classify.row'));
 remote.state.root = join(home, 'canary-tree');
 await mkdir(join(remote.state.root, 'secrets'), { recursive: true });
 await writeFile(join(remote.state.root, 'package.json'), JSON.stringify({ dependencies: { 'fixture-library': 'fixture-private-version-never-export' } }));
 await mkdir(join(remote.state.root, '.github/workflows'), { recursive: true });
 await writeFile(join(remote.state.root, '.github/workflows/deploy-stage.yml'), 'jobs:\n  deploy:\n    env:\n      TOKEN: ${{ secrets.FIXTURE_CI_API_TOKEN }}\n');
 await writeFile(join(remote.state.root, '.env'), 'FIXTURE_PROVIDER_KEY=fixture-env-never-export');
 await writeFile(join(remote.state.root, 'secrets/credential.json'), 'fixture-denied-value-never-export');
 remote.state.tasks = [{ task_id: 'discover1', kind: 'discover.local', state: 'ready', runner: 'executor', fence: 0 }];
 const discovered = await cli(home, ['business','run','--once']);
 assert.equal(discovered.code, 0, discovered.stderr); assert.equal(remote.state.phase, 'done');
 const outbound = JSON.stringify(remote.state.requests) + discovered.stdout + discovered.stderr;
 for (const canary of ['fixture-private-version-never-export','fixture-env-never-export','fixture-denied-value-never-export']) assert.ok(!outbound.includes(canary), 'private canary values stay out of uploads, events and both output streams');
 assert.ok(remote.state.uploads.some(document => document.signals.some(signal => signal.value === 'fixture-library')));
 assert.ok(remote.state.uploads.some(document => document.signals.some(signal => signal.value === 'FIXTURE_CI_API_TOKEN')), 'ordinary workflow paths survive scanner and upload detection');
 const key = 'fixture-vendor-secret-never-output';
 const added = await cli(home, ['business','vendor-key','add','sentry'], { terminal: true, input: key + '\n' });
 assert.equal(added.code, 0); assert.ok(added.stdout.includes('sentry:read'));
 assert.ok(!added.stdout.includes(key) && !added.stderr.includes(key));
 const stored = await readFile(join(home, '.rer/business/state.json'), 'utf8');
 assert.ok(!stored.includes(key) && !stored.includes(remote.device), 'only handles belong in configuration');
 const question = { tool_id: 'tool1', vendor_id: 'sentry', answer_schema: classificationSchema };
 remote.state.tasks = [{ task_id: 'question1', kind: 'classify.row', state: 'ready', runner: 'executor', fence: 0, question, instruction: 'untrusted-run-command-canary' }];
 const claimsBeforeQuestion = remote.state.requests.filter(request => request.route.endsWith('/claim')).length;
 assert.equal((await cli(home, ['business','run','--once'])).code, 0);
 assert.equal(remote.state.requests.filter(request => request.route.endsWith('/claim')).length, claimsBeforeQuestion, 'none preserves interactive question handling');
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
 await classifierJourney({ directory, remote, cli, connect });
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

test('terminal consent installs a user service and disconnect removes all additions while preserving preexisting Claude settings', async t => {
 const remote = await server(t);
 for (const columns of [160, 43]) {
  const home = join(directory, `cleanup-${columns}-home`);
  await mkdir(join(home, '.claude'), { recursive: true });
  const prior = { permissions: { deny: ['Read(existing/**)'] }, theme: 'dark' };
  await writeFile(join(home, '.claude/settings.json'), JSON.stringify(prior));
  const baseline = await readdir(home);
  await connect(home, remote, { terminal: true, columns });
  const status = await cli(home, ['business','status','--json']);
  assert.equal(status.code, 0); assert.equal(JSON.parse(status.stdout).service, 'running');
  assert.equal((await cli(home, ['business','vendor-key','add','uptimerobot'], { terminal: true, input: 'fixture-read-only-vendor-key\n' })).code, 0);
  assert.equal((await cli(home, ['business','disconnect'])).code, 0);
  assert.deepEqual(JSON.parse(await readFile(join(home, '.claude/settings.json'), 'utf8')), prior);
  assert.deepEqual(await readdir(home), baseline, 'service files, parents, keychain items, state and permission additions are removed');
 }
});
