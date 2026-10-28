import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { main as cli } from './main.mjs';
import { checkout, account } from './fixtures/owner-deploy.mjs';

test('deploy dry run prints a local plan without credentials or provider access while deploy keeps its refusals', async t => {
 const secrets = [
  { binding: 'GOOGLE_MAIL_CLIENT_ID', environment: 'FIXTURE_GOOGLE_ID' },
  { binding: 'GOOGLE_MAIL_CLIENT_SECRET', environment: 'FIXTURE_GOOGLE_SECRET' },
  { binding: 'OPTIONAL_MAIL', environment: 'FIXTURE_OPTIONAL_MAIL', optional: true },
 ];
 const { root, git } = await checkout(t, { secrets, project: 'synthetic-base-1' });
 await writeFile(join(root, 'adapter.mjs'), `import {ownerDeploy} from ${JSON.stringify(new URL('./deploy.mjs', import.meta.url).href)};
const lifecycle = {run:async()=>{},settings:{},hooks:{}};
export const commandAdapter = {...lifecycle,deploy:ownerDeploy('deploy.json',lifecycle)};`);
 await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify({ version: 2, project: 'tests/fixture', runtime: { requirements: [] }, requiredEnvironment: [], seedContract: { version: 1, profile: 'first-party', adapter: 'adapter.mjs' }, commands: { deploy: { argv: ['node', 'adapter.mjs'], inputs: ['adapter.mjs', 'deploy.json'], effects: 'Deploy to the fake provider.' } } }));
 await writeFile(join(root, '.node-version'), process.versions.node + '\n');
 await writeFile(join(root, 'package.json'), JSON.stringify({ engines: { node: process.versions.node }, packageManager: 'pnpm@10.12.4' }));
 git('add', '.'); git('commit', '-qm', 'deploy door');
 const { provider } = account(t);
 const saved = Object.fromEntries(['CI', 'HOME', ...Object.keys(process.env).filter(name => /^(CLOUDFLARE_|CF_)/.test(name)), ...secrets.map(item => item.environment)].map(name => [name, process.env[name]]));
 t.after(() => { for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value; });
 process.env.CI = 'true';
 process.env.HOME = root;
 for (const { environment } of secrets) delete process.env[environment];
 const invoke = async (json, ...flags) => {
  const output = [], diagnostics = [];
  const capture = t.mock.method(process.stdout, 'write', chunk => { output.push(String(chunk)); return true; });
  const stderr = t.mock.method(process.stderr, 'write', chunk => { diagnostics.push(String(chunk)); return true; });
  const code = await cli(['deploy', ...flags, '--cwd', root, ...(json ? ['--json'] : [])]).finally(() => { capture.mock.restore(); stderr.mock.restore(); });
  const events = json ? output.join('').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  return { code, text: output.join('') + diagnostics.join(''), events, error: events.find(event => event.event === 'error'), stderr: diagnostics.join('') };
 };
 const rer = (...flags) => invoke(true, ...flags);
 const readOnly = async (...flags) => {
  const before = provider.state.calls.length;
  const result = await rer('--dry-run', ...flags);
  assert.equal(provider.state.calls.length, before, 'no provider call reaches the fake target');
  return result;
 };
 for (const name of Object.keys(process.env)) if (/^(CLOUDFLARE_|CF_)/.test(name)) delete process.env[name];
 const dry = await readOnly();
 assert.equal(dry.code, 0, dry.text);
 const plan = dry.events.at(-1).plan;
 assert.equal(plan.worker, 'synthetic-base-1-production');
 assert.equal(plan.d1[0].binding, 'DB');
 assert.deepEqual(plan.d1[0].migrations, ['0001_owner.sql']);
 assert.deepEqual(plan.secrets.map(item => item.binding), secrets.map(item => item.binding));
 assert.match(dry.text, /no credentials were needed/);
 assert.match(dry.text, /nothing was changed remotely/);
 const human = await invoke(false, '--dry-run');
 assert.equal(human.code, 0, human.text);
 assert.match(human.text, /Would deploy:/);
 t.diagnostic(`Dry run: exit ${human.code}; ${human.text}`);
 await assert.rejects(access(join(root, '.rer/deploy/production.json')), { code: 'ENOENT' });
 const real = await rer();
 assert.equal(real.code, 3, real.text);
 assert.match(real.error.message, /CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required to deploy to your Cloudflare account. Nothing was deployed./);
 t.diagnostic(`Real deploy: exit ${real.code}; ${real.error.message}`);
 assert.equal(provider.state.calls.length, 0);
 Object.assign(process.env, {CLOUDFLARE_ACCOUNT_ID:provider.accountId, CLOUDFLARE_API_TOKEN:provider.token});
 const missing = await rer();
 assert.equal(missing.code, 1);
 for (const {binding, environment} of secrets.filter(item => !item.optional)) {
  assert.ok(missing.error.message.includes(binding), missing.error.message);
  assert.ok(missing.error.message.includes(environment), missing.error.message);
 }
 assert.equal(provider.state.writes.length, 0);
 Object.assign(process.env, { FIXTURE_GOOGLE_ID: 'synthetic-base-2', FIXTURE_GOOGLE_SECRET: 'synthetic-base-3' });
 assert.equal((await readOnly()).code, 0);
 assert.equal(provider.state.writes.length, 0, 'supplied bindings are validated without uploading them');
 assert.equal((await rer()).code, 0, 'establish the existing target through the same fake deploy door');
 delete process.env.FIXTURE_GOOGLE_ID; delete process.env.FIXTURE_GOOGLE_SECRET;
 const writes = provider.state.writes.length, statePath = join(root, '.rer/deploy/production.json'), state = await readFile(statePath);
 const held = await readOnly();
 assert.equal(held.code, 0);
 assert.ok(held.text.includes('FIXTURE_GOOGLE_ID'), 'local plan cannot confirm held secrets');
 assert.equal(provider.state.writes.length, writes);
 assert.deepEqual(await readFile(statePath), state, 'dry run leaves deployment state untouched');
 provider.state.secrets.splice(0, provider.state.secrets.length);
 const absent = await readOnly(), refused = await rer();
 assert.equal(absent.code, 0);
 assert.equal(refused.code, 1);
 for (const { binding } of secrets.filter(item => !item.optional)) assert.ok(refused.error.message.includes(binding), refused.error.message);
 assert.equal(provider.state.writes.length, writes);
 provider.fail('GET', /\/secrets$/, { status: 403 });
 const denied = await readOnly();
 assert.equal(denied.code, 0, 'local dry run does not require secret-list permission');
 const realDenied = await rer();
 assert.equal(realDenied.code, 1);
 assert.match(realDenied.error.message, /secret.*list|list.*secret/i);
 assert.match(realDenied.error.message, /Workers Scripts|token-scope-missing-workers/);
 Object.assign(process.env, { FIXTURE_GOOGLE_ID: 'synthetic-base-2', FIXTURE_GOOGLE_SECRET: 'synthetic-base-3' });
 assert.equal((await rer()).code, 0);
 assert.equal((await rer('--unset-secret', 'GOOGLE_MAIL_CLIENT_ID')).code, 0);
 delete process.env.FIXTURE_GOOGLE_ID; delete process.env.FIXTURE_GOOGLE_SECRET;
 const retiredState = await readFile(statePath), retiredWrites = provider.state.writes.length;
 assert.equal((await readOnly()).code, 0, 'the same recorded retired binding stays out of dry-run and deploy plans');
 assert.deepEqual(await readFile(statePath), retiredState);
 assert.equal(provider.state.writes.length, retiredWrites);
 delete process.env.CLOUDFLARE_API_TOKEN;
 const unauthenticated = await readOnly();
 assert.equal(unauthenticated.code, 0);
 assert.equal(provider.state.writes.length, retiredWrites);
});
