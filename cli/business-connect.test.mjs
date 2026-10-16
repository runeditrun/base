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
 const state = { approved: false, requests: [], tasks: [], released: null };
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
  if (route === '/api/business/executors/token') return send({ access_token: `fixture-${body.audience}-bearer`, expires_in: body.audience === 'mcp' ? 300 : 900 });
  if (route === '/api/business/mcp') {
   if (body.method === 'initialize') return send({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-11-25' } });
   if (body.method === 'notifications/initialized') { response.statusCode = 202; return response.end(); }
   const name = body.params.name;
   const summary = name === 'next_question' ? { tasks: state.tasks } : state.tasks.find(task => task.task_id === body.params.arguments.task_id);
   return send({ jsonrpc: '2.0', id: body.id, result: { structuredContent: summary, isError: false } });
  }
  if (route === '/api/business/executors/claim') return send({ task: { id: 'discover1', kind: 'discover.local', checkpoint: { records_done: 7, bytes_done: 90 } }, fence: 3, grant: { id: 'grant1', destination: '/api/business/tasks/discover1/uploads', quota_bytes: 2 * 1024 * 1024 }, lease_expires_at: new Date(Date.now() + 600000).toISOString() });
  if (route.endsWith('/release')) state.released = body;
  if (route.endsWith('/release') || route.endsWith('/events')) return send({ accepted: true });
  send({}, 404);
 });
 await new Promise(resolveListen => http.listen(0, '127.0.0.1', resolveListen));
 t.after(() => new Promise(resolveClose => { http.close(resolveClose); http.closeAllConnections(); }));
 return { ...state, state, origin: `http://127.0.0.1:${http.address().port}`, device };
}
async function cli(home, args, { terminal = false, input = '', approve, columns = 120 } = {}) {
 await mkdir(home, { recursive: true });
 const env = { PATH: process.env.PATH, HOME: home, RER_NO_UPDATE_CHECK: '1', NODE_OPTIONS: `--import=${fileURLToPath(new URL('./fixtures/business/register.mjs', import.meta.url))}`, TEST_COLUMNS: String(columns) };
 return new Promise((resolveRun, reject) => {
  const command = terminal ? 'python3' : process.execPath;
  const parameters = terminal ? [join(fixture, 'terminal.py'), process.execPath, launcher, ...args] : [launcher, ...args];
  const child = spawn(command, parameters, { cwd: home, env, stdio: ['pipe','pipe','pipe'] });
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
 const key = 'fixture-vendor-secret-never-output';
 const added = await cli(home, ['business','vendor-key','add','sentry'], { input: key + '\n' });
 assert.equal(added.code, 0); assert.ok(added.stdout.includes('sentry:read'));
 assert.ok(!added.stdout.includes(key) && !added.stderr.includes(key));
 const stored = await readFile(join(home, '.rer/business/state.json'), 'utf8');
 assert.ok(!stored.includes(key) && !stored.includes(remote.device), 'only handles belong in configuration');
 remote.state.tasks = [{ task_id: 'question1', kind: 'classify.row', state: 'ready', runner: 'executor', instruction: 'untrusted-run-command-canary' }];
 const next = await cli(home, ['business','next']);
 assert.equal(next.code, 0); assert.ok(next.stdout.includes('question1')); assert.ok(!next.stdout.includes('untrusted-run-command-canary'));
 remote.state.tasks = [{ task_id: 'consent1', kind: 'consent.grant', state: 'ready', runner: 'owner' }];
 const denied = await cli(home, ['business','answer','consent1','uses']);
 assert.equal(denied.code, 1); assert.ok(denied.stderr.includes('/business/biz'));
 assert.ok(!remote.state.requests.some(entry => entry.route === '/api/business/mcp' && entry.body.params?.name === 'answer'), 'owner item is never mutated');
 assert.ok(!JSON.stringify(remote.state.requests).includes(key), 'vendor key never reaches the server');
 assert.equal((await cli(home, ['business','disconnect'])).code, 0);
});

test('packed supervisor preserves a lapsed lease checkpoint and refuses missing execution instructions before reading files', async t => {
 const remote = await server(t), home = join(directory, 'lease-home');
 await connect(home, remote);
 remote.state.tasks = [{ task_id: 'discover1', kind: 'discover.local', state: 'ready', runner: 'executor', fence: 2 }];
 const privateDirectory = join(home, 'secrets'); await mkdir(privateDirectory);
 await writeFile(join(privateDirectory, 'credential.json'), 'fixture-canary-never-leaves-process');
 const run = await cli(home, ['business','run','--once']);
 assert.equal(run.code, 1, 'protocol gap is an explicit failure');
 assert.equal(remote.state.released.reason, 'paused');
 assert.deepEqual(remote.state.released.checkpoint, { records_done: 7, bytes_done: 90 });
 assert.ok(!JSON.stringify(remote.state.requests).includes('fixture-canary-never-leaves-process'));
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
