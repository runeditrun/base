import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
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
 const bytes = await readFile(await buildPackage(base, join(directory, 'package')));
 const packed = join(directory, 'packed');
 await writePackage(readPackage(bytes, { integrity: integrity(bytes) }), packed);
 launcher = join(packed, 'global/rer.mjs');
});
after(() => directory && rm(directory, { recursive: true, force: true }));

async function server(t) {
 const state = { approved: false, requests: [], tasks: [], released: null, checkpoint: {}, uploads: [], phase: 'ready', fence: 0, grants: new Map(), claims: new Map() };
 const device = 'fixture-device-credential';
 const http = createServer(async (request, response) => {
  let raw = ''; for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw || '{}'), route = request.url;
  state.requests.push({ route, body });
  response.setHeader('Content-Type', 'application/json');
  function send(value, code = 200) { response.statusCode = code; response.end(JSON.stringify(value)); }
  if (route === '/api/business/biz/pairings/pair1/approve') {
   if (body.confirmation_number !== '246810' || body.confirmed !== true) return send({}, 403);
   state.approved = true; return send({ approved: true });
  }
  if (route === '/api/business/executors/pair') {
   if (body.code) return send({ status: 'pending_approval', pairing_token: 'fixture-pairing-poll', confirmation_number: '246810', expires_at: new Date(Date.now() + 60000).toISOString(), interval: 1 }, 202);
   if (!state.approved) return send({ status: 'authorization_pending', interval: 1 }, 202);
   return send({ status: 'paired', device_credential: device, executor_id: 'executor1', business_id: 'biz' });
  }
  if (state.revoked) return send({}, 401);
  if (route === '/api/business/executors/token') return send({ access_token: `fixture-${body.audience}-bearer`, expires_in: body.audience === 'mcp' ? 300 : 900 });
  if (route === '/api/business/mcp') {
   if (body.method === 'initialize') return send({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-11-25' } });
   if (body.method === 'notifications/initialized') { response.statusCode = 202; return response.end(); }
   const name = body.params.name;
   if (name === 'answer') {
    const args = body.params.arguments;
    if (args.action === 'complete') return send({ jsonrpc: '2.0', id: body.id, result: { structuredContent: { status: 'action_unavailable' }, isError: true } });
    if (args.action === 'release') state.questionReleased = true;
    return send({ jsonrpc: '2.0', id: body.id, result: { structuredContent: { task_id: 'question1', kind: 'classify.row', state: 'leased', runner: 'executor', fence: 1, grant_id: 'question-grant' }, isError: false } });
   }
   const summary = name === 'next_question' ? { tasks: state.tasks } : state.tasks.find(task => task.task_id === body.params.arguments.task_id);
   return send({ jsonrpc: '2.0', id: body.id, result: { structuredContent: summary, isError: false } });
  }
  function taskView() { return { id: 'discover1', kind: 'discover.local', kind_version: 1, state: state.phase, fence: state.fence, checkpoint: state.checkpoint }; }
  function grantView(fence = state.fence) {
   return { id: `grant-${fence}`, task_id: 'discover1', fence, destination: '/api/business/tasks/discover1/uploads', quota_bytes: 2 * 1024 * 1024, uploaded_bytes: state.grants.get(fence) ?? 0, consent: { id: 'consent1', scope: { paths: [state.root] } } };
  }
  function reply(fence = state.fence) { return { task: taskView(), fence: state.fence, grant: grantView(fence), lease_expires_at: new Date(Date.now() + 600000).toISOString(), controls: [], cursor: 0 }; }
  if (route === '/api/business/executors/claim') {
   if (state.claims.has(body.claim_id)) return send(reply(state.claims.get(body.claim_id)));
   state.phase = 'leased'; state.fence++; state.grants.set(state.fence, 0); state.claims.set(body.claim_id, state.fence);
   return send(reply());
  }
  if (/^\/api\/business\/tasks\/discover1\//.test(route)) {
   if (body.fence !== state.fence || body.grant_id !== `grant-${state.fence}` || state.phase !== 'leased') return send({}, 409);
   if (route.endsWith('/uploads')) {
    if (body.consent_id !== 'consent1' || !body.document?.signals?.length) return send({}, 400);
    state.uploads.push(body.document);
    const bytes = Buffer.byteLength(JSON.stringify(body.document));
    state.grants.set(state.fence, state.grants.get(state.fence) + bytes);
    return send({ ...reply(), stored: body.document.signals.length });
   }
   if (route.endsWith('/heartbeat')) {
    state.checkpoint = body.checkpoint;
    state.onHeartbeat?.();
   }
   if (route.endsWith('/complete')) { if (!state.uploads.length) return send({}, 409); state.phase = 'done'; }
   if (route.endsWith('/release')) { state.released = body; state.checkpoint = body.checkpoint; state.phase = 'ready'; state.fence++; }
   return send(reply());
  }
  send({}, 404);
 });
 await new Promise(resolveListen => http.listen(0, '127.0.0.1', resolveListen));
 t.after(() => new Promise(resolveClose => { http.close(resolveClose); http.closeAllConnections(); }));
 return { ...state, state, origin: `http://127.0.0.1:${http.address().port}`, device };
}
async function cli(home, args, { terminal = false, input = '', approve, columns = 120, onSpawn } = {}) {
 await mkdir(home, { recursive: true });
 const env = { PATH: process.env.PATH, HOME: home, RER_NO_UPDATE_CHECK: '1', NODE_OPTIONS: `--import=${fileURLToPath(new URL('./fixtures/business/register.mjs', import.meta.url))}`, TEST_COLUMNS: String(columns) };
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
 remote.state.root = join(home, 'canary-tree');
 await mkdir(join(remote.state.root, 'secrets'), { recursive: true });
 await writeFile(join(remote.state.root, 'package.json'), JSON.stringify({ dependencies: { 'fixture-library': 'fixture-private-version-never-export' } }));
 await writeFile(join(remote.state.root, '.env'), 'FIXTURE_PROVIDER_KEY=fixture-env-never-export');
 await writeFile(join(remote.state.root, 'secrets/credential.json'), 'fixture-denied-value-never-export');
 remote.state.tasks = [{ task_id: 'discover1', kind: 'discover.local', state: 'ready', runner: 'executor', fence: 0 }];
 const discovered = await cli(home, ['business','run','--once']);
 assert.equal(discovered.code, 0); assert.equal(remote.state.phase, 'done');
 const outbound = JSON.stringify(remote.state.requests) + discovered.stdout + discovered.stderr;
 for (const canary of ['fixture-private-version-never-export','fixture-env-never-export','fixture-denied-value-never-export']) assert.ok(!outbound.includes(canary), 'private canary values stay out of uploads, events and both output streams');
 assert.ok(remote.state.uploads.some(document => document.signals.some(signal => signal.value === 'fixture-library')));
 const key = 'fixture-vendor-secret-never-output';
 const added = await cli(home, ['business','vendor-key','add','sentry'], { input: key + '\n' });
 assert.equal(added.code, 0); assert.ok(added.stdout.includes('sentry:read'));
 assert.ok(!added.stdout.includes(key) && !added.stderr.includes(key));
 const stored = await readFile(join(home, '.rer/business/state.json'), 'utf8');
 assert.ok(!stored.includes(key) && !stored.includes(remote.device), 'only handles belong in configuration');
 remote.state.tasks = [{ task_id: 'question1', kind: 'classify.row', state: 'ready', runner: 'executor', fence: 0, instruction: 'untrusted-run-command-canary' }];
 const next = await cli(home, ['business','next']);
 assert.equal(next.code, 0); assert.ok(next.stdout.includes('question1')); assert.ok(!next.stdout.includes('untrusted-run-command-canary'));
 const rejected = await cli(home, ['business','answer','question1','uses']);
 assert.equal(rejected.code, 1); assert.equal(remote.state.questionReleased, true, 'a refused enum completion does not strand its lease');
 const answerCalls = remote.state.requests.filter(entry => entry.route === '/api/business/mcp' && entry.body.params?.name === 'answer').length;
 remote.state.tasks = [{ task_id: 'consent1', kind: 'consent.grant', state: 'ready', runner: 'owner' }];
 const denied = await cli(home, ['business','answer','consent1','uses']);
 assert.equal(denied.code, 1); assert.ok(denied.stderr.includes('/business/biz'));
 assert.equal(remote.state.requests.filter(entry => entry.route === '/api/business/mcp' && entry.body.params?.name === 'answer').length, answerCalls, 'owner item is never mutated');
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
 assert.equal(killed.code, null, 'task is killed after its first acknowledged page');
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
  assert.equal((await cli(home, ['business','vendor-key','add','uptimerobot'], { input: 'fixture-read-only-vendor-key\n' })).code, 0);
  assert.equal((await cli(home, ['business','disconnect'])).code, 0);
  assert.deepEqual(JSON.parse(await readFile(join(home, '.claude/settings.json'), 'utf8')), prior);
  assert.deepEqual(await readdir(home), baseline, 'service files, parents, keychain items, state and permission additions are removed');
 }
});
