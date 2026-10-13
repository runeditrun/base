import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { ownerDeploy } from './deploy.mjs';
import { ownerProvider } from '../modules/deploy-kit/tests/owner-provider.mjs';

// rer deploy through its public adapter door, against the fake Cloudflare account
// (the only fake: the provider and the hosted app's owner step at the network edge).

const manifest = { steps: [{ type: 'owner-claim', mode: 'signed', emailField: 'OWNER_EMAIL', tokenField: 'SETUP_TOKEN', path: '/auth/owner-claim' }],
 fields: [{ name: 'SESSION_SECRET', kind: 'secret', generate: 'hex' }, { name: 'SETUP_TOKEN', kind: 'secret', generate: 'hex' }] };

async function checkout(t, declaration) {
 const root = await realpath(await mkdtemp(join(tmpdir(), 'rer-deploy-owner-'))); t.after(() => rm(root, { recursive: true, force: true }));
 for (const path of ['dist/server', 'dist/client', 'migrations/core']) await mkdir(join(root, path), { recursive: true });
 await writeFile(join(root, 'dist/server/wrangler.json'), JSON.stringify({ main: 'index.js', no_bundle: true, rules: [{ type: 'ESModule', globs: ['**/*.js', '**/*.mjs'] }] }));
 await writeFile(join(root, 'dist/server/index.js'), 'export default {scheduled(){},fetch(){}}');
 await writeFile(join(root, 'dist/client/index.html'), 'app');
 await writeFile(join(root, 'migrations/core/0001_owner.sql'), 'CREATE TABLE owner(id TEXT PRIMARY KEY);');
 await writeFile(join(root, 'deploy.json'), JSON.stringify({ version: 1, project: 'tests/fixture', compatibilityDate: '2026-09-08', d1: [{ binding: 'DB' }], ...declaration }));
 await writeFile(join(root, '.gitignore'), 'dist/\n.rer/\n.dev.vars\ndeploy.env\n');
 // The local setup's private settings: the owner rer deploy reuses.
 await writeFile(join(root, '.dev.vars'), 'OWNER_EMAIL=owner@example.test\nSESSION_SECRET=local-only-session\n', { mode: 0o600 });
 const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', ...args], { cwd: root, stdio: 'pipe' });
 git('init', '-q'); git('add', '.'); git('commit', '-qm', 'first');
 return { root, git };
}

function account(t, { claimed = false } = {}) {
 const provider = ownerProvider(), claims = [];
 const saved = Object.fromEntries(['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'MAIL_API_KEY', 'SESSION_SECRET', 'SETUP_TOKEN', 'OWNER_EMAIL'].map(name => [name, process.env[name]]));
 for (const name of Object.keys(saved)) delete process.env[name];
 Object.assign(process.env, { CLOUDFLARE_ACCOUNT_ID: provider.accountId, CLOUDFLARE_API_TOKEN: provider.token });
 t.after(() => { for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } provider.close(); });
 t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
  const url = new URL(input);
  if (url.hostname.endsWith('.workers.dev') && url.pathname === '/auth/bootstrap') {
   const body = JSON.parse(init.body), live = provider.state.secrets.find(item => item.name === 'SETUP_TOKEN')?.value;
   claims.push({ origin: init.headers.Origin, matches: body.token === live });
   if (body.token !== live) return Response.json({ error: 'invalid_token' }, { status: 403 });
   if (claimed) return Response.json({ error: 'already_initialized' }, { status: 409 });
   claimed = true; return new Response(null, { status: 303, headers: { Location: '/' } });
  }
  return provider.fetch(input, init);
 });
 return { provider, claims };
}

const lifecycle = { run: async () => {}, settings: {}, hooks: { owner: { existingOwnerViaSignIn: true, displayName: input => input.displayName || 'Owner' } } };
const store = () => { const lines = []; return { lines, state: {}, report: line => lines.push(line) }; };
const secretNames = provider => provider.state.secrets.map(item => item.name).sort();

test('rer deploy claims the setup owner on the hosted app, retires the setup token, and later updates the same Worker', async t => {
 const secrets = ['OWNER_EMAIL', 'SESSION_SECRET', 'SETUP_TOKEN', 'MAIL_API_KEY'].map(name => ({ binding: name, environment: name }));
 const { root, git } = await checkout(t, { secrets, crons: ['* * * * *'] });
 const { provider, claims } = account(t);
 const deploy = ownerDeploy('deploy.json', lifecycle), linked = [];
 const run = (options = {}, out = store()) => deploy({ root, options: { environment: 'production', ...options }, store: out, setupManifest: manifest, linkDependencies: async (origin, token) => linked.push(Boolean(origin && token)) });
 // A missing input is named, and nothing is created.
 await assert.rejects(run(), error => /Deploy needs MAIL_API_KEY/.test(error.message) && /--env-file/.test(error.message));
 assert.equal(provider.state.writes.length, 0);
 await writeFile(join(root, 'deploy.env'), 'MAIL_API_KEY="from-the-env-file"\n', { mode: 0o600 });
 const out = store(), first = await run({ envFile: 'deploy.env' }, out);
 assert.equal(first.deployed, true); assert.equal(first.owner, 'claimed');
 assert.deepEqual(claims, [{ origin: first.origin, matches: true }]);
 assert.deepEqual(linked, [true], 'dependency approvals run while the setup token is live');
 assert.equal(provider.state.secrets.find(item => item.name === 'OWNER_EMAIL').value, 'owner@example.test', 'the hosted owner is the local setup owner');
 assert.equal(provider.state.secrets.find(item => item.name === 'MAIL_API_KEY').value, 'from-the-env-file');
 assert.notEqual(provider.state.secrets.find(item => item.name === 'SESSION_SECRET').value, 'local-only-session', 'a hosted session secret is generated, not copied');
 assert.deepEqual(secretNames(provider), ['MAIL_API_KEY', 'OWNER_EMAIL', 'SESSION_SECRET'], 'the spent setup token is removed by rer');
 assert.ok(out.lines.some(line => line.includes('Claimed the hosted owner (owner@example.test)')));
 // A secret rotated through rer, then newer source: the update is accepted.
 process.env.SESSION_SECRET = 'rotated-session-secret';
 await run({ setSecret: 'SESSION_SECRET' });
 assert.equal(provider.state.secrets.find(item => item.name === 'SESSION_SECRET').value, 'rotated-session-secret');
 await writeFile(join(root, 'NOTES.md'), 'newer source\n'); git('add', '.'); git('commit', '-qm', 'second');
 const second = await run();
 assert.equal(second.deployed, true); assert.equal(second.owner, undefined);
 assert.equal(claims.length, 1, 'an owner is claimed once');
 assert.deepEqual(secretNames(provider), ['MAIL_API_KEY', 'OWNER_EMAIL', 'SESSION_SECRET'], 'the retired token is not uploaded again');
 // Replacement by someone else still refuses, untouched.
 provider.foreign.replaceWorker();
 const writes = provider.state.writes.length;
 await assert.rejects(run(), /owned-resource-replaced/);
 assert.equal(provider.state.writes.length, writes);
});

test('rer deploy --remove deletes only what this environment created, reads back that it is gone, and leaves the rest', async t => {
 const { root } = await checkout(t, { r2: [{ binding: 'FILES' }], kv: [{ binding: 'CACHE' }], queues: [{ binding: 'JOBS' }], secrets: [{ binding: 'SESSION_SECRET', environment: 'SESSION_SECRET' }] });
 const { provider } = account(t);
 const deploy = ownerDeploy('deploy.json', { ...lifecycle, hooks: {} });
 const run = options => deploy({ root, options: { environment: 'production', ...options }, store: store(), setupManifest: manifest });
 // A create whose answer was lost may exist: removal deletes it only once it is confirmed empty.
 provider.fail('POST', /^\/storage\/kv\/namespaces$/, { afterApply: true });
 await assert.rejects(run({}), /Possibly created: kv:fixture-production-cache/);
 provider.state.kv[0].keys = [{ name: 'not-ours' }];
 await assert.rejects(run({ remove: true, yes: true }), /uncertain-resource-not-empty/);
 assert.equal(provider.state.databases.length + provider.state.buckets.length + provider.state.kv.length, 3, 'a refused removal deletes nothing');
 provider.state.kv[0].keys = [];
 assert.deepEqual((await run({ remove: true, yes: true })).removed.sort(), ['d1:fixture-production-db', 'kv:fixture-production-cache', 'r2:fixture-production-files']);
 await run({});
 provider.foreign.d1('fixture-staging-db'); provider.foreign.queues('someone-elses-queue');
 await assert.rejects(run({ remove: true }), /Add --yes to confirm/);
 const result = await run({ remove: true, yes: true });
 assert.deepEqual(result.removed.sort(), ['d1:fixture-production-db', 'kv:fixture-production-cache', 'queues:fixture-production-jobs', 'r2:fixture-production-files', 'worker:fixture-production']);
 assert.equal(provider.state.settings, null);
 assert.deepEqual(provider.state.databases.map(row => row.name), ['fixture-staging-db']);
 assert.deepEqual(provider.state.queues.map(row => row.queue_name), ['someone-elses-queue']);
 assert.deepEqual([provider.state.buckets.length, provider.state.kv.length], [0, 0]);
 await assert.rejects(access(join(root, '.rer/deploy/production.json')), { code: 'ENOENT' });
 // A Worker someone else changed after a secret change rer started (its answer lost) is never removed.
 await run({});
 process.env.SESSION_SECRET = 'rotated';
 provider.fail('PUT', /\/secrets$/, { afterApply: true });
 await assert.rejects(run({ setSecret: 'SESSION_SECRET' }), /provider-transport-failed/);
 await provider.fetch(`https://api.cloudflare.com/client/v4/accounts/${provider.accountId}/workers/scripts/fixture-production/secrets`, { method: 'PUT', headers: { Authorization: `Bearer ${provider.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'OTHER', text: 'x', type: 'secret_text' }) });
 const databases = provider.state.databases.length;
 await assert.rejects(run({ remove: true, yes: true }), /owned-resource-replaced/);
 assert.notEqual(provider.state.settings, null); assert.equal(provider.state.databases.length, databases);
});

test('a secret change rer started is adopted after its response is lost; one the provider refused is not, and one made outside rer is refused', async t => {
 const { root } = await checkout(t, { secrets: [{ binding: 'SESSION_SECRET', environment: 'SESSION_SECRET' }] });
 const { provider } = account(t);
 const deploy = ownerDeploy('deploy.json', { ...lifecycle, hooks: {} });
 const run = options => deploy({ root, options: { environment: 'production', ...options }, store: store(), setupManifest: manifest });
 await run({});
 provider.fail('DELETE', /\/secrets\/SESSION_SECRET$/, { afterApply: true });
 await assert.rejects(run({ unsetSecret: 'SESSION_SECRET' }), /provider-transport-failed/);
 assert.deepEqual(secretNames(provider), []);
 assert.equal((await run({})).deployed, true, 'the next deploy recognises the change it started');
 assert.deepEqual(secretNames(provider), [], 'the removed secret stays retired');
 // The provider refuses rer's change; the recovery is that same change, not a plain deploy.
 process.env.SESSION_SECRET = 'rotated';
 provider.fail('PUT', /\/secrets$/);
 await assert.rejects(run({ setSecret: 'SESSION_SECRET' }), /run rer deploy --environment production --set-secret SESSION_SECRET again/);
 // The same change then made in the dashboard is not rer's.
 const origin = `https://api.cloudflare.com/client/v4/accounts/${provider.accountId}/workers/scripts/fixture-production/secrets`;
 await provider.fetch(origin, { method: 'PUT', headers: { Authorization: `Bearer ${provider.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'SESSION_SECRET', text: 'x', type: 'secret_text' }) });
 await assert.rejects(run({}), /owned-resource-replaced/);
});
