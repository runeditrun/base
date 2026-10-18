import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { main as cli } from './main.mjs';
import { checkout, account } from './fixtures/owner-deploy.mjs';

test('deploy dry run shares required-secret refusal with deploy, reads held secrets, and never writes to the target', async t => {
 const secrets = [
  { binding: 'GOOGLE_MAIL_CLIENT_ID', environment: 'FIXTURE_GOOGLE_ID' },
  { binding: 'GOOGLE_MAIL_CLIENT_SECRET', environment: 'FIXTURE_GOOGLE_SECRET' },
  { binding: 'OPTIONAL_MAIL', environment: 'FIXTURE_OPTIONAL_MAIL', optional: true },
 ];
 const { root, git } = await checkout(t, { secrets });
 await writeFile(join(root, 'adapter.mjs'), `import {ownerDeploy} from ${JSON.stringify(new URL('./deploy.mjs', import.meta.url).href)};
const lifecycle = {run:async()=>{},settings:{},hooks:{}};
export const commandAdapter = {...lifecycle,deploy:ownerDeploy('deploy.json',lifecycle)};`);
 await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify({ version: 2, project: 'tests/fixture', runtime: { requirements: [] }, requiredEnvironment: [], seedContract: { version: 1, profile: 'first-party', adapter: 'adapter.mjs' }, commands: { deploy: { argv: ['node', 'adapter.mjs'], inputs: ['adapter.mjs', 'deploy.json'], effects: 'Deploy to the fake provider.' } } }));
 await writeFile(join(root, '.node-version'), process.versions.node + '\n');
 await writeFile(join(root, 'package.json'), JSON.stringify({ engines: { node: process.versions.node }, packageManager: 'pnpm@10.12.4' }));
 git('add', '.'); git('commit', '-qm', 'deploy door');
 const { provider } = account(t);
 const saved = Object.fromEntries(['CI', ...secrets.map(item => item.environment)].map(name => [name, process.env[name]]));
 t.after(() => { for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value; });
 process.env.CI = 'true';
 for (const { environment } of secrets) delete process.env[environment];
 const invoke = async (json, ...flags) => {
  const output = [], diagnostics = [];
  const capture = t.mock.method(process.stdout, 'write', chunk => { output.push(String(chunk)); return true; });
  const stderr = t.mock.method(process.stderr, 'write', chunk => { diagnostics.push(String(chunk)); return true; });
  const code = await cli(['deploy', ...flags, '--cwd', root, ...(json ? ['--json'] : [])]).finally(() => { capture.mock.restore(); stderr.mock.restore(); });
  const events = json ? output.join('').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  return { code, events, error: events.find(event => event.event === 'error'), stderr: diagnostics.join('') };
 };
 const rer = (...flags) => invoke(true, ...flags);
 const readOnly = async (...flags) => {
  const before = provider.state.calls.length;
  const result = await rer('--dry-run', ...flags);
  assert.ok(provider.state.calls.slice(before).every(call => call.method === 'GET'), 'no write call reaches the fake target');
  return result;
 };
 const dry = await readOnly();
 assert.equal(dry.code, 1, 'a missing required binding must fail the dry run');
 for (const { binding, environment } of secrets.filter(item => !item.optional)) {
  assert.ok(dry.error.message.includes(binding), dry.error.message);
  assert.ok(dry.error.message.includes(environment), dry.error.message);
 }
 assert.equal(provider.state.writes.length, 0);
 const human = await invoke(false, '--dry-run');
 assert.equal(human.code, dry.code);
 assert.ok(human.stderr.includes(dry.error.message), human.stderr);
 assert.ok(provider.state.calls.every(call => call.method === 'GET'));
 t.diagnostic(`Missing target secrets: exit ${human.code}; ${dry.error.message}`);
 await assert.rejects(access(join(root, '.rer/deploy/production.json')), { code: 'ENOENT' });
 const real = await rer();
 assert.equal(dry.code, real.code);
 assert.deepEqual(dry.error, real.error, 'JSON reports the same refusal');
 assert.equal(provider.state.writes.length, 0);
 Object.assign(process.env, { FIXTURE_GOOGLE_ID: 'test-only-id', FIXTURE_GOOGLE_SECRET: 'test-only-secret' });
 assert.equal((await readOnly()).code, 0);
 assert.equal(provider.state.writes.length, 0, 'supplied bindings are validated without uploading them');
 assert.equal((await rer()).code, 0, 'establish the existing target through the same fake deploy door');
 delete process.env.FIXTURE_GOOGLE_ID; delete process.env.FIXTURE_GOOGLE_SECRET;
 const writes = provider.state.writes.length, statePath = join(root, '.rer/deploy/production.json'), state = await readFile(statePath);
 const held = await readOnly();
 assert.equal(held.code, 0);
 assert.equal(held.events.some(event => JSON.stringify(event).includes('FIXTURE_GOOGLE_ID')), false, 'held secrets are not reported as still needed');
 assert.equal(provider.state.writes.length, writes);
 assert.deepEqual(await readFile(statePath), state, 'dry run leaves deployment state untouched');
 provider.state.secrets.splice(0, provider.state.secrets.length);
 const absent = await readOnly(), refused = await rer();
 assert.equal(absent.code, 1);
 assert.deepEqual(absent.error, refused.error);
 for (const { binding } of secrets.filter(item => !item.optional)) assert.ok(absent.error.message.includes(binding), absent.error.message);
 assert.equal(provider.state.writes.length, writes);
 provider.fail('GET', /\/secrets$/, { status: 403 });
 const denied = await readOnly();
 assert.equal(denied.code, 1);
 assert.match(denied.error.message, /secret.*list|list.*secret/i);
 assert.match(denied.error.message, /Workers Scripts|token-scope-missing-workers/);
 Object.assign(process.env, { FIXTURE_GOOGLE_ID: 'test-only-id', FIXTURE_GOOGLE_SECRET: 'test-only-secret' });
 assert.equal((await rer()).code, 0);
 assert.equal((await rer('--unset-secret', 'GOOGLE_MAIL_CLIENT_ID')).code, 0);
 delete process.env.FIXTURE_GOOGLE_ID; delete process.env.FIXTURE_GOOGLE_SECRET;
 const retiredState = await readFile(statePath), retiredWrites = provider.state.writes.length;
 assert.equal((await readOnly()).code, 0, 'the same recorded retired binding stays out of dry-run and deploy plans');
 assert.deepEqual(await readFile(statePath), retiredState);
 assert.equal(provider.state.writes.length, retiredWrites);
 delete process.env.CLOUDFLARE_API_TOKEN;
 const unauthenticated = await readOnly();
 assert.equal(unauthenticated.code, 3);
 assert.match(unauthenticated.error.message, /CLOUDFLARE_API_TOKEN/);
 assert.equal(provider.state.writes.length, retiredWrites);
});
