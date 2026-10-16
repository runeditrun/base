import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ownerDeploy } from './deploy.mjs';
import { deployCommand } from './deploy-command.mjs';
import { main as ownerKit } from '../modules/deploy-kit/owner-cli.mjs';
import { manifest, checkout, account, lifecycle, store } from './fixtures/owner-deploy.mjs';
import { deployProviderFixture } from './fixtures/deploy-provider.mjs';

const declaration = { originVar: 'APP_ORIGIN', publicOriginSetting: 'PUBLIC_ORIGIN',
 r2: [{ binding: 'FILES' }], queues: [{ binding: 'JOBS' }],
 secrets: ['OWNER_EMAIL', 'SESSION_SECRET', 'SETUP_TOKEN'].map(name => ({ binding: name, environment: name })) };

async function fixture(t) {
 const { root } = await checkout(t, declaration);
 const { provider, claims } = account(t), requests = [];
 const network = globalThis.fetch;
 t.mock.method(globalThis, 'fetch', async (input, init) => { requests.push(new URL(input)); return network(input, init); });
 let builds = 0;
 const adapter = { ...lifecycle, run: async () => { builds++; } };
 const deploy = ownerDeploy('deploy.json', adapter);
 const context = (options = {}) => ({ root, adapter: { ...adapter, deploy }, options, store: store(), setupManifest: manifest });
 const run = (options = {}) => deployCommand(context(options));
 const state = async () => JSON.parse(await readFile(join(root, '.rer/deploy/production.json'), 'utf8'));
 const origin = () => provider.state.settings.bindings.find(item => item.name === 'APP_ORIGIN').text;
 return { root, provider, claims, requests, adapter, run, state, origin, context, builds: () => builds };
}

test('deploy changes only the canonical origin binding, retaining workers.dev readiness, resources and owner', async t => {
 const f = await fixture(t);
 const first = await f.run();
 assert.equal(f.origin(), first.origin, 'omission keeps the workers.dev binding');
 const before = await f.state(), writes = f.provider.state.writes.length;
 await f.run();
 assert.equal(f.provider.state.writes.length, writes, 'an omitted-origin repeat writes nothing');
 assert.deepEqual(await f.state(), before);

 // A saved setting configures the public origin without changing the source.
 await writeFile(join(f.root, '.dev.vars'), 'OWNER_EMAIL=owner@example.test\nPUBLIC_ORIGIN=https://public.example.test:8443\n', { mode: 0o600 });
 const changed = await f.run();
 assert.equal(f.origin(), 'https://public.example.test:8443');
 assert.equal(changed.origin, first.origin);
 const after = await f.state();
 for (const key of ['accountId', 'project', 'environment', 'worker', 'owned', 'ownerClaim']) assert.deepEqual(after[key], before[key], key);
 assert.deepEqual(after.receipt.resources, before.receipt.resources);
 assert.equal(f.claims.length, 1, 'the recorded owner is claimed only once');
 assert.ok(f.requests.some(url => url.pathname === '/health'));
 assert.ok(f.requests.filter(url => url.hostname !== 'api.cloudflare.com' && !url.hostname.endsWith('.r2.cloudflarestorage.com')).every(url => url.origin === first.origin), 'all readiness and owner requests stay on workers.dev');
 const changedWrites = f.provider.state.writes.length, saved = await readFile(join(f.root, '.rer/deploy/production.json'));
 await f.run();
 assert.equal(f.provider.state.writes.length, changedWrites, 'an unchanged canonical-origin repeat writes nothing');
 assert.deepEqual(await readFile(join(f.root, '.rer/deploy/production.json')), saved);
});

test('rer deploy parses env-file and uses it over environment and saved public origin', async t => {
 const f = await deployProviderFixture(t, { originVar: 'APP_ORIGIN', publicOriginSetting: 'PUBLIC_ORIGIN' });
 const origin = () => f.provider.state.settings.bindings.find(item => item.name === 'APP_ORIGIN').text;
 await writeFile(join(f.root, '.dev.vars'), 'OWNER_EMAIL=owner@example.test\nPUBLIC_ORIGIN=https://saved.example.test\n', { mode: 0o600 });
 process.env.PUBLIC_ORIGIN = 'https://environment.example.test';
 assert.equal(await f.run(), 0);
 assert.equal(origin(), process.env.PUBLIC_ORIGIN);
 await writeFile(join(f.root, 'deploy.env'), 'PUBLIC_ORIGIN=https://file.example.test:443\n', { mode: 0o600 });
 assert.equal(await f.run('--env-file', 'deploy.env'), 0);
 assert.equal(origin(), 'https://file.example.test');
 const writes = f.provider.state.writes.length;
 assert.equal(await f.run('--env-file', 'deploy.env'), 0);
 assert.equal(f.provider.state.writes.length, writes);
});

test('deploy refuses invalid public origins before build or provider effects, including dry-run and custom hooks', async t => {
 const f = await fixture(t);
 const invalid = ['http://example.test', 'ftp://example.test', '//example.test', 'https:example.test',
  'https://user@example.test', 'https://user:password@example.test', 'https://@example.test',
  'https://example.test/', 'https://example.test/path', 'https://example.test/..',
  'https://example.test?x=1', 'https://example.test?', 'https://example.test#part', 'https://example.test#',
  'https://example.test\\path', ' https://example.test', 'https://exa mple.test',
  'https://example.test:65536', 'https://example.test:', 'https://', 'https://[invalid]', ''];
 for (const value of invalid) {
  await writeFile(join(f.root, 'deploy.env'), `PUBLIC_ORIGIN=${JSON.stringify(value)}\n`, { mode: 0o600 });
  for (const dryRun of [false, true]) await assert.rejects(f.run({ envFile: 'deploy.env', dryRun }), { code: 'invalid_invocation' }, value);
 }
 assert.equal(f.builds(), 0);
 assert.equal(f.provider.state.calls.length, 0);
 assert.equal(f.provider.state.writes.length, 0);
 await writeFile(join(f.root, '.dev.vars'), 'PUBLIC_ORIGIN=https://example.test/path\n', { mode: 0o600 });
 await assert.rejects(f.run(), { code: 'invalid_invocation' });
 const context = f.context({ envFile: 'deploy.env' });
 context.adapter.deploy = async () => { throw new Error('custom hook must not run'); };
 context.adapter.deployDeclaration = 'deploy.json';
 await assert.rejects(deployCommand(context), { code: 'invalid_invocation' });
 // Direct kit use by a generated deploy hook has the same preflight boundary.
 await assert.rejects(ownerKit(['deploy', '--declaration', 'deploy.json', '--environment', 'production'], { ...process.env, PUBLIC_ORIGIN: 'https://example.test/path' }, { cwd: f.root }), /invalid-public-origin/);
 assert.equal(f.provider.state.calls.length, 0);
});

test('custom deploy hooks receive the declared public origin from native JSON settings', async t => {
 const f = await fixture(t);
 // Native settings descriptors survive commandAdapter's public filename list.
 f.adapter.hooks = { ...f.adapter.hooks, secrets: { file: 'deploy.env', format: 'json' } };
 await writeFile(join(f.root, 'deploy.env'), JSON.stringify({ OWNER_EMAIL: 'owner@example.test', PUBLIC_ORIGIN: 'https://native.example.test' }), { mode: 0o600 });
 const context = f.context();
 context.adapter.settings = ['deploy.env'];
 context.adapter.deployDeclaration = 'deploy.json';
 context.adapter.deploy = async ({ root, options }) => ({ deployed: true, ...await ownerKit(['deploy', '--declaration', 'deploy.json', '--environment', options.environment ?? 'production'], process.env, { cwd: root }) });
 const result = await deployCommand(context);
 assert.equal(f.origin(), 'https://native.example.test');
 assert.equal(result.owner, 'claimed');
 assert.ok(new URL(result.origin).hostname.endsWith('.workers.dev'));
});
