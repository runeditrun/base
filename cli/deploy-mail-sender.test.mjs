import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { deployProviderFixture } from './fixtures/deploy-provider.mjs';
import { productionSender } from './fixtures/production-sender.mjs';
import { saveState, credentialHandle } from './business/state.mjs';
import { createCredentialStore } from './business/keychain.mjs';

// The platform is the network edge: a Business door that answers read_handover and mail.sender as the platform does.
function businessDoor(origin, key) {
 const calls = [];
 const rpc = (id, result) => Response.json({ jsonrpc: '2.0', id, result });
 const fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  if (url.pathname === '/api/business/executors/token') return Response.json({ access_token: 'bz_task_' + 'a'.repeat(43), token_type: 'Bearer', audience: `${origin}/api/business/mcp`, task_id: null, expires_in: 300, expires_at: new Date(Date.now() + 300_000).toISOString() });
  assert.equal(url.pathname, '/api/business/mcp');
  if (body.method === 'initialize') return rpc(body.id, { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'business' } });
  if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
  calls.push(body.params);
  if (body.params.name === 'read_handover') return rpc(body.id, { isError: false, structuredContent: { owner_email: 'owner@clinic.test' } });
  return rpc(body.id, { isError: false, structuredContent: { tool: body.params.arguments.tool, address: body.params.arguments.address, recipient: 'owner@clinic.test', replaced: false,
   settings: { MAIL_PROVIDER: 'rer', MAIL_FROM: productionSender, MAIL_RELAY_URL: `${origin}/api/managed-mail/send` }, secret: { MAIL_API_KEY: key } } });
 };
 return { calls, fetch };
}

test('rer deploy gets owner-only relay mail from the connected Business, keeps it on redeploy, and says mail is off without one', async t => {
 const f = await deployProviderFixture(t, { vars: { MAIL_PROVIDER: 'resend' }, r2: [], publicSettings: ['MAIL_PROVIDER', 'MAIL_FROM', 'MAIL_RELAY_URL'], secrets: ['MAIL_PROVIDER', 'MAIL_FROM', 'MAIL_RELAY_URL', 'MAIL_API_KEY'].map(name => ({ binding: name, environment: name, optional: true })) });
 // A seed that signs its owner in without mail (`mailOffSignIn`) can deploy with mail off.
 await writeFile(join(f.root, 'adapter.mjs'), (await readFile(join(f.root, 'adapter.mjs'), 'utf8')).replace('const lifecycle = {', "const lifecycle = {mailOffSignIn:'rer signin',"));
 execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '-qam', 'mail-less sign-in'], { cwd: f.root });
 const home = await mkdtemp(join(tmpdir(), 'rer-business-'));
 t.after(() => rm(home, { recursive: true, force: true }));
 await mkdir(join(home, 'credentials'), { mode: 0o700 });
 Object.assign(process.env, { RER_BUSINESS_STATE_DIR: join(home, 'state'), RER_BUSINESS_CREDENTIAL_DIR: join(home, 'credentials') });
 for (const name of ['MAIL_PROVIDER', 'MAIL_FROM', 'MAIL_RELAY_URL', 'MAIL_API_KEY']) delete process.env[name];
 const origin = 'https://business.example.test', key = 'k'.repeat(43), door = businessDoor(origin, key);
 globalThis.fetch.mock.mockImplementation((input, init = {}) => {
  const url = new URL(input instanceof Request ? input.url : input);
  return url.origin === origin ? door.fetch(url, init) : f.provider.fetch(input, init);
 });
 const output = [];
 for (const stream of [process.stdout, process.stderr]) t.mock.method(stream, 'write', chunk => { output.push(String(chunk)); return true; });
 const deploy = async () => { output.length = 0; const code = await f.run(); return { code, text: output.join('') }; };
 const held = () => Object.fromEntries(f.provider.state.secrets.map(({ name, value }) => [name, value]));

 // Not connected to a Business: one line says mail is off, and the deploy goes out with MAIL_PROVIDER=none.
 const off = await deploy();
 assert.equal(off.code, 0, off.text);
 assert.match(off.text, /Mail is off: this computer is not connected to a Business/);
 assert.equal(held().MAIL_PROVIDER, 'none');
 assert.equal(door.calls.length, 0);

 // Connected: the deploy asks the door once for this tool's sender and the Worker holds the relay settings and key.
 await saveState({ version: 1, credentialVersion: 2, origin, businessId: 'biz_1', executorId: 'exe_1', vendorHandles: [], awakeConsent: false });
 await createCredentialStore().set(credentialHandle(origin, 'biz_1'), 'bz_device_' + 'd'.repeat(43));
 const on = await deploy();
 assert.equal(on.code, 0, on.text);
 const asked = door.calls.filter(call => call.name === 'mail.sender');
 assert.equal(asked.length, 1);
 assert.equal(asked[0].arguments.tool, 'fixture');
 assert.match(asked[0].arguments.address, /^https:\/\/[a-z0-9-]+\.fixture-account\.workers\.dev$/);
 assert.deepEqual(held(), { MAIL_PROVIDER: 'rer', MAIL_FROM: productionSender, MAIL_RELAY_URL: `${origin}/api/managed-mail/send`, MAIL_API_KEY: key });
 // The key reaches only the Worker's secret: never the output, the deploy records or the Business state.
 assert.ok(!on.text.includes(key));
 for (const folder of [join(f.root, '.rer'), home]) for (const file of await readdir(folder, { recursive: true, withFileTypes: true })) {
  if (file.isFile()) assert.ok(!(await readFile(join(file.parentPath, file.name), 'utf8')).includes(key), join(file.parentPath, file.name));
 }

 // A redeploy keeps the sender the Worker holds: asking again would replace its key.
 const again = await deploy();
 assert.equal(again.code, 0, again.text);
 assert.equal(door.calls.filter(call => call.name === 'mail.sender').length, 1);
 assert.equal(held().MAIL_API_KEY, key);
});
