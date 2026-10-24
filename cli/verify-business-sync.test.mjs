import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rm, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { credentialHandle } from './business/state.mjs';
import { deployEnvironment } from './deploy-inputs.mjs';
import { ownerPlan } from '../modules/deploy-kit/owner.mjs';
import { renderConfig, bindingsFor } from '../modules/deploy-kit/render.mjs';
import { withoutLocalSettings } from './local-env.mjs';
import { exportReference } from '../scripts/export-reference.mjs';
import { isolatedQueue } from './fixtures/queue.mjs';
import { localVariables } from '../onboarding/local/environment.mjs';
import { signSettings, testDocument, fixtureKeys } from '../modules/business-settings/testing/index.mjs';

const base = join(import.meta.dirname, '..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('sync joins an existing checkout with verified scoped pairing, keeps public trust for dev and deploy, and a joined offline dev reaches ready', { timeout: 600_000 }, async t => {
 const directory = await mkdtemp(join(base, '.business-connect-sync-'));
 const home = join(directory, 'home'), root = join(directory, 'checkout');
 await mkdir(home); await mkdir(root);
 const children = new Set(), transcript = [];
 t.after(async () => {
  for (const child of children) {
   if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid, 'SIGTERM');
   await child.done;
  }
  await rm(directory, { recursive: true, force: true });
 });
 const env = await isolatedQueue(t, { PATH: process.env.PATH, HOME: home, RER_NO_UPDATE_CHECK: '1',
  NODE_OPTIONS: `--import=${join(import.meta.dirname, 'fixtures/business/register.mjs')}` });
 function start(entry, args, cwd = root) {
  const child = spawn('perl', ['-e', 'setpgrp(0,0); exec @ARGV', '--', process.execPath, entry, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child); child.output = '';
  child.stdout.on('data', chunk => { child.output += chunk; });
  child.stderr.on('data', chunk => { child.output += chunk; });
  child.done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  return child;
 }
 async function command(...args) {
  const child = start(join(base, 'global/rer.mjs'), ['business', 'sync', ...args]);
  const code = await child.done; transcript.push(child.output);
  return { code, output: child.output };
 }
 await writeFile(join(root, 'adapter.mjs'), "export const commandAdapter={hooks:{secrets:{file:'.dev.vars'}}};\n");
 await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify({ version: 2, project: 'example/notes', runtime: { requirements: [] }, requiredEnvironment: [],
  seedContract: { version: 1, profile: 'first-party', adapter: 'adapter.mjs' }, commands: { dev: { argv: ['node', 'adapter.mjs'], inputs: ['adapter.mjs'], effects: 'Run the app.' } } }));
 const unpaired = await command();
 assert.equal(unpaired.code, 2); assert.match(unpaired.output, /rer business connect/);
 const requests = [], device = 'bz_device_' + randomUUID(), token = 'bz_task_' + randomUUID();
 let origin, rev = 1, adopted = true, tamper = false, apps = [{ app: 'notes-one', seed: 'notes', hosting: 'self_host' }];
 const platform = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  requests.push({ path: req.url, scoped: req.headers.authorization === `Bearer ${token}` });
  const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  if (req.url === '/api/business/executors/token') {
   assert.equal(req.headers.authorization, `Bearer ${device}`); assert.equal(JSON.parse(body).audience, 'mcp');
   return json(200, { access_token: token, token_type: 'Bearer', audience: origin + '/api/business/mcp', task_id: null, expires_in: 300, expires_at: new Date(Date.now() + 300_000).toISOString() });
  }
  assert.equal(req.headers.authorization, `Bearer ${token}`);
  if (req.url === '/api/business/executors/apps') return json(200, apps);
  if (!adopted) return json(409, { error: 'business_settings_not_adopted' });
  const settings = await signSettings(testDocument({ rev, iss: origin, sub: 'business/notes-one', business: 'business', email: 'audit@example.test' }));
  json(200, { settings: tamper ? settings.slice(0, -8) + 'AAAAAAAA' : settings, logo: null,
   trust: { v: 1, issuer: origin, audience: 'self-host', subject: 'business/notes-one', email: 'audit@example.test', keys: fixtureKeys } });
 });
 await new Promise(resolve => platform.listen(0, '127.0.0.1', resolve));
 origin = `http://127.0.0.1:${platform.address().port}`;
 t.after(() => { platform.closeAllConnections(); platform.close(); });
 await mkdir(join(home, '.rer/business'), { recursive: true });
 const statePath = join(home, '.rer/business/state.json');
 await writeFile(statePath, JSON.stringify({ origin, businessId: 'business', executorId: 'executor' }));
 const missingCredential = await command(); assert.equal(missingCredential.code, 2); assert.match(missingCredential.output, /rer business connect/);
 await writeFile(join(home, 'fake-keychain.json'), JSON.stringify({ [credentialHandle(origin)]: device }));
 let received = 0;
 const app = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  assert.equal(req.url, '/api/rer/business-settings'); assert.equal(req.headers.authorization, undefined);
  received++; const document = JSON.parse(body);
  assert.deepEqual(Object.keys(document), ['settings']);
  assert.equal(JSON.parse(Buffer.from(document.settings.split('.')[1], 'base64url')).rev, rev);
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ rev, applied: ['display_name'], overrides: [], logo: null, team: [] }));
 });
 await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
 t.after(() => { app.closeAllConnections(); app.close(); });
 const privateFile = `AUTH_ORIGIN=http://127.0.0.1:${app.address().port}\nPRIVATE_CANARY=private-local-canary\n`;
 await writeFile(join(root, '.dev.vars'), privateFile, { mode: 0o600 });
 const target = { project: 'notes', worker: 'notes-production', environment: 'production', origin: 'https://notes.example.test' };
 const declaration = { version: 1, compatibilityDate: '2026-09-08', vars: {} };
 const plan = async () => ownerPlan(target, declaration, { migrations: [] }, { env: (await deployEnvironment({ root, options: {}, declaration })).env });
 const resources = { d1: [], r2: [], queues: [] };
 const workerBindings = plan => bindingsFor(renderConfig(plan, resources, 'account', 'source', 'fingerprint', 'worker.mjs'), resources, plan);
 const beforePlan = await plan();
 assert.equal(beforePlan.vars.RER_BUSINESS_TRUST, undefined);
 assert.ok(!JSON.stringify(beforePlan).includes('private-local-canary'));
 assert.ok(!JSON.stringify(workerBindings(beforePlan)).includes('private-local-canary'));
 apps.push({ ...apps[0], app: 'notes-two' }); const multiple = await command(); assert.equal(multiple.code, 1);
 apps = []; const none = await command(); assert.equal(none.code, 1);
 apps = [{ app: 'notes-one', seed: 'notes', hosting: 'self_host' }];
 const wrongApp = await command('--app', 'foreign-app'); assert.equal(wrongApp.code, 1); assert.match(wrongApp.output, /business_app_not_found/);
 const nonSeed = start(join(base, 'global/rer.mjs'), ['business', 'sync'], home);
 assert.equal(await nonSeed.done, 1); assert.match(nonSeed.output, /business_checkout_not_seed/);
 tamper = true; const invalidDocument = await command(); assert.equal(invalidDocument.code, 1);
 await assert.rejects(stat(join(root, '.rer/business.json')), { code: 'ENOENT' });
 await assert.rejects(stat(join(root, '.rer/business-runtime.json')), { code: 'ENOENT' });
 assert.equal(await readFile(join(root, '.dev.vars'), 'utf8'), privateFile); tamper = false;
 const applied = await command(); assert.equal(applied.code, 0, applied.output); assert.equal(received, 1); assert.match(applied.output, /rev 1/);
 rev = 2; assert.equal((await command('--app', 'notes-one')).code, 0); assert.equal(received, 2);
 const config = await readFile(join(root, '.rer/business-runtime.json'), 'utf8');
 const membership = await readFile(join(root, '.rer/business.json'), 'utf8');
 assert.equal((await stat(join(root, '.rer/business.json'))).mode & 0o777, 0o600);
 assert.ok((await readFile(join(root, '.dev.vars'), 'utf8')).includes('RER_BUSINESS_TRUST='));
 assert.deepEqual(JSON.parse(localVariables(await readFile(join(root, '.dev.vars'), 'utf8')).RER_BUSINESS_TRUST), JSON.parse(config).RER_BUSINESS_TRUST);
 const deployed = await plan(); assert.ok(deployed.vars.RER_BUSINESS_TRUST);
 const bindings = workerBindings(deployed);
 assert.equal(bindings.find(item => item.name === 'RER_BUSINESS_TRUST')?.text, deployed.vars.RER_BUSINESS_TRUST);
 assert.ok(!JSON.stringify(bindings).includes('private-local-canary'));
 assert.ok(!JSON.stringify(deployed).includes('private-local-canary'));
 await withoutLocalSettings(root, {}, async () => {
  await assert.rejects(stat(join(root, '.dev.vars')), { code: 'ENOENT' });
  assert.equal((await plan()).vars.RER_BUSINESS_TRUST, deployed.vars.RER_BUSINESS_TRUST);
 });
 const foreign = JSON.parse(config); foreign.RER_BUSINESS_TRUST.subject = 'other-business/notes-one';
 await writeFile(join(root, '.rer/business-runtime.json'), JSON.stringify(foreign), { mode: 0o600 });
 const connected = await command(); assert.equal(connected.code, 1); assert.match(connected.output, /business_checkout_connected/);
 const noTerminal = await command('--replace'); assert.equal(noTerminal.code, 1); assert.match(noTerminal.output, /business_checkout_connected/);
 assert.equal(await readFile(join(root, '.rer/business-runtime.json'), 'utf8'), JSON.stringify(foreign));
 await writeFile(join(root, '.rer/business-runtime.json'), config, { mode: 0o600 });
 adopted = false;
 const notAdopted = await command(); assert.equal(notAdopted.code, 1);
 assert.equal(await readFile(join(root, '.rer/business-runtime.json'), 'utf8'), config);
 assert.equal(await readFile(join(root, '.rer/business.json'), 'utf8'), membership);
 assert.ok(requests.filter(row => row.path !== '/api/business/executors/token').every(row => row.scoped));
 platform.closeAllConnections(); await new Promise(resolve => platform.close(resolve));
 const beforeOffline = await readFile(join(root, '.dev.vars'), 'utf8');
 assert.equal((await command()).code, 1);
 assert.equal(await readFile(join(root, '.rer/business-runtime.json'), 'utf8'), config);
 assert.equal(await readFile(join(root, '.rer/business.json'), 'utf8'), membership);
 assert.equal(await readFile(join(root, '.dev.vars'), 'utf8'), beforeOffline);
 const left = await command('--leave'); assert.equal(left.code, 0);
 await assert.rejects(stat(join(root, '.rer/business.json')), { code: 'ENOENT' });
 await assert.rejects(stat(join(root, '.rer/business-runtime.json')), { code: 'ENOENT' });
 assert.equal(await readFile(join(root, '.dev.vars'), 'utf8'), privateFile);
 assert.ok(!/audit@example|bz_device_|bz_task_|eyJhbGci|RER_OPEN/.test(transcript.join('') + config + membership));
 for (const [label, result] of [['unpaired', unpaired], ['multiple', multiple], ['none', none], ['not-adopted', notAdopted], ['wrong-app', wrongApp], ['invalid-signature', invalidDocument], ['different-business', connected], ['replace-without-terminal', noTerminal], ['applied', applied], ['leave', left]]) t.diagnostic(`${label} exit=${result.code}: ${result.output.trim()}`);
 t.diagnostic(`sync rev 1 and 2 acknowledged; ${requests.length} platform requests; scoped reads; trust before=false after=true in dev, plan and Worker bindings; private canary absent before/after; offline files unchanged; refusals and leave passed`);

 // Exercise the real maintained app and managed-server readiness hook offline.
 const runtime = join(directory, 'runtime'); await exportReference(base, runtime);
 await symlink(join(base, 'default-seed/node_modules'), join(runtime, 'node_modules'), 'dir');
 await mkdir(join(runtime, '.rer'), { recursive: true });
 await writeFile(join(runtime, '.rer/business.json'), JSON.stringify({ v: 1, app: 'notes-one', seed: 'runeditrun/default-seed-reference' }), { mode: 0o600 });
 const dev = start(join(base, 'global/rer.mjs'), ['dev', '--cwd', runtime, '--foreground', '--json']);
 const deadline = Date.now() + 480_000;
 while (!dev.output.split('\n').some(line => { try { return JSON.parse(line).event === 'ready'; } catch { return false; } })) {
  assert.equal(dev.exitCode, null, 'the real app reaches readiness'); assert.ok(Date.now() < deadline, 'real app readiness deadline'); await delay(100);
 }
 const ready = dev.output.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }).find(row => row.event === 'ready');
 assert.equal((await fetch(ready.url + '/health')).status, 200);
 const syncDeadline = Date.now() + 5000;
 while (!dev.output.includes('business-sync')) { assert.ok(Date.now() < syncDeadline, 'one bounded sync failure follows ready'); await delay(50); }
 const events = dev.output.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
 assert.ok(events.findIndex(row => row.event === 'ready') < events.findIndex(row => row.event === 'business-sync'));
 process.kill(-dev.pid, 'SIGTERM'); await dev.done;
 t.diagnostic('real default-seed /health 200; ready precedes one offline Business sync result; owned process group closed');
});
