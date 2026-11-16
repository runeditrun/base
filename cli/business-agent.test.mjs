import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
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
 await writeFile(join(home, '.rer/business/state.json'), JSON.stringify({ origin: remote.origin, businessId: 'biz', executorId: 'executor1', credentialVersion: 2 }));
 const credentials = join(home, 'credentials'), calls = join(home, 'keychain-calls');
 await mkdir(credentials, { mode: 0o700 });
 await writeFile(join(credentials, `${credentialHandle(remote.origin, 'biz').slice(7)}.credential`), device, { mode: 0o600 });
 await writeFile(calls, '');
 const env = { PATH: process.env.PATH, HOME: home, RER_NO_UPDATE_CHECK: '1', RER_BUSINESS_CREDENTIAL_DIR: credentials, RER_TEST_KEYCHAIN_CALLS: calls, NODE_OPTIONS: `--import=${fileURLToPath(new URL('./fixtures/business/register.mjs', import.meta.url))}` };
 const start = args => spawn(process.execPath, [join(base, 'bin/rer.mjs'), 'business', ...args], { cwd: home, env, stdio: ['pipe', 'pipe', 'pipe'] });
 const rer = args => new Promise(done => {
  const child = start(args); let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('close', code => done({ code, stdout, stderr })); child.stdin.end();
 });
 return { remote, rer, start, calls };
}

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
