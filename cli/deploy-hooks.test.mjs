import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { runCommand } from './lifecycle.mjs';
import { ownerProvider } from '../modules/deploy-kit/tests/owner-provider.mjs';
import { main as ownerKit } from '../modules/deploy-kit/owner-cli.mjs';
import { cloudflare } from '../modules/deploy-kit/provider.mjs';
import { ownerTarget, ownerPlan, ownerDeploy } from '../modules/deploy-kit/owner.mjs';
import { packageBuild } from '../modules/deploy-kit/prepare.mjs';
import { owner } from '../onboarding/adapter-auth.mjs';

// Public lifecycle command, real owner kit and legacy custom adapters; only the
// provider and hosted HTTP edge are faked. No seed source is modified.
async function fixture(t, { declared = false, selfClaim = false, existing = false, idp = false } = {}) {
 const root = await realpath(await mkdtemp(join(tmpdir(), 'rer-hook-deploy-')));
 const saved = { ...process.env };
 t.after(async () => { for (const key of Object.keys(process.env)) if (!Object.hasOwn(saved, key)) delete process.env[key]; Object.assign(process.env, saved); await rm(root, { recursive: true, force: true }); });
 process.env.CI = 'true';
 for (const key of ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'SETUP_TOKEN', 'SESSION_SECRET', 'OWNER_EMAIL', 'MAIL_API_KEY']) delete process.env[key];
 const provider = ownerProvider(), requests = [], claims = [], progress = [];
 t.after(() => provider.close());
 let claimed = existing, denied = false, builds = 0, failBuild = false;
 t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
  const url = new URL(input); requests.push(`${init.method ?? 'GET'} ${url.pathname}`);
  if (url.pathname === '/auth/bootstrap') {
   const body = JSON.parse(init.body);
   assert.equal(body.token, provider.state.secrets.find(item => item.name === 'SETUP_TOKEN')?.value);
   claims.push(body.token);
   if (denied) return Response.json({ error: 'owner_claim_denied' }, { status: 403 });
   if (claimed) return Response.json({ error: 'already_initialized' }, { status: 409 });
   claimed = true; return new Response(null, { status: 303, headers: { 'set-cookie': 'session=test; HttpOnly' } });
  }
  if (url.pathname === '/setup') return new Response(null, { status: 303, headers: { location: '/app' } });
  return provider.fetch(input, init);
 });
 for (const directory of ['dist/server', 'dist/client', 'migrations/core']) await mkdir(join(root, directory), { recursive: true });
 await writeFile(join(root, 'dist/server/wrangler.json'), JSON.stringify({ main: 'index.js', no_bundle: true, rules: [{ type: 'ESModule', globs: ['**/*.js', '**/*.mjs'] }] }));
 await writeFile(join(root, 'dist/server/index.js'), 'export default { fetch(){return new Response("ok")} }');
 await writeFile(join(root, 'dist/client/index.html'), 'Application');
 await writeFile(join(root, 'package.json'), JSON.stringify({ packageManager: 'pnpm@10.12.4' }));
 const declarationPath = declared ? 'owner-deployment.json' : 'deploy.json';
 const declaration = { version: 1, project: 'tests/fixture', compatibilityDate: '2026-09-08', secrets: ['OWNER_EMAIL', 'SETUP_TOKEN', 'SESSION_SECRET', 'MAIL_API_KEY'].map(name => ({ binding: name, environment: name })) };
 await writeFile(join(root, declarationPath), JSON.stringify(declaration));
 await writeFile(join(root, '.gitignore'), 'dist/\n.rer/\n.seed/\nowner.env\n');
 await writeFile(join(root, 'owner.env'), `CLOUDFLARE_ACCOUNT_ID=${provider.accountId}\nCLOUDFLARE_API_TOKEN=${provider.token}\nOWNER_EMAIL=owner@example.test\nMAIL_API_KEY=synthetic-mail-value\n`, { mode: 0o600 });
 const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', ...args], { cwd: root, stdio: 'pipe' }).toString().trim();
 git('init', '-q'); git('add', '.'); git('commit', '-qm', 'fixture');
 const adapter = { settings: [], state: undefined, run: async () => {}, hooks: { owner: declared ? {} : async context => {
  const response = await fetch(new URL('/auth/bootstrap', context.origin), { method: 'POST', headers: { Origin: context.origin }, body: JSON.stringify({ token: context.vars.SETUP_TOKEN }) });
  if (response.status === 409 && (await response.json()).error === 'already_initialized') return;
  if (response.status !== 303) throw context.fail('setup');
  const next = await fetch(new URL('/setup', context.origin), { headers: { cookie: response.headers.get('set-cookie') } });
  assert.equal(next.status, 303);
 } } };
 adapter.deploy = async ({ options, store, signal }) => {
  // Both preflight and build use the real process environment, as old hooks do.
  assert.equal(process.env.MAIL_API_KEY, 'synthetic-mail-value');
  assert.equal(process.env.CLOUDFLARE_API_TOKEN, provider.token);
  builds++;
  if (failBuild) { process.env.HOOK_ADDED_VALUE = 'must-be-restored'; throw new Error(`build failed with ${process.env.MAIL_API_KEY}`); }
  if (options.dryRun) return { dryRun: true, deployed: false };
  const args = ['--declaration', declarationPath, '--environment', options.environment ?? 'production'];
  let result;
  if (declared) result = await ownerKit(['deploy', ...args], process.env, { cwd: root });
  else {
   // A vendored legacy hook does not filter retired secrets and can re-upload.
   const api = cloudflare({ accountId: process.env.CLOUDFLARE_ACCOUNT_ID, token: process.env.CLOUDFLARE_API_TOKEN });
   const target = await ownerTarget(api, { project: declaration.project, environment: options.environment ?? 'production' });
   const artifact = await packageBuild({ root, source: { sha: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}') }, runIdentity: { id: '0', attempt: '1' }, productDirectory: '' });
   const { receipt } = await ownerDeploy({ api, target, plan: ownerPlan(target, declaration, artifact), artifact, statePath: join(root, '.rer/deploy', `${target.environment}.json`), env: process.env });
   result = { origin: receipt.origin };
  }
  if (selfClaim) await owner({ origin: result.origin, vars: { SETUP_TOKEN: process.env.SETUP_TOKEN }, input: {}, store, signal }, { displayName: () => 'Owner', returnTo: '/setup' });
  return { deployed: true, origin: result.origin };
 };
 if (declared) adapter.deployDeclaration = declarationPath;
 const manifest = { steps: [{ type: 'owner-claim', mode: idp ? 'idp' : 'signed', ...(idp ? { dependency: 'oidc-provider@1' } : {}), path: '/auth/owner-claim', emailField: 'OWNER_EMAIL', tokenField: 'SETUP_TOKEN' }], fields: ['SESSION_SECRET', 'SETUP_TOKEN'].map(name => ({ name, kind: 'secret', generate: 'hex' })) };
 const project = { root, profile: 'first-party', adapter, setupManifest: manifest };
 const run = (options = {}) => runCommand(project, { verb: 'deploy', forwarded: [], envFile: 'owner.env', json: true, ...options }, { progress: line => progress.push(line), event: () => {} });
 return { root, provider, claims, requests, progress, run, git, adapter, builds: () => builds, deny: (value = true) => { denied = value; }, failBuild: () => { failBuild = true; } };
}

test('conventional legacy function hook claims actual bootstrap, retires re-uploaded tokens, and bypasses hooks for changes', async t => {
 const f = await fixture(t);
 const original = { ...process.env };
 const dry = await f.run({ dryRun: true }); assert.equal(dry.deployed, false); assert.equal(f.requests.length, 0);
 const first = await f.run(); assert.equal(first.owner, 'claimed'); assert.equal(f.claims.length, 1);
 assert.ok(Object.keys(process.env).length === Object.keys(original).length && Object.entries(original).every(([key, value]) => process.env[key] === value), 'caller environment restored');
 assert.ok(!f.provider.state.secrets.some(item => item.name === 'SETUP_TOKEN'));
 const next = await f.run(); assert.equal(next.owner, 'kept'); assert.equal(f.claims.length, 1);
 assert.ok(!f.provider.state.secrets.some(item => item.name === 'SETUP_TOKEN'), 'legacy upload cannot leave a retired token live');
 const builds = f.builds(), writes = f.provider.state.writes.length;
 for (const options of [{ remove: true }, { dryRun: true, setSecret: 'SESSION_SECRET' }, { remove: true, yes: true, unsetSecret: 'SESSION_SECRET' }]) await assert.rejects(f.run(options), { code: 'invalid_invocation' });
 assert.equal(f.builds(), builds); assert.equal(f.provider.state.writes.length, writes);
 process.env.SESSION_SECRET = 'rotated-session';
 await f.run({ setSecret: 'SESSION_SECRET' });
 await f.run({ unsetSecret: 'SESSION_SECRET' });
 await f.run({ remove: true, yes: true });
 assert.equal(f.builds(), builds); assert.equal(f.provider.state.settings, null);
});

test('declared minimal hook keeps an established owner and refuses provider replacement without changing it', async t => {
 const f = await fixture(t, { declared: true, existing: true });
 assert.equal((await f.run()).owner, 'kept'); assert.equal(f.claims.length, 1);
 assert.ok(f.progress.some(line => line.includes('already claimed and was kept')));
 assert.ok(!f.provider.state.secrets.some(item => item.name === 'SETUP_TOKEN'));
 f.provider.foreign.replaceWorker(); const writes = f.provider.state.writes.length;
 await assert.rejects(f.run({ unsetSecret: 'MAIL_API_KEY' }), /owned-resource-replaced/);
 assert.equal(f.provider.state.writes.length, writes);
});

test('custom deploy calling the shared owner helper claims once and shared finalization retires its token', async t => {
 const f = await fixture(t, { selfClaim: true });
 assert.equal((await f.run()).owner, 'claimed'); assert.equal(f.claims.length, 1);
 assert.ok(!f.provider.state.secrets.some(item => item.name === 'SETUP_TOKEN'));
});

test('claim and retirement failures fail the command with deployment state and same-input recovery', async t => {
 const f = await fixture(t, { declared: true });
 f.provider.fail('DELETE', /\/secrets\/SETUP_TOKEN$/);
 await assert.rejects(f.run(), error => /application is deployed/.test(error.message) && /owner claimed/.test(error.message) && /--env-file owner.env --unset-secret SETUP_TOKEN/.test(error.message));
 assert.equal(f.claims.length, 1); assert.ok(f.provider.state.secrets.some(item => item.name === 'SETUP_TOKEN'));
 await f.run({ unsetSecret: 'SETUP_TOKEN' });
 assert.ok(!f.provider.state.secrets.some(item => item.name === 'SETUP_TOKEN'));
 const before = { ...process.env }; f.failBuild();
 await assert.rejects(f.run(), error => !error.message.includes('synthetic-mail-value'));
 assert.ok(Object.keys(process.env).length === Object.keys(before).length && Object.entries(before).every(([key, value]) => process.env[key] === value), 'caller environment restored after failure');
});

test('missing or ambiguous ownership records refuse success, and denied bootstrap is never retried', async t => {
 const f = await fixture(t);
 f.deny(); await assert.rejects(f.run(), /owner claim is not confirmed/);
 assert.equal(f.claims.length, 1); assert.ok(f.provider.state.secrets.some(item => item.name === 'SETUP_TOKEN'));
 await f.run({ unsetSecret: 'SETUP_TOKEN' });
 f.deny(false);
 assert.equal((await f.run()).owner, 'claimed', 'manual token retirement does not prove an owner was claimed');
 assert.equal(f.claims.length, 2);
 await rm(join(f.root, '.rer/deploy/production.json'));
 const builds = f.builds(), writes = f.provider.state.writes.length;
 await assert.rejects(f.run({ unsetSecret: 'SETUP_TOKEN' }), /missing-owner-receipt/);
 assert.equal(f.builds(), builds); assert.equal(f.provider.state.writes.length, writes);
 f.adapter.deploy = async () => ({ deployed: true, origin: 'https://fixture-production.fixture-account.workers.dev' });
 await assert.rejects(f.run(), /missing-owner-receipt/);
 assert.equal(f.provider.state.writes.length, writes);
 await writeFile(join(f.root, 'other-deploy.json'), await readFile(join(f.root, 'deploy.json')));
 await assert.rejects(f.run(), /ambiguous declarations/); assert.equal(f.builds(), builds);
});


test('identity-provider deploy cannot report ownership from an absent link', async t => {
 const f = await fixture(t, { declared: true, idp: true });
 await assert.rejects(f.run(), /identity provider has not confirmed/);
 assert.equal(f.claims.length, 0);
 assert.ok(f.provider.state.secrets.some(item => item.name === 'SETUP_TOKEN'));
 const state = JSON.parse(await readFile(join(f.root, '.rer/deploy/production.json'), 'utf8'));
 assert.equal(state.ownerClaim, undefined);
});
