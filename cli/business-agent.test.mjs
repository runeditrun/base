import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentServer } from './fixtures/business/agent-server.mjs';
import { credentialHandle } from './business/state.mjs';

const base = resolve(import.meta.dirname, '..');
const device = 'bz_device_fixture-agent';

// A computer already paired with a Business, and the fake Business MCP it talks to.
async function paired(t) {
 const root = await mkdtemp(join(base, '.business-connect-agent-'));
 t.after(() => rm(root, { recursive: true, force: true }));
 const remote = await agentServer(t, device);
 const home = join(root, 'home');
 await mkdir(join(home, '.rer/business'), { recursive: true });
 const credentials = join(home, 'credentials'), calls = join(home, 'keychain-calls');
 await mkdir(credentials, { mode: 0o700 });
 async function selectBusiness(businessId) {
  await writeFile(join(home, '.rer/business/state.json'), JSON.stringify({ origin: remote.origin, businessId, executorId: 'executor1', credentialVersion: 2 }));
  await writeFile(join(credentials, credentialHandle(remote.origin, businessId).slice(7) + '.credential'), device, { mode: 0o600 });
 }
 await selectBusiness('biz');
 await writeFile(calls, '');
 const env = { PATH: process.env.PATH, HOME: home, RER_NO_UPDATE_CHECK: '1', RER_BUSINESS_CREDENTIAL_DIR: credentials, RER_TEST_KEYCHAIN_CALLS: calls, NODE_OPTIONS: `--import=${fileURLToPath(new URL('./fixtures/business/register.mjs', import.meta.url))}` };
 const start = args => spawn(process.execPath, [join(base, 'bin/rer.mjs'), 'business', ...args], { cwd: home, env, stdio: ['pipe', 'pipe', 'pipe'] });
 const rer = args => new Promise(done => {
  const child = start(args); let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('close', code => done({ code, stdout, stderr })); child.stdin.end();
 });
 return { remote, rer, start, calls, home, selectBusiness };
}

test('Business call reuses the paired MCP bearer across processes and replaces it when needed', async t => {
 const { remote, rer, selectBusiness } = await paired(t);
 remote.tokenLifetime = 70;
 const call = () => rer(['call', 'installations.list', '--json']);
 const first = await call();
 assert.equal(first.code, 0, first.stderr);
 const expiry = remote.lastExpiry;
 assert.equal(remote.mints, 1);
 assert.deepEqual(await call(), first);
 assert.equal(remote.mints, 1, 'a second CLI process reused the same bearer');

 remote.tokenLifetime = 300;
 await delay(Math.max(0, expiry - Date.now() - 60_000));
 assert.deepEqual(await call(), first);
 assert.equal(remote.mints, 2, 'the still-live bearer entered its renewal window');

 await selectBusiness('another-business');
 assert.deepEqual(await call(), first);
 assert.equal(remote.mints, 3, 'the same origin and executor paired to a different business did not reuse its bearer');

 remote.httpRefusal = { route: '/api/business/mcp', status: 401, body: { error: 'bearer expired' } };
 const refused = await call();
 assert.equal(refused.code, 1);
 assert.equal(remote.mints, 4, 'a refusal retried just once');
 delete remote.httpRefusal;
 assert.deepEqual(await call(), first);
 assert.equal(remote.mints, 5, 'the second refused bearer was discarded too');

 remote.appName = [...remote.bearers].at(-1);
 const redacted = await call();
 assert.equal(redacted.code, 0, redacted.stderr);
 assert.ok(!redacted.stdout.includes(remote.appName));
 assert.equal(remote.mints, 5);
});

test('Business HTTP and MCP refusals retain server reasons in commands, JSON and the stdio bridge without forwarding secret fields', async t => {
 const { remote, rer, start, home } = await paired(t);
 const secret = 'synthetic-opaque-refusal-secret-canary', fields = { credential: secret, headers: { Authorization: 'private-header-canary' }, unrelated: 'unrelated-body-canary' };
 const absent = output => {
  for (const value of [device, secret, 'private-header-canary', 'unrelated-body-canary', Buffer.from(secret).toString('base64'), 'bz_task_refusal-canary']) assert.ok(!output.includes(value), `a secret or unrelated field escaped`);
 };
 // Both token minting and MCP HTTP errors use the shared HTTP error door.
 for (const [route, key, status] of [['/api/business/executors/token', 'message', 403], ['/api/business/mcp', 'error', 409], ['/api/business/mcp', 'detail', 422]]) {
  const reason = `The selected account needs approval for ${key}.`;
  remote.httpRefusal = { route, status, body: { [key]: `${reason}\n${device} ${secret} bz_task_refusal-canary`, ...fields } };
  const result = await rer(['installations', 'list']);
  assert.equal(result.code, 1); assert.match(result.stderr, /Business server refused[\s\S]*The server said:/); assert.ok(result.stderr.includes(reason)); absent(result.stdout + result.stderr);
 }
 for (const field of ['error', 'detail']) {
  remote.httpRefusal = { route: '/api/business/mcp', status: 409, body: { [field]: { message: `Owner approval expired for ${field}. ${secret}`, ...fields } } };
  const result = await rer(['tools']);
  assert.equal(result.code, 1); assert.ok(result.stderr.includes(`Owner approval expired for ${field}.`)); absent(result.stdout + result.stderr);
 }
 for (const raw of [`{"credential":"${secret}","message":`, JSON.stringify({ credential: secret, unrelated: 'x'.repeat(70_000), message: 'A later reason.' })]) {
  remote.httpRefusal = { route: '/api/business/mcp', status: 409, raw };
  const result = await rer(['tools']);
  assert.equal(result.code, 1); assert.match(result.stderr, /HTTP 409/); absent(result.stdout + result.stderr);
 }
 delete remote.httpRefusal;
 // Protocol errors can occur at initialization, listing or the tool call itself.
 for (const [method, args] of [['initialize', ['tools']], ['tools/list', ['tools']], ['tools/call', ['call', 'next_question']]]) {
  remote.rpcRefusal = { method, error: { code: -32000, detail: `Owner approval is required for ${method}. ${secret}`, ...fields } };
  const result = await rer(args);
  assert.equal(result.code, 1); assert.ok(result.stderr.includes(`Owner approval is required for ${method}.`)); absent(result.stdout + result.stderr);
 }
 delete remote.rpcRefusal;
 remote.toolResult = { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { message: `The provider refused this task. ${secret}` }, ...fields }) }] };
 const textOnly = await rer(['call', 'next_question', '--json']);
 assert.equal(textOnly.code, 1); assert.match(textOnly.stderr, /The provider refused this task/); absent(textOnly.stdout + textOnly.stderr);
 for (const status of ['not_built', 'action_not_granted', 'refused']) {
  const reason = `The requested tool needs a decision for ${status}.`;
  remote.toolResult = { isError: true, content: [{ type: 'text', text: reason }], structuredContent: { status, action: 'app.send_sign_in_link', detail: `${reason} ${secret}`, ...fields } };
  const result = await rer(['call', 'app.send_sign_in_link', '--json']);
  assert.equal(result.code, status === 'not_built' ? 3 : 1); assert.ok(result.stderr.includes(reason)); assert.ok(JSON.parse(result.stdout).message.includes(reason)); absent(result.stdout + result.stderr);
 }
 // Completed change/update refusals carry their explanation inside the followed object.
 for (const subject of ['change', 'update']) {
  const reason = `The ${subject} was refused because owner approval ended.`;
  remote.toolResult = { structuredContent: { [subject]: { id: 'work_1', state: 'failed', detail: `${reason} ${secret}`, ...fields }, next: 'done' } };
  const result = await rer([subject, 'follow', 'work_1', '--wait', '--json']);
  assert.equal(result.code, 1); assert.ok(result.stderr.includes(reason)); assert.ok(JSON.parse(result.stdout).message.includes(reason)); absent(result.stdout + result.stderr);
 }
 remote.toolResult = { isError: true, content: [{ type: 'text', text: 'The requested tool needs a decision.' }], structuredContent: { status: 'refused', detail: `The requested tool needs a decision. ${secret}`, ...fields } };
 const next = await rer(['next']);
 assert.equal(next.code, 1); assert.match(next.stderr, /The requested tool needs a decision/); absent(next.stdout + next.stderr);
 const child = start(['mcp']); t.after(() => child.kill());
 let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
 const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
 const ask = async (id, method) => { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: { name: 'next_question' } }) + '\n'); return JSON.parse((await lines.next()).value); };
 const refused = await ask(1, 'tools/call');
 assert.equal(refused.result.isError, true); assert.ok(refused.result.structuredContent.message.includes('requested tool needs a decision')); absent(JSON.stringify(refused));
 remote.rpcRefusal = { method: 'tools/list', error: { code: -32001, message: `The catalogue is paused. ${secret}`, data: fields } };
 const rpc = await ask(2, 'tools/list');
 assert.equal(rpc.error.code, -32001); assert.match(rpc.error.message, /Business MCP refused tools\/list.*The catalogue is paused/); assert.equal(rpc.error.data, undefined); absent(JSON.stringify(rpc));
 remote.rpcRefusal = { method: 'tools/list', error: { message: 'The catalogue is paused. ' + 'More context. '.repeat(2000) + 'TAIL_CANARY' } };
 const capped = await ask(3, 'tools/list');
 assert.ok(capped.error.message.length < 700); assert.ok(!capped.error.message.includes('TAIL_CANARY'));
 child.stdin.end(); await new Promise(done => child.on('close', done)); absent(stderr);
 // Pairing start uses a quiet exchange, but its safe reason still reaches stderr.
 await rm(join(home, '.rer/business/state.json'));
 remote.httpRefusal = { route: '/api/business/executors/device-pairings', status: 403, body: { message: `The owner paused pairing. ${secret}`, ...fields } };
 const pairing = await rer(['connect', '--business', 'biz', '--origin', remote.origin]);
 assert.equal(pairing.code, 1); assert.match(pairing.stderr, /The owner paused pairing/); absent(pairing.stdout + pairing.stderr);
});

test('an outside agent acts on installed apps through the agent verbs and the stdio bridge', async t => {
 const { remote, rer, start, calls } = await paired(t);

 const listed = await rer(['installations', 'list', '--json']);
 assert.equal(listed.code, 0, listed.stderr);
 assert.equal(JSON.parse(listed.stdout).installations[0].installation_id, 'inst_1');
 assert.match((await rer(['installations', 'list'])).stdout, /inst_1\s+happytohelp\s+Support\s+running/);

 // Request a change, wait for its preview, publish it and wait for live.
 const changed = await rer(['change', 'request', '--app', 'inst_1', 'Make the header blue', '--wait', '--publish', '--interval', '0.05']);
 assert.equal(changed.code, 0, changed.stderr);
 assert.deepEqual(remote.followed, ['working', 'working', 'preview_ready', 'publishing', 'live']);
 assert.deepEqual(remote.calls.find(([name]) => name === 'change.request')[1], { installation_id: 'inst_1', intent: 'Make the header blue' });
 for (const phase of ['working', 'preview_ready', 'publishing', 'live']) assert.match(changed.stdout, new RegExp(`Change chg_1: ${phase}`));
 assert.equal(remote.published, 1);

 // A tool that is not built yet has its own exit code; a refusal names where the owner grants the action.
 const unbuilt = await rer(['domain', 'records', 'inst_1']);
 assert.equal(unbuilt.code, 3);
 assert.match(unbuilt.stderr, /Not built yet: not built yet/);
 const ungranted = await rer(['app', 'send-sign-in-link', '--app', 'inst_1']);
 assert.equal(ungranted.code, 1);
 assert.match(ungranted.stderr, /app\.send_sign_in_link[^\n]*Business, under Computers/);
 assert.equal((await rer(['change', 'request', 'No app named'])).code, 2, 'a missing --app is a usage error, not a server call');

 // A change that is still working when --timeout runs out exits 75 and says how to keep waiting.
 remote.stall = true;
 const slow = await rer(['change', 'follow', 'chg_1', '--wait', '--timeout', '0.15', '--interval', '0.1']);
 assert.equal(slow.code, 75);
 assert.match(slow.stderr, /Keep waiting with: .*change follow chg_1 --wait/);

 const tools = await rer(['tools']);
 assert.match(tools.stdout, /^installations\.list {2}List the installed apps$/m);

 // The stdio bridge: an MCP client sends protocol messages; the bearer is minted and re-minted behind it.
 const child = start(['mcp']);
 const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
 const ask = async message => { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n'); return JSON.parse((await lines.next()).value); };
 t.after(() => child.kill());
 const initialized = await ask({ id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'agent', version: '1' } } });
 assert.equal(initialized.result.protocolVersion, '2025-11-25');
 child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
 const listing = await ask({ id: 2, method: 'tools/list' });
 assert.ok(listing.result.tools.some(tool => tool.name === 'installations.list'));
 const mints = remote.mints;
 for (const bearer of remote.bearers) remote.stale.add(bearer); // The server has dropped every bearer the bridge holds.
 const called = await ask({ id: 3, method: 'tools/call', params: { name: 'installations.list', arguments: {} } });
 assert.equal(called.id, 3);
 assert.equal(called.result.structuredContent.installations[0].installation_id, 'inst_1');
 assert.equal(remote.mints, mints + 1, 'the 401 minted one new bearer and retried once');
 const forms = [device, Buffer.from(device).toString('hex'), Buffer.from(device).toString('base64'), Buffer.from(device).toString('base64url')];
 remote.appName = forms.join(' ');
 const masked = await rer(['installations', 'list', '--json']);
 assert.equal(masked.code, 0, masked.stderr);
 assert.ok(JSON.parse(masked.stdout).installations[0].name.includes('[credential]'));
 const maskedMcp = JSON.stringify(await ask({ id: 4, method: 'tools/call', params: { name: 'installations.list', arguments: {} } }));
 for (const secret of forms) assert.ok(!(masked.stdout + masked.stderr + maskedMcp).includes(secret));
 child.stdin.end();
 const stderr = []; child.stderr.on('data', chunk => stderr.push(chunk));
 await new Promise(done => child.on('close', done));
 assert.equal(Buffer.concat(stderr).toString(), '');
 assert.equal(await readFile(calls, 'utf8'), '', 'all agent verbs and MCP refresh use the private file without OS storage');
});
