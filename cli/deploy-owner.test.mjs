import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { ownerDeploy } from './deploy.mjs';
import { main as cli } from './main.mjs';
import { deployCommand } from './deploy-command.mjs';
import { claimHostedOwner } from './deploy-owner.mjs';
import { localInstaller } from '../onboarding/adapter.mjs';
import { main as ownerKit } from '../modules/deploy-kit/owner-cli.mjs';

// rer deploy through its public adapter door, against the fake Cloudflare account
// (the only fake: the provider and the hosted app's owner step at the network edge).

import { manifest, checkout, account, lifecycle, store } from './fixtures/owner-deploy.mjs';

const secretNames = provider => provider.state.secrets.map(item => item.name).sort();

test('direct owner callers retire once, skip legacy retirement, and select live tokens after modern inspection', async t => {
 const { root } = await checkout(t, { secrets: [{ binding: 'SETUP_TOKEN', environment: 'SETUP_TOKEN' }] });
 const { provider, claims } = account(t);
 const declaration = JSON.parse(await readFile(join(root, 'deploy.json'), 'utf8'));
 const env = { ...process.env, SETUP_TOKEN: 'test-only-setup-token' };
 const command = (verb, extra = [], values = env) => ownerKit([verb, '--declaration', 'deploy.json', '--environment', 'production', ...extra], values, { cwd: root });
 const claim = (deployed, extra = {}) => claimHostedOwner({ hook: lifecycle.hooks.owner, setupManifest: manifest, declaration, deployed, env,
  secret: (args, values) => command('secret', args, values), addSecret: () => {}, ...extra });
 const unsets = () => provider.state.calls.filter(call => call.method === 'DELETE' && call.path.endsWith('/secrets/SETUP_TOKEN')).length;
 const sets = () => provider.state.calls.filter(call => call.method === 'PUT' && call.path.endsWith('/secrets')).length;
 assert.equal(await claim(await command('deploy')), 'claimed');
 assert.equal(claims.length, 1); assert.equal(unsets(), 1);
 assert.deepEqual(secretNames(provider), []);
 assert.equal(await claim(await command('deploy')), undefined);
 assert.equal(claims.length, 1); assert.equal(unsets(), 1);
 // An absent token must be replaced, even when the environment has a stale value.
 const inspected = await command('inspect');
 assert.deepEqual(inspected.liveSecrets, []);
 assert.equal(await claim(inspected, { beforeClaim: token => assert.ok(token !== env.SETUP_TOKEN, 'the retired environment token is not reused') }), 'kept');
 assert.equal(claims.length, 2); assert.equal(unsets(), 2);
 assert.deepEqual(secretNames(provider), []);
 // An explicitly supplied live token remains usable without a secret rotation.
 await command('secret', ['--set', 'SETUP_TOKEN']);
 const live = await command('inspect'), beforeExplicit = sets();
 assert.ok(live.liveSecrets.includes('SETUP_TOKEN'));
 assert.equal(await claim(live, { beforeClaim: token => assert.ok(token === env.SETUP_TOKEN, 'dependency approval uses the supplied live token') }), 'kept');
 assert.equal(sets(), beforeExplicit, 'the live person-supplied token was not rotated');
 assert.equal(claims.length, 3); assert.equal(unsets(), 3);
 // A value generated for this deploy is not the person's existing live token.
 await command('secret', ['--set', 'SETUP_TOKEN']);
 const generated = 'test-only-newly-generated-token', beforeGenerated = sets();
 assert.equal(await claim(await command('inspect'), { env: { ...env, SETUP_TOKEN: generated }, supplied: ['SETUP_TOKEN'],
  beforeClaim: token => assert.ok(token !== generated && token !== env.SETUP_TOKEN, 'a fresh token replaces the unknown live value') }), 'kept');
 assert.equal(sets(), beforeGenerated + 1);
 assert.equal(claims.length, 4); assert.equal(unsets(), 4);
 assert.ok(claims.every(claim => claim.matches), 'every bootstrap uses the live provider binding');
 assert.deepEqual(secretNames(provider), []);
});

test('rer deploy claims the setup owner on the hosted app, retires the setup token, and later updates the same Worker', async t => {
 const secrets = ['OWNER_EMAIL', 'SESSION_SECRET', 'SETUP_TOKEN', 'MAIL_API_KEY'].map(name => ({ binding: name, environment: name }));
 const { root, git } = await checkout(t, { secrets, crons: ['* * * * *'] });
 const { provider, claims } = account(t);
 // The seed's real installer lifecycle runs the build step of the deploy.
 const deploy = ownerDeploy('deploy.json', localInstaller({ owner: lifecycle.hooks.owner, secrets: { file: '.dev.vars' } })), linked = [];
 const run = (options = {}, out = store()) => deploy({ root, options: { environment: 'production', ...options }, store: out, setupManifest: manifest, linkDependencies: async (origin, token) => linked.push(Boolean(origin && token)) });
 // A missing input is named, and nothing is created.
 await assert.rejects(run(), error => /Production sign-in is not configured/.test(error.message));
 assert.equal(provider.state.writes.length, 0);
 await writeFile(join(root, 'deploy.env'), 'MAIL_API_KEY="from-the-env-file"\n', { mode: 0o600 });
 // A gateway answer after retirement must still complete the claim and save its new version.
 provider.fail('DELETE', /\/secrets\/SETUP_TOKEN$/, { afterApply: true, status: 502 });
 const out = store(), first = await run({ envFile: 'deploy.env' }, out);
 assert.equal(first.deployed, true); assert.equal(first.owner, 'claimed');
 assert.deepEqual(claims, [{ origin: first.origin, matches: true }]);
 assert.deepEqual(linked, [true], 'dependency approvals run while the setup token is live');
 assert.equal(provider.state.secrets.find(item => item.name === 'OWNER_EMAIL').value, 'owner@example.test', 'the hosted owner is the local setup owner');
 assert.equal(provider.state.secrets.find(item => item.name === 'MAIL_API_KEY').value, 'from-the-env-file');
 assert.notEqual(provider.state.secrets.find(item => item.name === 'SESSION_SECRET').value, 'local-only-session', 'a hosted session secret is generated, not copied');
 assert.deepEqual(secretNames(provider), ['MAIL_API_KEY', 'OWNER_EMAIL', 'SESSION_SECRET'], 'the spent setup token is removed by rer');
 assert.ok(out.lines.some(line => line.includes('Claimed the hosted owner (owner@example.test)')));
 // A hosted deploy talks about the person's account, never a local runtime.
 assert.equal(out.lines.some(line => /locally|this computer/.test(line)), false, out.lines.join('\n'));
 assert.ok(out.lines.findIndex(line => line.includes(first.origin)) < out.lines.findIndex(line => line.startsWith('Claimed the hosted owner')), 'the deployed origin is named once it is live, before the owner claim');
 // An untouched exact repeat writes nothing: the build is unchanged with the token retired, and the claim stays recorded.
 const statePath = join(root, '.rer/deploy/production.json'), claimedState = await readFile(statePath), claimedWrites = provider.state.writes.length;
 assert.equal((await run({ envFile: 'deploy.env' })).owner, 'kept');
 assert.equal(provider.state.writes.length, claimedWrites, 'an exact repeat makes no provider write');
 assert.deepEqual(await readFile(statePath), claimedState, 'an exact repeat leaves the owner state as it was');
 // A secret rotated through rer, then newer source: the update is accepted.
 process.env.SESSION_SECRET = 'rotated-session-secret';
 provider.fail('PUT', /\/secrets$/, { afterApply: true, status: 504 });
 await run({ setSecret: 'SESSION_SECRET' });
 assert.equal(provider.state.secrets.find(item => item.name === 'SESSION_SECRET').value, 'rotated-session-secret');
 await writeFile(join(root, 'NOTES.md'), 'newer source\n'); git('add', '.'); git('commit', '-qm', 'second');
 const second = await run();
 assert.equal(second.deployed, true); assert.equal(second.owner, 'kept');
 assert.equal(claims.length, 1, 'an owner is claimed once');
 assert.deepEqual(secretNames(provider), ['MAIL_API_KEY', 'OWNER_EMAIL', 'SESSION_SECRET'], 'the retired token is not uploaded again');
 // Replacement by someone else still refuses, untouched.
 provider.foreign.replaceWorker();
 const writes = provider.state.writes.length;
 await assert.rejects(run(), /owned-resource-replaced/);
 assert.equal(provider.state.writes.length, writes);
 for (const scenario of ['read-outage','lag','active-lag','lost-response','applied-524']) await t.test(`unconfirmed setup-token retirement ${scenario}`, async t => {
  const { root } = await checkout(t, { secrets: secrets.filter(item => item.binding !== 'MAIL_API_KEY') });
  const { provider, claims } = account(t);
  const run = (options = {}) => ownerDeploy('deploy.json', lifecycle)({ root, options: { environment: 'production', ...options }, store: store(), setupManifest: manifest });
  let unconfirmed = false, elapsed = 0, startingVersion, deployments;
  const clock = performance.now.bind(performance), inner = globalThis.fetch;
  // Advance the clock past the readback window while the provider cannot confirm it.
  t.mock.method(performance, 'now', () => unconfirmed ? (elapsed += 60000) : clock());
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
   const url = new URL(input), method = init.method ?? 'GET';
   if (unconfirmed && scenario === 'active-lag' && method === 'GET' && url.pathname.endsWith('/deployments')) return Response.json({ success: true, result: { deployments } });
   if (unconfirmed && method === 'GET' && url.pathname.endsWith('/versions')) {
    if (scenario === 'lag') return Response.json({ success: true, result: { items: [{ id: startingVersion }] } });
    return Response.json({ success: false, errors: [{ code: 10013, message: 'test-only read outage' }] }, { status: 503 });
   }
   if (method === 'DELETE' && url.pathname.endsWith('/secrets/SETUP_TOKEN')) {
    startingVersion = provider.state.version.id;
    deployments = structuredClone(provider.state.deployments);
    try { return await inner(input, init); }
    finally { unconfirmed = true; }
   }
   return inner(input, init);
  });
  if (scenario === 'lost-response' || scenario === 'applied-524') provider.fail('DELETE', /\/secrets\/SETUP_TOKEN$/, { afterApply: true, ...(scenario === 'applied-524' ? { status: 524 } : {}) });
  await assert.rejects(run(), error => /setup token retirement failed/.test(error.message) && /--unset-secret SETUP_TOKEN/.test(error.message));
  unconfirmed = false;
  const statePath = join(root, '.rer/deploy/production.json'), saved = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(saved.pendingSecret.versionId, startingVersion);
  assert.ok(!secretNames(provider).includes('SETUP_TOKEN'));
  await run({ unsetSecret: 'SETUP_TOKEN' });
  assert.equal((await run()).owner, 'kept');
  assert.equal(claims.length, 1, 'recovery keeps the owner already claimed');
  assert.ok(!secretNames(provider).includes('SETUP_TOKEN'));
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).pendingSecret, undefined);
 });
});

test('rer deploy recovers an unclaimed hosted owner after manual setup-token retirement', async t => {
 const secrets = ['OWNER_EMAIL', 'SESSION_SECRET', 'SETUP_TOKEN'].map(name => ({ binding: name, environment: name }));
 const { root } = await checkout(t, { secrets });
 const { provider, claims, deny } = account(t);
 const deploy = ownerDeploy('deploy.json', localInstaller({ owner: lifecycle.hooks.owner, secrets: { file: '.dev.vars' } }));
 const run = (options = {}) => deploy({ root, options: { environment: 'production', ...options }, store: store(), setupManifest: manifest });
 const currentOwner = () => {
  const binding = provider.state.settings.bindings.find(item => item.name === 'DB');
  return provider.state.databases.find(row => row.uuid === binding.id).db.prepare('SELECT id FROM owner').get()?.id;
 };
 deny(true);
 await assert.rejects(run(), /owner_claim_denied/);
 assert.equal(claims.length, 1);
 assert.equal(currentOwner(), undefined);
 assert.ok(secretNames(provider).includes('SETUP_TOKEN'));
 await run({ unsetSecret: 'SETUP_TOKEN' });
 assert.ok(!secretNames(provider).includes('SETUP_TOKEN'));
 assert.equal(currentOwner(), undefined, 'manual token retirement does not claim the hosted database');
 deny(false);
 const recovered = await run();
 assert.equal(currentOwner(), 'owner@example.test', 'successful standard redeploy must claim the current database');
 assert.equal(recovered.owner, 'claimed');
 assert.equal(claims.length, 2);
 assert.ok(claims.every(claim => claim.matches), 'both bootstrap attempts use the live setup token');
 assert.ok(!secretNames(provider).includes('SETUP_TOKEN'), 'recovery retires its new setup token');
});

test('rer deploy --remove deletes only what this environment created, reads back that it is gone, and leaves the rest', async t => {
 const { root } = await checkout(t, { r2: [{ binding: 'FILES' }], kv: [{ binding: 'CACHE' }], queues: [{ binding: 'JOBS' }], secrets: ['SESSION_SECRET', 'SETUP_TOKEN'].map(name => ({ binding: name, environment: name })) });
 const { provider, claims } = account(t);
 const deploy = ownerDeploy('deploy.json', lifecycle);
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
 const statePath = join(root, '.rer/deploy/production.json');
 const before = JSON.parse(await readFile(statePath, 'utf8'));
 for (let attempt = 0; attempt < 3; attempt++) provider.fail('DELETE', /^\/workers\/scripts\/fixture-production$/);
 await assert.rejects(run({ remove: true, yes: true }), /provider-http-500/);
 assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')), before, 'a Worker that remains keeps its resources and ownership proof');
 const oldDatabase = provider.state.databases[0].uuid, cache = provider.state.kv[0].id;
 for (let attempt = 0; attempt < 3; attempt++) provider.fail('DELETE', /^\/storage\/kv\/namespaces\//);
 await assert.rejects(run({ remove: true, yes: true }), /1 resources remain \(kv:fixture-production-cache\)/);
 assert.equal(provider.state.settings, null); assert.equal(provider.state.databases.length, 0);
 const partial = JSON.parse(await readFile(statePath, 'utf8'));
 assert.equal(partial.receipt, null); assert.equal(partial.owned.worker, null);
 assert.equal(partial.ownerClaim, undefined); assert.equal(partial.retiredSecrets, undefined);
 assert.deepEqual(partial.owned.kv, before.owned.kv, 'the surviving KV remains owned for reuse or removal');
 assert.deepEqual(partial.owned.d1, {});
 const bootstraps = claims.length;
 assert.equal((await run({})).owner, 'claimed');
 assert.equal(claims.length, bootstraps + 1, 'the new database needs its own bootstrap');
 assert.notEqual(provider.state.databases[0].uuid, oldDatabase);
 assert.equal(provider.state.databases[0].db.prepare('SELECT id FROM owner').get().id, 'owner@example.test');
 assert.equal(provider.state.kv[0].id, cache);
 assert.ok(!secretNames(provider).includes('SETUP_TOKEN'));
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
 await run({ setSecret: 'SESSION_SECRET' });
 await provider.fetch(`https://api.cloudflare.com/client/v4/accounts/${provider.accountId}/workers/scripts/fixture-production/secrets`, { method: 'PUT', headers: { Authorization: `Bearer ${provider.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'OTHER', text: 'x', type: 'secret_text' }) });
 const databases = provider.state.databases.length;
 await assert.rejects(run({ remove: true, yes: true }), /owned-resource-replaced/);
 assert.notEqual(provider.state.settings, null); assert.equal(provider.state.databases.length, databases);
});

test('an optional secret deploys unset and is set and removed later; a secret change settles after its response is lost; one the provider refused is not adopted, and one made outside rer is refused', async t => {
 const { root } = await checkout(t, { secrets: [{ binding: 'SESSION_SECRET', environment: 'SESSION_SECRET' }, { binding: 'PIER_SESSION', environment: 'PIER_SESSION', optional: true }] });
 const { provider } = account(t);
 const deploy = ownerDeploy('deploy.json', { ...lifecycle, hooks: {} });
 const run = (options, out = store(), setupManifest = manifest) => deploy({ root, options: { environment: 'production', ...options }, store: out, setupManifest });
 // A missing required secret still refuses before any provider write.
 await assert.rejects(run({}, store(), {}), /Deploy needs SESSION_SECRET/);
 assert.equal(provider.state.writes.length, 0);
 // A missing optional one does not block the first deploy: it is named as not set and left unbound.
 const out = store();
 assert.equal((await run({}, out)).deployed, true);
 assert.deepEqual(secretNames(provider), ['SESSION_SECRET']);
 assert.equal(provider.state.settings.bindings.some(item => item.name === 'PIER_SESSION'), false);
 assert.ok(out.lines.some(line => line.includes('Optional secrets not set: PIER_SESSION')), out.lines.join('\n'));
 // Set later through rer: the next deploy accepts its own Worker, and an unchanged repeat writes nothing.
 process.env.PIER_SESSION = 'test-only-pier-session';
 await run({ setSecret: 'PIER_SESSION' });
 assert.equal(provider.state.secrets.find(item => item.name === 'PIER_SESSION').value, 'test-only-pier-session');
 let writes = provider.state.writes.length;
 assert.equal((await run({})).deployed, true, 'the Worker the set made is not refused as replaced');
 assert.equal(provider.state.writes.length, writes, 'an unchanged repeat makes no provider write');
 // Removed through rer: the next deploy leaves it unset, again without a write.
 await run({ unsetSecret: 'PIER_SESSION' });
 writes = provider.state.writes.length;
 assert.equal((await run({})).deployed, true);
 assert.equal(provider.state.writes.length, writes);
 assert.deepEqual(secretNames(provider), ['SESSION_SECRET']);
 delete process.env.PIER_SESSION;
 provider.fail('DELETE', /\/secrets\/SESSION_SECRET$/, { afterApply: true });
 await run({ unsetSecret: 'SESSION_SECRET' });
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

test('rer deploy runs a migration again after D1 rolled its import back, and refuses one whose effects are partly present', async t => {
 const { root, git } = await checkout(t, { secrets: [{ binding: 'SESSION_SECRET', environment: 'SESSION_SECRET' }] });
 await writeFile(join(root, 'migrations/core/0002_notes.sql'), "CREATE TABLE IF NOT EXISTS notes(id TEXT PRIMARY KEY, body TEXT);\nCREATE INDEX notes_body ON notes(body);\nINSERT INTO notes SELECT id, 'imported' FROM lookup;\n");
 git('add', '.'); git('commit', '-qm', 'notes');
 const { provider } = account(t);
 const run = () => ownerDeploy('deploy.json', { ...lifecycle, hooks: {} })({ root, options: { environment: 'production' }, store: store(), setupManifest: manifest });
 const db = () => provider.state.databases[0].db;
 const ledger = () => db().prepare('SELECT name, state FROM d1_migrations ORDER BY id').all().map(row => `${row.name} ${row.state}`);
 await assert.rejects(run(), error => {
  assert.match(error.message, /d1-import-failed/); assert.match(error.message, /no such table: lookup/);
  assert.match(error.message, /Migration 0002_notes\.sql did not apply/); assert.ok(!error.message.includes(provider.token));
  return true;
 });
 assert.deepEqual(ledger(), ['0001_owner.sql applied', '0002_notes.sql applying']);
 // Part of it present (made by hand here): refused before any write, naming the migration and the step.
 db().exec('CREATE TABLE notes(id TEXT PRIMARY KEY, body TEXT); CREATE INDEX notes_body ON notes(body);');
 const writes = provider.state.writes.length;
 await assert.rejects(run(), error => {
  assert.match(error.message, /Migration 0002_notes\.sql in D1 \S+ was started but never confirmed/);
  assert.match(error.message, /Some of its changes are present \(index notes_body\)\. Undo them/);
  return true;
 });
 assert.equal(provider.state.writes.length, writes);
 // Undone and its cause fixed, the same unchanged deploy runs it and records it applied.
 db().exec("DROP TABLE notes; CREATE TABLE lookup(id TEXT); INSERT INTO lookup VALUES ('first')");
 assert.equal((await run()).deployed, true);
 assert.deepEqual(ledger(), ['0001_owner.sql applied', '0002_notes.sql applied']);
 assert.deepEqual({ ...db().prepare('SELECT id, body FROM notes').get() }, { id: 'first', body: 'imported' });
});

// A failed hosted response exhausts virtual readiness time; normal timers are untouched.
function virtualReadiness(t) {
 let elapsed = 0;
 t.mock.method(performance, 'now', () => elapsed);
 return () => { elapsed += 90000; };
}

test('post-retirement 503 fails deploy while preserving owner, retired token and new version', async t => {
 const { root } = await checkout(t, { secrets: ['SESSION_SECRET', 'SETUP_TOKEN'].map(name => ({ binding: name, environment: name })) });
 const { provider, claims } = account(t);
 const exhaust = virtualReadiness(t);
 let retiredVersion;
 provider.state.healthOverride = () => {
  if (!secretNames(provider).includes('SETUP_TOKEN')) {
   exhaust(); retiredVersion = provider.state.version.id;
   return new Response(`SETUP_TOKEN required ${process.env.CLOUDFLARE_API_TOKEN}\nsecond diagnostic must not print`, { status: 503 });
  }
  const vars = Object.fromEntries(provider.state.settings.bindings.map(item => [item.name, item.text]));
  return Response.json({ ok: true, deployment: { sourceSha: vars.RER_DEPLOY_SOURCE, fingerprint: vars.RER_DEPLOY_FINGERPRINT, versionId: provider.state.version.id } });
 };
 const out = store();
 await assert.rejects(ownerDeploy('deploy.json', lifecycle)({ root, options: {}, store: out, setupManifest: manifest }), error => {
  assert.match(error.message, /owner claimed/i); assert.match(error.message, /token retirement/i);
  assert.match(error.message, /HTTP 503/); assert.match(error.message, /SETUP_TOKEN required/);
  assert.match(error.message, /configuration.*redeploy/i);
  assert.doesNotMatch(error.message, /--set-secret SETUP_TOKEN|second diagnostic/);
  assert.ok(!error.message.includes(provider.token));
  return true;
 });
 assert.equal(claims.length, 1);
 assert.equal(provider.state.databases[0].db.prepare('SELECT id FROM owner').get().id, 'owner@example.test');
 const state = JSON.parse(await readFile(join(root, '.rer/deploy/production.json'), 'utf8'));
 assert.equal(state.ownerClaim.outcome, 'claimed'); assert.ok(state.retiredSecrets.includes('SETUP_TOKEN'));
 assert.equal(state.receipt.provider.versionId, retiredVersion);
 assert.equal(state.receipt.health.ok, false);
 assert.ok(!JSON.stringify(state).includes(provider.token));
 assert.ok(!secretNames(provider).includes('SETUP_TOKEN'));
 assert.ok(!out.lines.some(line => line.includes('Sign in by email')));
});

test('a redeploy whose app echoes a secret in its unhealthy answer keeps no secret value in the owner state', async t => {
 const { root, git } = await checkout(t, { secrets: [{ binding: 'SESSION_SECRET', environment: 'SESSION_SECRET' }] });
 const { provider } = account(t);
 const run = () => ownerDeploy('deploy.json', { ...lifecycle, hooks: {} })({ root, options: {}, store: store(), setupManifest: manifest });
 process.env.SESSION_SECRET = 'deployed-session-secret-value';
 await run();
 await writeFile(join(root, 'dist/server/index.js'), 'export default {scheduled(){},fetch(){return 1}}');
 git('commit', '--allow-empty', '-qm', 'second');
 const exhaust = virtualReadiness(t);
 provider.state.healthOverride = () => { exhaust(); return new Response(`bad SESSION ${provider.state.secrets.find(item => item.name === 'SESSION_SECRET').value} here`, { status: 503 }); };
 await assert.rejects(run(), error => /health/.test(error.message) && !error.message.includes('deployed-session-secret-value'));
 const state = await readFile(join(root, '.rer/deploy/production.json'), 'utf8');
 assert.equal(JSON.parse(state).receipt.health.attempts.at(-1).status, 503);
 assert.ok(!state.includes('deployed-session-secret-value'));
});

for (const options of [{ setSecret: 'SESSION_SECRET' }, { unsetSecret: 'SESSION_SECRET' }]) test(`explicit secret ${options.setSecret ? 'set' : 'unset'} fails after applied unhealthy version without requiring source or build`, async t => {
 const { root } = await checkout(t, { secrets: [{ binding: 'SESSION_SECRET', environment: 'SESSION_SECRET' }] });
 const { provider } = account(t);
 const deploy = ownerDeploy('deploy.json', { ...lifecycle, hooks: {} });
 const run = options => deploy({ root, options, store: store(), setupManifest: manifest });
 await run({});
 await rm(join(root, 'dist'), { recursive: true });
 await writeFile(join(root, '.gitignore'), 'dirty source');
 const exhaust = virtualReadiness(t);
 // The 256-byte diagnostic prefix ends inside é, after a long known-secret prefix.
 process.env.SESSION_SECRET = 'secret-that-must-be-redacted'.padEnd(237, 'q') + 'é-private-tail'.repeat(20);
 provider.state.healthOverride = () => { exhaust(); return new Response(`bad configuration ${process.env.SESSION_SECRET} ${'x'.repeat(300)}beyond-bound\nprivate second line`, { status: 503 }); };

 const previous = provider.state.version.id;
 await assert.rejects(run(options), error => {
  assert.match(error.message, /secret change.*applied/i);
  assert.match(error.message, /HTTP 503/); assert.match(error.message, /bad configuration/);
  assert.doesNotMatch(error.message, /secret-that-must-be-redacted|private second line|beyond-bound|not-committed|build/);
  return true;
 });
 const state = JSON.parse(await readFile(join(root, '.rer/deploy/production.json'), 'utf8'));
 assert.notEqual(provider.state.version.id, previous);
 assert.equal(state.receipt.provider.versionId, provider.state.version.id);
 assert.equal(secretNames(provider).includes('SESSION_SECRET'), Boolean(options.setSecret));
 assert.equal(state.pendingSecret, undefined);
 assert.equal(state.receipt.health.ok, false);
 assert.ok(!JSON.stringify(state).includes('secret-that-must-be-redacted'));
});

test('fresh deploy propagation reaches the owner once through object and observed function hooks', async t => {
 for (const kind of ['object', 'function', 'custom-observed', 'custom-source-version', 'upload-and-secret-lag', 'persistent', 'denied', 'redirect', 'cross-origin', 'existing-wrong', 'unproven-function']) await t.test(kind, async t => {
  const { root } = await checkout(t, { secrets: [{ binding: 'SETUP_TOKEN', environment: 'SETUP_TOKEN' }] });
  const { provider, claims } = account(t);
  const inner = globalThis.fetch;
  let attempts = 0, hookCalls = 0, elapsed = 0, uploaded = false, staleWorker = 0, staleSecrets = 0;
  const sourceFailure = kind === 'custom-source-version', statePath = join(root, '.rer/deploy/production.json');
  // Recovery uses the same caller-supplied token that this hook uploaded.
  if (sourceFailure) process.env.SETUP_TOKEN = 'test-only-recovery-token';
  let failReadback = sourceFailure, sourceReadback = false, sourceRequests = 0, sourceState, sourceWrites;
  const clock = performance.now.bind(performance);
  t.mock.method(performance, 'now', () => clock() + elapsed);
  const hook = ['function', 'unproven-function'].includes(kind) ? async context => {
   hookCalls++;
   const response = await fetch(new URL('/auth/bootstrap', context.origin), { method: 'POST', headers: { Origin: context.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: context.vars.SETUP_TOKEN }) });
   assert.equal(response.status, 303);
  } : lifecycle.hooks.owner;
  const run = () => kind.startsWith('custom-') ? deployCommand({root,options:{},store:store(),setupManifest:manifest,
   adapter:{...lifecycle,deployDeclaration:'deploy.json',deploy:async () => {
    sourceReadback = false;
    const deployed = await ownerKit(['deploy','--declaration','deploy.json','--environment','production'],process.env,{cwd:root});
    if (!deployed.ownerClaim) {
     hookCalls++;
     const response = await fetch(new URL('/auth/bootstrap',deployed.origin),{method:'POST',headers:{Origin:deployed.origin},body:JSON.stringify({token:process.env.SETUP_TOKEN})});
     assert.equal(response.status, sourceFailure && !failReadback ? 409 : 303);
    }
    if (failReadback) {
     sourceState = await readFile(statePath); sourceWrites = provider.state.writes.length;
     sourceReadback = true;
    }
    return {origin:deployed.origin,deployed:true};
   }}}) : ownerDeploy('deploy.json', { ...lifecycle, hooks: { owner: hook } })({ root, options: {}, store: store(), setupManifest: manifest });
  if (['existing-wrong', 'unproven-function'].includes(kind)) {
   await ownerKit(['deploy', '--declaration', 'deploy.json', '--environment', 'production'], { ...process.env, SETUP_TOKEN: 'previous-test-token' }, { cwd: root });
   process.env.SETUP_TOKEN = kind === 'existing-wrong' ? 'wrong-test-token' : 'previous-test-token';
  }
  const writes = provider.state.writes.length;
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
   const url = new URL(input);
   if (sourceReadback && url.pathname === '/health') {
    sourceRequests++;
    if (kind === 'custom-source-version') {
     const body = await (await inner(input, init)).json();
     body.deployment.versionId = 'previous-version-of-the-same-commit'; elapsed += 120000;
     return Response.json(body);
    }
   }
   if (kind === 'upload-and-secret-lag') {
    if (init.method === 'PUT' && url.searchParams.get('bindings_inherit') === 'strict') { const result = await inner(input, init); uploaded = true; const body = await result.json(); body.result.deployment_id = body.result.deployment_id.replaceAll('-', '').toUpperCase(); return Response.json(body); }
    if (uploaded && url.pathname.endsWith('/settings') && staleWorker++ === 0) return Response.json({success:false,errors:[]}, {status:404});
    if (uploaded && url.pathname.endsWith('/secrets') && (!init.method || init.method === 'GET') && staleSecrets++ === 0) return Response.json({success:true,result:[]});
   }
   if (url.pathname === '/auth/bootstrap') {
    if (kind === 'upload-and-secret-lag') { assert.ok(staleWorker > 1); assert.ok(staleSecrets > 1); }
    attempts++;
    if (kind === 'persistent') elapsed += 45000;
    if (kind === 'denied') return Response.json({ error: 'owner_claim_denied' }, { status: 403 });
    if (kind === 'cross-origin') return new Response(null, { status: 303, headers: { Location: 'https://elsewhere.invalid/auth/bootstrap' } });
    if (kind === 'redirect') return new Response(null, { status: 307, headers: { Location: 'https://elsewhere.invalid/auth/bootstrap' } });
    if (['object','function','custom-observed'].includes(kind) && attempts === 1) return new Response('error code: 1042', { status: 404 });
    if (!sourceFailure && attempts === 1 || ['persistent','existing-wrong'].includes(kind)) return Response.json({ error: 'invalid_setup_token' }, { status: 403 });
   }
   return inner(input, init);
  });
  if (sourceFailure) {
   const failure = await run().then(() => assert.fail('a stale Worker version must fail within the finalization wait'), error => error);
   assert.equal(sourceRequests, 1, 'no source request starts after the finalization deadline');
   assert.match(failure.message, /90-second finalization wait/);
   assert.equal(hookCalls, 1); assert.equal(claims.length, 1, 'source readback never repeats hook effects');
   assert.deepEqual(await readFile(statePath), sourceState, 'failed source readback preserves the owner record');
   assert.equal(provider.state.writes.length, sourceWrites, 'failed source readback never retires or rotates a secret');
   assert.equal(provider.state.databases[0].db.prepare('SELECT id FROM owner').get().id, 'owner@example.test');
   assert.ok(secretNames(provider).includes('SETUP_TOKEN'));
   failReadback = false;
   assert.equal((await run()).owner, 'kept', 'the same-input recovery keeps the owner already claimed by the hook');
   assert.equal(claims.length, 2); assert.ok(!secretNames(provider).includes('SETUP_TOKEN'));
  } else if (['persistent', 'denied', 'redirect', 'cross-origin', 'existing-wrong', 'unproven-function'].includes(kind)) {
   await assert.rejects(run(), /claiming its owner failed/);
   assert.equal(attempts, kind === 'persistent' ? 2 : 1);
   assert.equal(claims.length, 0);
   assert.ok(secretNames(provider).includes('SETUP_TOKEN'));
   const state = JSON.parse(await readFile(join(root, '.rer/deploy/production.json'), 'utf8'));
   assert.equal(state.ownerClaim, undefined);
   if (kind === 'existing-wrong') assert.equal(provider.state.writes.length, writes, 'a supplied wrong token is never rotated');
  } else {
   assert.equal((await run()).owner, 'claimed');
   assert.equal(attempts, 2); assert.equal(claims.length, 1);
   if (['function','custom-observed'].includes(kind)) assert.equal(hookCalls, 1, 'retry the exchange, never arbitrary hook effects');
   const statePath = join(root, '.rer/deploy/production.json'), state = await readFile(statePath), writes = provider.state.writes.length;
   assert.equal(JSON.parse(state).receipt.provider.versionId, provider.state.version.id);
   assert.ok(!secretNames(provider).includes('SETUP_TOKEN'));
   assert.equal((await run()).owner, 'kept');
   assert.equal(provider.state.writes.length, writes); assert.deepEqual(await readFile(statePath), state);
  }
 });
});


test('first deploy survives transient asset upload and serving failures, and names a persistent asset failure', async t => {
 for (const mode of ['upload-502', 'upload-reset', 'upload-body-reset', 'serve-502', 'serve-reset', 'persistent-upload', 'persistent-serve']) await t.test(mode, async t => {
  const { root, git } = await checkout(t, {});
  await writeFile(join(root, 'adapter.mjs'), `import {ownerDeploy} from ${JSON.stringify(new URL('./deploy.mjs', import.meta.url).href)};
const lifecycle = {run:async()=>{},settings:{},hooks:{}};
export const commandAdapter = {...lifecycle,deploy:ownerDeploy('deploy.json',lifecycle)};`);
  await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify({version:2,project:'tests/fixture',runtime:{requirements:[]},requiredEnvironment:[],seedContract:{version:1,profile:'first-party',adapter:'adapter.mjs'},commands:{deploy:{argv:['node','adapter.mjs'],inputs:['adapter.mjs','deploy.json'],effects:'Deploy to the fake provider.'}}}));
  await writeFile(join(root, '.node-version'), process.versions.node + '\n');
  await writeFile(join(root, 'package.json'), JSON.stringify({engines:{node:process.versions.node},packageManager:'pnpm@10.12.4'}));
  git('add', '.'); git('commit', '-qm', 'deploy door');
  await mkdir(join(root, 'dist/client/assets'));
  await writeFile(join(root, 'dist/client/assets/app.js'), 'console.log("ready");');
  const { provider } = account(t), inner = globalThis.fetch;
  const previousCI = process.env.CI; process.env.CI = 'true';
  t.after(() => { if (previousCI === undefined) delete process.env.CI; else process.env.CI = previousCI; });
  let attempts = 0;
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
   const url = new URL(input);
   const upload = url.pathname.endsWith('/workers/assets/upload');
   const served = url.hostname.endsWith('.workers.dev') && url.pathname === '/assets/app.js';
   if ((mode.includes('upload') && upload) || (mode.includes('serve') && served)) {
    attempts++;
    if (mode.startsWith('persistent') || attempts === 1) {
     if (mode === 'upload-body-reset') return new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('terminated', { cause: Object.assign(new Error('test-only reset'), { code: 'ECONNRESET' }) })); } }), {status:200});
     if (mode.endsWith('reset')) throw new TypeError('fetch failed', { cause: Object.assign(new Error('test-only reset'), { code: 'ECONNRESET' }) });
     return new Response('test-only gateway failure', {status:502});
    }
   }
   return inner(input, init);
  });
  const output = [];
  const capture = t.mock.method(process.stdout, 'write', chunk => { output.push(String(chunk)); return true; });
  const result = await cli(['deploy', '--cwd', root, '--json']);
  capture.mock.restore();
  if (mode.startsWith('persistent')) {
   assert.equal(result, 1);
   const message = output.flatMap(text => text.trim().split('\n')).map(text => JSON.parse(text)).find(event => event.event === 'error').message;
   assert.match(message, /assets\/app\.js/);
   assert.match(message, /HTTP 502/);
  } else assert.equal(result, 0, output.join(''));
  assert.equal(attempts, 2, 'one transient replay, within the original bound');
  if (!mode.startsWith('persistent')) assert.ok(provider.state.settings);
 });
});

test('rer deploy sets a group of secrets in one command as one Worker version, removes them together, and refuses a missing value before any write', async t => {
 const { root, git } = await checkout(t, { secrets: ['SESSION_SECRET', 'PIER_SESSION', 'PIER_TOKEN'].map(name => ({ binding: name, environment: name, ...(name === 'SESSION_SECRET' ? {} : { optional: true }) })) });
 await writeFile(join(root, 'adapter.mjs'), `import {ownerDeploy} from ${JSON.stringify(new URL('./deploy.mjs', import.meta.url).href)};
const lifecycle = {run:async()=>{},settings:{},hooks:{}};
export const commandAdapter = {...lifecycle,deploy:ownerDeploy('deploy.json',lifecycle)};`);
 await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify({version:2,project:'tests/fixture',runtime:{requirements:[]},requiredEnvironment:[],seedContract:{version:1,profile:'first-party',adapter:'adapter.mjs'},commands:{deploy:{argv:['node','adapter.mjs'],inputs:['adapter.mjs','deploy.json'],effects:'Deploy to the fake provider.'}}}));
 await writeFile(join(root, '.node-version'), process.versions.node + '\n');
 await writeFile(join(root, 'package.json'), JSON.stringify({engines:{node:process.versions.node},packageManager:'pnpm@10.12.4'}));
 git('add', '.'); git('commit', '-qm', 'deploy door');
 const { provider } = account(t);
 const previous = { CI: process.env.CI, PIER_TOKEN: process.env.PIER_TOKEN }; process.env.CI = 'true';
 t.after(() => { for (const [name, value] of Object.entries(previous)) if (value === undefined) delete process.env[name]; else process.env[name] = value; });
 const rer = async (...args) => {
  const output = [];
  const capture = t.mock.method(process.stdout, 'write', chunk => { output.push(String(chunk)); return true; });
  const code = await cli(['deploy', ...args, '--cwd', root, '--json']).finally(() => capture.mock.restore());
  const events = output.flatMap(text => text.trim().split('\n')).filter(Boolean).map(text => JSON.parse(text));
  return { code, events, error: events.find(event => event.event === 'error')?.message ?? '' };
 };
 const secretValue = name => provider.state.secrets.find(item => item.name === name)?.value;
 const versions = () => provider.state.versions.length, writes = () => provider.state.writes.length;
 process.env.SESSION_SECRET = 'test-only-session';
 const first = await rer();
 assert.equal(first.code, 0, first.error);
 assert.deepEqual(secretNames(provider), ['SESSION_SECRET']);
 // Repeated flags: both secrets in ONE new version, through one upload and its deployment.
 Object.assign(process.env, { PIER_TOKEN: 'test-only-pier-token', PIER_SESSION: 'test-only-pier' });
 let before = { versions: versions(), writes: writes() };
 const set = await rer('--set-secret', 'PIER_TOKEN', '--set-secret', 'PIER_SESSION');
 assert.equal(set.code, 0, set.error);
 assert.equal(versions(), before.versions + 1, 'one Worker version holds both secrets');
 assert.deepEqual(provider.state.writes.slice(before.writes).map(write => `${write.method} ${write.path}`), ['POST /workers/scripts/fixture-production/versions', 'POST /workers/scripts/fixture-production/deployments']);
 assert.deepEqual(secretNames(provider), ['PIER_SESSION', 'PIER_TOKEN', 'SESSION_SECRET']);
 assert.deepEqual([secretValue('PIER_TOKEN'), secretValue('PIER_SESSION'), secretValue('SESSION_SECRET')], ['test-only-pier-token', 'test-only-pier', 'test-only-session']);
 assert.ok(provider.state.settings.bindings.some(item => item.name === 'DB' && item.type === 'd1'), 'every other binding is inherited');
 // The next deploy recognises the Worker the change made and writes nothing.
 before = { versions: versions(), writes: writes() };
 assert.equal((await rer()).code, 0);
 assert.deepEqual({ versions: versions(), writes: writes() }, before, 'an unchanged repeat makes no provider write');
 // A comma list removes the group together, again as one version.
 const unset = await rer('--unset-secret', 'PIER_TOKEN,PIER_SESSION');
 assert.equal(unset.code, 0, unset.error);
 assert.equal(versions(), before.versions + 1);
 assert.deepEqual(secretNames(provider), ['SESSION_SECRET']);
 // A missing value refuses before any provider write, naming every missing one.
 delete process.env.PIER_TOKEN; delete process.env.PIER_SESSION;
 before = { versions: versions(), writes: writes() };
 const refused = await rer('--set-secret', 'PIER_TOKEN,SESSION_SECRET,PIER_SESSION');
 assert.equal(refused.code, 3);
 assert.match(refused.error, /needs a value for each secret; PIER_TOKEN, PIER_SESSION are not set\./);
 assert.deepEqual({ versions: versions(), writes: writes() }, before, 'nothing is written');
 assert.deepEqual(secretNames(provider), ['SESSION_SECRET']);
});
