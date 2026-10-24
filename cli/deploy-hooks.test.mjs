import { productionSender } from './fixtures/production-sender.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { parse } from './parse.mjs';
import { execFileSync } from 'node:child_process';
import { runCommand } from './lifecycle.mjs';
import { ownerProvider } from '../modules/deploy-kit/tests/owner-provider.mjs';
import { main as ownerKit } from '../modules/deploy-kit/owner-cli.mjs';
import { cloudflare } from '../modules/deploy-kit/provider.mjs';
import { ownerTarget, ownerPlan, ownerDeploy } from '../modules/deploy-kit/owner.mjs';
import { packageBuild } from '../modules/deploy-kit/prepare.mjs';
import { owner } from '../onboarding/adapter-auth.mjs';
import { finalizingDeploy } from './fixtures/finalizing-deploy.mjs';
import { keyPair } from '../modules/dependencies/crypto.mjs';
import { openDependencyKey, sealDependencyKey, installationKeyId } from '../modules/dependencies/sealing.mjs';

test('installation rotation publishes both keys atomically, reseals every row and resumes failed reseal or retirement without losing custody', async t => {
 const f = await fixture(t, {declared:true, existing:true, installation:true});
 const previewKey=randomBytes(32).toString('hex');
 process.env.INSTALLATION_KEY=previewKey;
 try { await f.run({dryRun:true}); } finally { delete process.env.INSTALLATION_KEY; }
 assert.equal(f.provider.state.writes.length, 0);
 assert.ok(f.progress.some(line => line.includes('INSTALLATION_KEY')));
 assert.equal(f.progress.join('\n').includes(previewKey),false);
 const file = join(f.root, '.rer/deploy/production.secrets.env');
 await assert.rejects(readFile(file), {code:'ENOENT'});
 await f.run();
 const original = f.provider.state.secrets.find(item => item.name === 'INSTALLATION_KEY').value;
 assert.equal((await stat(file)).mode & 0o777, 0o600);
 assert.equal(f.git('check-ignore', '.rer/deploy/production.secrets.env'), '.rer/deploy/production.secrets.env');
 const db = f.provider.state.databases[0].db;
 const keys = [await keyPair(), await keyPair()];
 for (let i=0;i<keys.length;i++) db.prepare('INSERT INTO rer_dependency_keys(interface,private_key) VALUES(?,?)').run(`service-${i}@1`, await sealDependencyKey({INSTALLATION_KEY:original}, `service-${i}@1`, keys[i]));
 db.prepare('INSERT INTO rer_dependency_installation(singleton,sector_id,keys_sealed,key_ids) VALUES(1,?,1,?)').run(crypto.randomUUID(),JSON.stringify([await installationKeyId(original)]));
 const before = db.prepare('SELECT * FROM rer_dependency_keys ORDER BY interface').all();
 const builds = f.builds(), writes = f.provider.state.writes.length;
 for (const flag of ['setSecret','unsetSecret']) for (const key of ['INSTALLATION_KEY','INSTALLATION_KEY_PREVIOUS']) await assert.rejects(f.run({[flag]:key}), /cannot be set or removed manually/);
 assert.equal(f.provider.state.writes.length, writes);
 const transport = globalThis.fetch, observations = [];
 t.mock.method(globalThis, 'fetch', async (input, init) => {
  if (String(input).endsWith('/query')) observations.push(f.provider.state.secrets.filter(item => item.name.startsWith('INSTALLATION_KEY')).map(item => item.name).sort());
  return transport(input, init);
 });
 f.provider.state.failSql = 'UPDATE rer_dependency_keys';
 await assert.rejects(f.run({rotateSecret:'INSTALLATION_KEY'}), /dependency-rekey-failed/);
 const saved = await readFile(file, 'utf8');
 const values = Object.fromEntries(saved.trim().split('\n').map(line=>line.split('=')));
 assert.equal(values.INSTALLATION_KEY_PREVIOUS, original);
 assert.notEqual(values.INSTALLATION_KEY, original);
 assert.deepEqual(db.prepare('SELECT * FROM rer_dependency_keys ORDER BY interface').all(), before);
 await assert.rejects(f.run(), /rotation is unfinished/);
 f.provider.state.failSql = null;
 f.provider.fail('DELETE', /\/secrets\/INSTALLATION_KEY_PREVIOUS$/, {status:403});
 await assert.rejects(f.run({rotateSecret:'INSTALLATION_KEY'}));
 assert.equal(await readFile(file, 'utf8'), saved, 'a failed retirement retains both exact keys');
 assert.equal(f.provider.state.secrets.find(item=>item.name==='INSTALLATION_KEY_PREVIOUS').value, original);
 for (const row of db.prepare('SELECT * FROM rer_dependency_keys ORDER BY interface').all()) {
  const opened = await openDependencyKey({INSTALLATION_KEY:values.INSTALLATION_KEY},row.interface,row.private_key,{currentOnly:true});
  assert.equal(opened.key.kid, keys[Number(row.interface[8])].kid);
 }
 await f.run({rotateSecret:'INSTALLATION_KEY'});
 const retained = await readFile(file, 'utf8');
 assert.ok(!retained.includes('INSTALLATION_KEY_PREVIOUS='));
 assert.equal(f.provider.state.secrets.find(item=>item.name==='INSTALLATION_KEY').value, values.INSTALLATION_KEY, 'resume uses the same current key');
 assert.ok(!f.provider.state.secrets.some(item=>item.name==='INSTALLATION_KEY_PREVIOUS'));
 assert.equal(f.builds(), builds, 'rotation does not build or run the custom upload hook');
 assert.ok(observations.length>0 && observations.every(names=>names.join(',')==='INSTALLATION_KEY,INSTALLATION_KEY_PREVIOUS'), 'both bindings are live before any D1 read or write');
 assert.ok(!f.progress.join('').includes(original) && !f.progress.join('').includes(values.INSTALLATION_KEY));
});

test('routine installation rotation refuses a replayed retired-era signing key after relink', async t => {
 const f = await fixture(t, {declared:true, existing:true, installation:true});
 await f.run();
 const current = () => f.provider.state.secrets.find(item => item.name === 'INSTALLATION_KEY').value;
 const first = current(), contract = 'relinked@1', oldKey = await keyPair();
 const retiredRaw = await sealDependencyKey({INSTALLATION_KEY:first}, contract, oldKey);
 const db = f.provider.state.databases[0].db;
 db.prepare('INSERT INTO rer_dependency_installation(singleton,sector_id,keys_sealed,key_ids) VALUES(1,?,1,?)').run(crypto.randomUUID(),JSON.stringify([await installationKeyId(first)]));
 db.prepare('INSERT INTO rer_dependency_keys(interface,private_key) VALUES(?,?)').run(contract, retiredRaw);
 await f.run({rotateSecret:'INSTALLATION_KEY'});
 // Relinking replaces the signing JWK under the current installation key.
 const second = current(), relinkedKey = await keyPair();
 const relinkedRaw = await sealDependencyKey({INSTALLATION_KEY:second}, contract, relinkedKey);
 db.prepare('UPDATE rer_dependency_keys SET private_key=? WHERE interface=?').run(relinkedRaw, contract);
 const history = db.prepare('SELECT key_ids FROM rer_dependency_installation').get().key_ids;
 // A D1 writer replays the genuine envelope from before the first rotation.
 db.prepare('UPDATE rer_dependency_keys SET private_key=? WHERE interface=?').run(retiredRaw, contract);
 await assert.rejects(openDependencyKey({INSTALLATION_KEY:second},contract,retiredRaw,{knownKeyIds:JSON.parse(history)}), {code:'installation_key_version_unknown'});
 await assert.rejects(f.run({rotateSecret:'INSTALLATION_KEY'}), /dependency-rekey-failed/);
 assert.equal(db.prepare('SELECT private_key FROM rer_dependency_keys WHERE interface=?').get(contract).private_key,retiredRaw);
 assert.equal(db.prepare('SELECT key_ids FROM rer_dependency_installation').get().key_ids,history);
 // Repair the replay and resume the saved rotation pair; only the relinked JWK lives.
 db.prepare('UPDATE rer_dependency_keys SET private_key=? WHERE interface=?').run(relinkedRaw, contract);
 await f.run({rotateSecret:'INSTALLATION_KEY'});
 const liveRaw = db.prepare('SELECT private_key FROM rer_dependency_keys WHERE interface=?').get(contract).private_key;
 assert.equal((await openDependencyKey({INSTALLATION_KEY:current()},contract,liveRaw,{currentOnly:true})).key.kid,relinkedKey.kid);
 assert.ok(!f.provider.state.secrets.some(item=>item.name==='INSTALLATION_KEY_PREVIOUS'));
 assert.ok(!f.progress.join('').includes(first) && !f.progress.join('').includes(second) && !f.progress.join('').includes(current()));
});

test('retired custody reopens a pre-rotation D1 restore explicitly and survives interrupted retirement', async t => {
 const f = await fixture(t, {declared:true, existing:true, installation:true, ownRecord:true, returnState:true, namedState:true});
 await f.run();
 const file = join(f.root, '.rer/deploy/production.secrets.env');
 const current = () => f.provider.state.secrets.find(item => item.name === 'INSTALLATION_KEY').value;
 const first = current(), key = await keyPair(), contract = 'restore@1';
 const raw = await sealDependencyKey({INSTALLATION_KEY:first}, contract, key), kid = JSON.parse(raw).kid;
 const db = f.provider.state.databases[0].db;
 db.prepare('INSERT INTO rer_dependency_installation(singleton,sector_id,keys_sealed,key_ids) VALUES(1,?,1,?)').run(crypto.randomUUID(),JSON.stringify([kid]));
 db.prepare('INSERT INTO rer_dependency_keys(interface,private_key) VALUES(?,?)').run(contract, raw);
 await f.run({rotateSecret:'INSTALLATION_KEY'});
 const second = current(), sibling = 'sibling@1', siblingKey = await keyPair();
 const siblingRaw = await sealDependencyKey({INSTALLATION_KEY:second}, sibling, siblingKey), siblingKid = JSON.parse(siblingRaw).kid;
 db.prepare('INSERT INTO rer_dependency_keys(interface,private_key) VALUES(?,?)').run(sibling, siblingRaw);
 await f.run({rotateSecret:'INSTALLATION_KEY'});
 const custody = await readFile(file, 'utf8');
 assert.ok(custody.includes(`INSTALLATION_KEY_RETIRED=${kid}:`), 'every retired key remains in private custody');
 assert.equal(custody.split('INSTALLATION_KEY_RETIRED=')[1].split('\n')[0].split(',').length, 2);
 assert.equal((await stat(file)).mode & 0o777, 0o600);
 const active = current(), builds = f.builds();
 assert.equal(parse(['deploy','--reopen-installation-key',kid]).reopenInstallationKey,kid);
 for (const options of [{dryRun:true}, {rotateSecret:'INSTALLATION_KEY'}, {setSecret:'SESSION_SECRET'}, {remove:true,yes:true}]) await assert.rejects(f.run({...options,reopenInstallationKey:kid}), {code:'invalid_invocation'});
 // Simulate D1 Time Travel replacing a row with its pre-rotation ciphertext.
 db.prepare('UPDATE rer_dependency_keys SET private_key=? WHERE interface=?').run(raw, contract);
 await assert.rejects(openDependencyKey({INSTALLATION_KEY:active},contract,raw,{knownKeyIds:[kid]}), {code:'installation_key_version_unknown'});
 // Restore the complete mid-rotation snapshot: history still [k0], rows k0/k1.
 const restore = () => {
  db.prepare('UPDATE rer_dependency_installation SET key_ids=?').run(JSON.stringify([kid]));
  db.prepare('UPDATE rer_dependency_keys SET private_key=? WHERE interface=?').run(raw, contract);
  db.prepare('UPDATE rer_dependency_keys SET private_key=? WHERE interface=?').run(siblingRaw, sibling);
 };
 restore();
 const writes = f.provider.state.writes.length;
 await writeFile(file, custody.replace(/^INSTALLATION_KEY_RETIRED=.*\n/m, ''));
 await assert.rejects(f.run({reopenInstallationKey:kid}), {code:'installation_key_unavailable'});
 assert.equal(f.provider.state.writes.length,writes,'missing custody refuses before any provider write');
 await writeFile(file,custody);
 f.provider.fail('DELETE', /\/secrets\/INSTALLATION_KEY_PREVIOUS$/, {status:403});
 await assert.rejects(f.run({reopenInstallationKey:kid}));
 await assert.rejects(f.run(), /reopen is unfinished/);
 await assert.rejects(f.run({rotateSecret:'INSTALLATION_KEY'}), /reopen is unfinished/);
 const opened = await openDependencyKey({INSTALLATION_KEY:active},contract,db.prepare('SELECT private_key FROM rer_dependency_keys WHERE interface=?').get(contract).private_key,{currentOnly:true});
 assert.equal(opened.key.kid,key.kid);
 const result = await f.run({reopenInstallationKey:kid});
 assert.equal(result.reopened,kid);
 assert.ok(f.progress.some(line=>line.includes(kid)), 'reopen exposes the D1 history ID in diagnostics');
 assert.ok(current()===active,'reopen keeps the current installation key');
 const retained = await readFile(file,'utf8');
 assert.ok(retained.includes(`INSTALLATION_KEY_RETIRED=${kid}:`));
 assert.ok(!retained.includes('INSTALLATION_KEY_PREVIOUS='));
 assert.ok(!retained.includes('INSTALLATION_KEY_REOPEN='));
 assert.ok(!f.provider.state.secrets.some(item=>['INSTALLATION_KEY_PREVIOUS','INSTALLATION_KEY_RETIRED'].includes(item.name)));
 assert.equal(f.builds(),builds);
 // Either retired ID may select the published pair; local rekey needs both.
 restore();await f.run({reopenInstallationKey:siblingKid});
 for(const [contract,expectedKey] of [['restore@1',key],[sibling,siblingKey]]) {
  const raw=db.prepare('SELECT private_key FROM rer_dependency_keys WHERE interface=?').get(contract).private_key;
  assert.equal((await openDependencyKey({INSTALLATION_KEY:active},contract,raw,{currentOnly:true})).key.kid,expectedKey.kid);
 }
 assert.ok(!f.progress.join('').includes(first) && !f.progress.join('').includes(second) && !f.progress.join('').includes(active));
});

// Public lifecycle command, real owner kit and legacy custom adapters; only the
// provider and hosted HTTP edge are faked. No seed source is modified.
async function fixture(t, { declared = false, selfClaim = false, existing = false, idp = false, ownRecord = false, returnState = false, namedState = false, queued = false, installation = false, signOutPath = '/auth/signout' } = {}) {
 const root = await realpath(await mkdtemp(join(tmpdir(), 'rer-hook-deploy-')));
 const saved = { ...process.env };
 t.after(async () => { for (const key of Object.keys(process.env)) if (!Object.hasOwn(saved, key)) delete process.env[key]; Object.assign(process.env, saved); await rm(root, { recursive: true, force: true }); });
 process.env.CI = 'true';
 for (const key of ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'SETUP_TOKEN', 'SESSION_SECRET', 'OWNER_EMAIL', 'MAIL_API_KEY', 'INSTALLATION_KEY', 'INSTALLATION_KEY_PREVIOUS']) delete process.env[key];
 const provider = ownerProvider(), requests = [], claims = [], progress = [];
 t.after(() => provider.close());
 let claimed = existing, denied = false, builds = 0, failBuild = false, hookToken, returnToken = false, signedOut = false;
 t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
  const url = new URL(input); requests.push(`${init.method ?? 'GET'} ${url.pathname}`);
  if (url.pathname === '/auth/bootstrap') {
   const body = JSON.parse(init.body);
   claims.push(body.token);
   // The app answers a token the Worker does not hold as Base does.
   if (body.token !== provider.state.secrets.find(item => item.name === 'SETUP_TOKEN')?.value) return Response.json({ error: 'invalid_setup_token' }, { status: 403 });
   if (denied) return Response.json({ error: 'owner_claim_denied' }, { status: 403 });
   if (claimed) return Response.json({ error: 'already_initialized' }, { status: 409 });
   claimed = true; return new Response(null, { status: 303, headers: { 'set-cookie': 'session=test; HttpOnly' } });
  }
  if (url.pathname === '/setup') {
   assert.equal(signedOut, false, 'the hook can finish using its bootstrap session');
   return new Response(null, { status: 303, headers: { location: '/app' } });
  }
  if (url.pathname === signOutPath) {
   assert.equal(new Headers(init.headers).get('cookie'), 'session=test');
   signedOut = true;
   return new Response(null, { status: 204 });
  }
  return provider.fetch(input, init);
 });
 for (const directory of ['dist/server', 'dist/client', 'migrations/core']) await mkdir(join(root, directory), { recursive: true });
 await writeFile(join(root, 'dist/server/wrangler.json'), JSON.stringify({ main: 'index.js', no_bundle: true, rules: [{ type: 'ESModule', globs: ['**/*.js', '**/*.mjs'] }] }));
 await writeFile(join(root, 'dist/server/index.js'), 'export default { fetch(){return new Response("ok")} }');
 await writeFile(join(root, 'dist/client/index.html'), 'Application');
 await writeFile(join(root, 'package.json'), JSON.stringify({ packageManager: 'pnpm@10.12.4' }));
 const declarationPath = declared ? 'owner-deployment.json' : 'deploy.json';
 const declaration = { version: 1, project: 'tests/fixture', compatibilityDate: '2026-09-08', vars: {MAIL_PROVIDER:'resend',MAIL_FROM:productionSender}, secrets: ['OWNER_EMAIL', 'SETUP_TOKEN', 'SESSION_SECRET', 'MAIL_API_KEY'].map(name => ({ binding: name, environment: name })) };
 if (installation) {
  declaration.d1 = [{binding:'DB'}];
  declaration.secrets.push({binding:'INSTALLATION_KEY',environment:'INSTALLATION_KEY'}, {binding:'INSTALLATION_KEY_PREVIOUS',environment:'INSTALLATION_KEY_PREVIOUS',optional:true});
  await writeFile(join(root, 'migrations/core/0001_dependency.sql'), await readFile(new URL('../modules/dependencies/schema/dependencies.sql', import.meta.url)));
  await writeFile(join(root, 'migrations/core/0002_keys-sealed.sql'), await readFile(new URL('../modules/dependencies/schema/keys-sealed.sql', import.meta.url)));
 }
 if (queued) declaration.queues = [{binding:'JOBS'}];
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
 adapter.hooks.owner.signOutPath = signOutPath;
 adapter.deploy = async ({ options, store, signal }) => {
  // Both preflight and build use the real process environment, as old hooks do.
  assert.equal(process.env.MAIL_API_KEY, 'synthetic-mail-value');
  assert.equal(process.env.CLOUDFLARE_API_TOKEN, provider.token);
  builds++;
  if (failBuild) { process.env.HOOK_ADDED_VALUE = 'must-be-restored'; throw new Error(`build failed with ${process.env.MAIL_API_KEY}`); }
  if (options.dryRun) return { dryRun: true, deployed: false };
  const args = ['--declaration', declarationPath, '--environment', options.environment ?? 'production'];
  let result;
  // Like Penny, an own-record hook keeps its state elsewhere and its first setup
  // token; with named state it also deploys a setup token of its own.
  if (ownRecord) result = await ownerKit(['deploy', ...args, '--state', namedState ? `.rer/deploy/environments/${options.environment}/state.json` : '.rer/hook/production.json'], { ...process.env, SETUP_TOKEN: hookToken ??= namedState ? 'hook-own-setup-token' : process.env.SETUP_TOKEN }, { cwd: root });
  else if (declared) result = await ownerKit(['deploy', ...args], process.env, { cwd: root });
  else {
   // A vendored legacy hook does not filter retired secrets and can re-upload.
   const api = cloudflare({ accountId: process.env.CLOUDFLARE_ACCOUNT_ID, token: process.env.CLOUDFLARE_API_TOKEN });
   const target = await ownerTarget(api, { project: declaration.project, environment: options.environment ?? 'production' });
   const artifact = await packageBuild({ root, source: { sha: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}') }, runIdentity: { id: '0', attempt: '1' }, productDirectory: '' });
   const { receipt } = await ownerDeploy({ api, target, plan: ownerPlan(target, declaration, artifact), artifact, statePath: join(root, '.rer/deploy', `${target.environment}.json`), env: process.env });
   result = { origin: receipt.origin };
  }
  if (selfClaim) await owner({ origin: result.origin, vars: { SETUP_TOKEN: process.env.SETUP_TOKEN }, input: {}, store, signal }, { displayName: () => 'Owner', returnTo: '/setup' });
  return { deployed: true, origin: result.origin, ...(returnToken ? { setupToken: hookToken } : {}), ...(returnState ? { state: result.state } : {}) };
 };
 if (declared) adapter.deployDeclaration = declarationPath;
 const manifest = { steps: [{ type: 'owner-claim', mode: idp ? 'idp' : 'signed', ...(idp ? { dependency: 'oidc-provider@1' } : {}), path: '/auth/owner-claim', emailField: 'OWNER_EMAIL', tokenField: 'SETUP_TOKEN' }], fields: ['SESSION_SECRET', 'SETUP_TOKEN'].map(name => ({ name, kind: 'secret', generate: 'hex' })) };
 if (installation) manifest.fields.push({name:'INSTALLATION_KEY',kind:'secret',generate:'hex'});
 const project = { root, profile: 'first-party', adapter, setupManifest: manifest };
 const run = (options = {}) => runCommand(project, { verb: 'deploy', forwarded: [], envFile: 'owner.env', json: true, ...options }, { progress: line => progress.push(line), event: () => {} });
 return { root, provider, claims, requests, progress, run, git, adapter, builds: () => builds, deny: (value = true) => { denied = value; }, failBuild: () => { failBuild = true; }, returnToken: () => { returnToken = true; } };
}

test('conventional legacy function hook claims actual bootstrap, retires re-uploaded tokens, and bypasses hooks for changes', async t => {
 const f = await fixture(t);
 const original = { ...process.env };
 const dry = await f.run({ dryRun: true }); assert.equal(dry.deployed, false); assert.ok(f.requests.length>0); assert.ok(f.requests.every(call=>call.startsWith('GET '))); assert.equal(f.provider.state.writes.length,0);
 const first = await f.run(); assert.equal(first.owner, 'claimed'); assert.equal(f.claims.length, 1);
 assert.equal(f.requests.filter(call => call === 'POST /auth/signout').length, 1, 'the unused claim session is retired once');
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

test('function owner hook declares its session revocation route', async t => {
 const f = await fixture(t, { signOutPath: '/api/auth/logout' });
 assert.equal((await f.run()).owner, 'claimed');
 assert.equal(f.requests.filter(call => call === 'POST /api/auth/logout').length, 1);
 assert.equal(f.requests.includes('POST /auth/signout'), false);
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

test('first custom deploy accepts late health, rejects missing signout, and rejects wrong-commit health with the exact rerun', async t => {
 const f = await finalizingDeploy(t);
 const result = await f.run('late'), output = result.stdout + result.stderr;
 assert.equal(result.code, 0, output);
 const events = result.stdout.trim().split('\n').map(line => JSON.parse(line));
 assert.equal(events.at(-1).ok, true); assert.equal(events.at(-1).owner, 'claimed');
 const state = JSON.parse(await readFile(join(f.root, '.rer/deploy/review.json')));
 assert.equal(state.ownerClaim.outcome, 'claimed');
 assert.ok(state.retiredSecrets.includes('SETUP_TOKEN'));
 // A fresh first deploy with a different edge commit must still fail clearly.
 await rm(join(f.root, '.rer'), { recursive: true, force: true });
 const wrong = await f.run('wrong'), failure = wrong.stdout + wrong.stderr;
 assert.equal(wrong.code, 1, failure);
 assert.match(failure, /still answers for commit 0123456789ab/);
 assert.match(failure, /90-second finalization wait/);
 assert.ok(failure.includes(f.again), failure);
 // A missing sign-out route fails even after the owner account was created.
 for (const status of [404, 405]) {
  await rm(join(f.root, '.rer'), { recursive: true, force: true });
  const missing = await f.run('late', { signout: status }), said = missing.stdout + missing.stderr;
  assert.equal(missing.code, 1, said);
  assert.match(said, /unused owner session could not be retired/);
  assert.match(said, /\/api\/auth\/logout/);
 }
 // A declared route is threaded through nested custom-deploy observers.
 await rm(join(f.root, '.rer'), { recursive: true, force: true });
 const elsewhere = await f.run('late', { signout: 404, signOutPath: '/api/auth/logout' });
 assert.equal(elsewhere.code, 0, elsewhere.stdout + elsewhere.stderr);
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

test('a custom deploy that Cloudflare refuses names the call and Cloudflare\'s own code and message, without credentials', async t => {
 const f = await fixture(t, { declared: true });
 const message = `Uncaught ReferenceError in the uploaded script for account ${f.provider.accountId} with token ${f.provider.token}: ${'x'.repeat(2000)}`;
 f.provider.fail('PUT', /^\/workers\/scripts\/[^/]+$/, { status: 400, errors: [{ code: 10021, message }] });
 await assert.rejects(f.run(), error => {
  assert.match(error.message, /PUT \/workers\/scripts\/[a-z0-9-]+/, 'the refused call');
  assert.match(error.message, /10021 Uncaught ReferenceError in the uploaded script/, 'Cloudflare\'s own code and message');
  assert.ok(!error.message.includes(f.provider.accountId) && !error.message.includes(f.provider.token), 'no credentials');
  assert.ok(!error.message.includes('x'.repeat(400)), 'the message is bounded');
  return true;
 });
});

test('custom deploy retries one reset before HTTP status and names a second reset with same-input recovery', async t => {
 for (const failures of [1,2]) await t.test(`${failures} reset${failures === 1 ? '' : 's'}`, async t => {
  const f = await fixture(t, { declared: true });
  const original = f.provider.fetch; let attempts = 0;
  t.mock.method(f.provider, 'fetch', async (input, init) => {
   if (new URL(input).pathname.endsWith('/workers/subdomain') && ++attempts <= failures) {
    throw new TypeError(`fetch failed https://user:private-password@api.cloudflare.com/?signature=private-signature#private-fragment`, {cause:Object.assign(new Error(`reset ${f.provider.token}`),{code:'ECONNRESET'})});
   }
   return original(input,init);
  });
  if (failures === 1) {
   assert.equal((await f.run()).owner, 'claimed');
   assert.ok(attempts >= 2);
  } else {
   await assert.rejects(f.run(), error => {
    assert.equal(error.exitCode,1);
    assert.match(error.message,/GET \/workers\/subdomain/);
    assert.match(error.message,/https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/\[REDACTED\]\/workers\/subdomain/);
    assert.match(error.message,/before any HTTP status after 2 attempts: ECONNRESET/);
    assert.match(error.message,/run rer deploy --environment production --env-file owner.env again/);
    for (const value of [f.provider.accountId,f.provider.token,'private-password','private-signature','private-fragment']) assert.ok(!error.message.includes(value));
    return true;
   });
   assert.equal(attempts,2);
   assert.equal(f.provider.state.writes.length,0);
  }
 });
});

test('custom deploy retries a queue create only when its connection failed before dispatch', async t => {
 for (const failures of [1,2]) await t.test(`${failures} connection failure${failures === 1 ? '' : 's'}`, async t => {
  const f = await fixture(t, { declared: true, queued: true });
  const original = f.provider.fetch; let attempts = 0;
  t.mock.method(f.provider,'fetch', async (input,init) => {
   if (init?.method === 'POST' && new URL(input).pathname.endsWith('/queues') && ++attempts <= failures) {
    throw new TypeError('fetch failed',{cause:Object.assign(new Error('connection refused'),{code:'ECONNREFUSED'})});
   }
   return original(input,init);
  });
  if (failures === 1) {
   assert.equal((await f.run()).owner,'claimed');
   assert.equal(attempts,2);
   assert.equal(f.provider.state.queues.length,1);
  } else {
   await assert.rejects(f.run(), error => /POST \/queues/.test(error.message) && /after 2 attempts: ECONNREFUSED/.test(error.message) && /run rer deploy --environment production --env-file owner.env again/.test(error.message));
   assert.equal(attempts,2);
   assert.equal(f.provider.state.queues.length,0);
  }
 });
});

test('missing or ambiguous ownership records refuse success, and denied bootstrap is never retried', async t => {
 const f = await fixture(t);
 f.deny(); await assert.rejects(f.run(), error => {
  assert.match(error.message, /owner claim is not confirmed/);
  assert.match(error.message, /POST \/auth\/bootstrap returned HTTP 403 \(owner_claim_denied\)/);
  assert.match(error.message, /run rer deploy/);
  return true;
 });
 assert.equal(f.claims.length, 1); assert.ok(f.provider.state.secrets.some(item => item.name === 'SETUP_TOKEN'));
 await f.run({ unsetSecret: 'SETUP_TOKEN' });
 f.deny(false);
 assert.equal((await f.run()).owner, 'claimed', 'manual token retirement does not prove an owner was claimed');
 assert.equal(f.claims.length, 2);
 await rm(join(f.root, '.rer/deploy/production.json'));
 const builds = f.builds(), writes = f.provider.state.writes.length;
 await assert.rejects(f.run({ unsetSecret: 'SETUP_TOKEN' }), error => {
  assert.equal(error.environment, 'production');
  assert.deepEqual(error.availableDeployments, []);
  return true;
 });
 assert.equal(f.builds(), builds); assert.equal(f.provider.state.writes.length, writes);
 await writeFile(join(f.root, 'other-deploy.json'), await readFile(join(f.root, 'deploy.json')));
 await assert.rejects(f.run(), /ambiguous declarations/); assert.equal(f.builds(), builds);
});

test('a hook keeping its own record is claimed from its result once /health names the commit', async t => {
 const f = await fixture(t, { declared: true, ownRecord: true });
 const first = await f.run();
 assert.equal(first.owner, 'claimed'); assert.equal(first.setupToken, undefined); assert.equal(f.claims.length, 1);
 assert.ok(f.progress.some(line => line.includes(`Sign in by email at ${first.origin}`)));
 // A redeploy keeps the owner with the token the hook says it deployed.
 f.returnToken();
 assert.equal((await f.run()).owner, 'kept'); assert.equal(f.claims.length, 2);
 // A hook whose app never shows this commit, and one that reports no deployment.
 f.adapter.deploy = async () => ({ deployed: true, origin: first.origin });
 let elapsed = 0;
 t.mock.method(performance, 'now', () => elapsed);
 f.provider.state.healthOverride = () => { elapsed += 90000; return Response.json({ ok: true, deployment: { sourceSha: '0123456789abcdef0123456789abcdef01234567' } }); };
 await assert.rejects(f.run(), error => {
  assert.equal(error.exitCode, 1);
  assert.match(error.message, /within the 90-second finalization wait/); assert.match(error.message, /still answers for commit 0123456789ab/);
  assert.ok(error.message.includes('rer deploy --environment production --env-file owner.env'));
  assert.doesNotMatch(error.message, /receipt/);
  return true;
 });
 f.adapter.deploy = async () => ({ deployed: false });
 await assert.rejects(f.run(), error => /without reporting a live deployment/.test(error.message) && !/receipt/.test(error.message));
 assert.equal(f.claims.length, 2);
 // An http origin off loopback is refused before rer sends it anything.
 f.adapter.deploy = async () => ({ deployed: true, origin: new URL(first.origin).origin.replace('https:', 'http:'), setupToken: 'hook-token-value' });
 const sent = f.requests.length;
 await assert.rejects(f.run(), error => /not https/.test(error.message) && /return its https origin/.test(error.message) && !error.message.includes('hook-token-value'));
 assert.equal(f.requests.length, sent); assert.equal(f.claims.length, 2);
});

test('rer deploy --remove after a hook that kept its own record removes what the hook deployed and reads it back gone', async t => {
 const f = await fixture(t, { declared: true, ownRecord: true, returnState: true });
 assert.equal((await f.run()).deployed, true);
 const hookRecord = join(f.root, '.rer/hook/production.json');
 assert.ok(f.provider.state.settings, 'the hook deployed a Worker');
 const removed = await f.run({ remove: true, yes: true });
 assert.ok(removed.removed.some(item => item.startsWith('worker:')), JSON.stringify(removed));
 assert.equal(f.provider.state.settings, null, 'the Worker is gone');
 assert.ok(f.progress.some(line => /read back: none of them remains/.test(line)));
 await assert.rejects(readFile(hookRecord), { code: 'ENOENT' }, 'the hook\'s record is retired with what it named');
});

test('a hook that keeps named state gets its owner claimed through that state, and an untouched repeat writes nothing', async t => {
 const f = await fixture(t, { declared: true, ownRecord: true, returnState: true, namedState: true });
 const first = await f.run({ environment: 'evidence' });
 assert.equal(first.owner, 'claimed'); assert.equal(f.claims.length, 1);
 assert.ok(!f.provider.state.secrets.some(item => item.name === 'SETUP_TOKEN'), 'the setup token is retired');
 const statePath = join(f.root, '.rer/deploy/environments/evidence/state.json');
 const state = await readFile(statePath), writes = f.provider.state.writes.length;
 assert.equal((await f.run({ environment: 'evidence' })).owner, 'kept'); assert.equal(f.claims.length, 1);
 assert.equal(f.provider.state.writes.length, writes, 'no provider writes');
 assert.deepEqual(await readFile(statePath), state, 'the hook state is unchanged');
 // A secret change reads the same record.
 await f.run({ environment: 'evidence', unsetSecret: 'MAIL_API_KEY' });
 assert.ok(!f.provider.state.secrets.some(item => item.name === 'MAIL_API_KEY'));
});

test('uncommitted tracked source stops the deploy before building and names the files', async t => {
 const f = await fixture(t);
 await writeFile(join(f.root, '.gitignore'), 'dist/\n.rer/\n.seed/\nowner.env\nnotes/\n');
 await assert.rejects(f.run(), error => {
  assert.equal(error.exitCode, 4);
  assert.match(error.message, /\.gitignore/); assert.match(error.message, /git commit/); assert.match(error.message, /Nothing was uploaded/);
  return true;
 });
 assert.equal(f.builds(), 0); assert.equal(f.requests.length, 0);
});

test('identity-provider deploy cannot report ownership from an absent link', async t => {
 const f = await fixture(t, { declared: true, idp: true });
 await assert.rejects(f.run(), /identity provider has not confirmed/);
 assert.equal(f.claims.length, 0);
 assert.ok(f.provider.state.secrets.some(item => item.name === 'SETUP_TOKEN'));
 const state = JSON.parse(await readFile(join(f.root, '.rer/deploy/production.json'), 'utf8'));
 assert.equal(state.ownerClaim, undefined);
});

for (const declared of [false, true]) test(`hook finalization (${declared ? 'declared object' : 'legacy function'}) fails after applied token retirement`, async t => {
 const f = await fixture(t, { declared });
 let elapsed = 0;
 t.mock.method(performance, 'now', () => elapsed);
 f.provider.state.healthOverride = () => {
  if (!f.provider.state.secrets.some(item => item.name === 'SETUP_TOKEN')) { elapsed += 90000; return new Response('SETUP_TOKEN required synthetic-mail-value\nsecond line', { status: 503 }); }
  const vars = Object.fromEntries(f.provider.state.settings.bindings.map(item => [item.name, item.text]));
  return Response.json({ ok: true, deployment: { sourceSha: vars.RER_DEPLOY_SOURCE, fingerprint: vars.RER_DEPLOY_FINGERPRINT, versionId: f.provider.state.version.id } });
 };
 await assert.rejects(f.run(), error => {
  assert.equal(error.exitCode, 1);
  assert.match(error.message, /owner claimed/i); assert.match(error.message, /token retirement/i);
  assert.match(error.message, /HTTP 503/); assert.match(error.message, /configuration.*redeploy/i);
  assert.doesNotMatch(error.message, /synthetic-mail-value|second line|--set-secret SETUP_TOKEN|retirement is not confirmed/);
  return true;
 });
 const state = JSON.parse(await readFile(join(f.root, '.rer/deploy/production.json'), 'utf8'));
 assert.equal(state.ownerClaim.outcome, 'claimed'); assert.ok(state.retiredSecrets.includes('SETUP_TOKEN'));
 assert.equal(state.receipt.provider.versionId, f.provider.state.version.id);
 assert.ok(!f.provider.state.secrets.some(item => item.name === 'SETUP_TOKEN'));
 assert.equal(f.claims.length, 1);
 assert.ok(!f.progress.some(line => line.includes('Sign in by email')));
 // Public lifecycle errors carry nonzero exits for explicit mutations too.
 const builds = f.builds();
 process.env.SESSION_SECRET = 'test-only-session-rotation';
 await rm(join(f.root, 'dist'), { recursive: true });
 await writeFile(join(f.root, '.gitignore'), 'dirty source');
 for (const options of [{ setSecret: 'SESSION_SECRET' }, { unsetSecret: 'SESSION_SECRET' }]) {
  await assert.rejects(f.run(options), error => {
   assert.equal(error.exitCode, 1); assert.match(error.message, /secret change.*applied/i); assert.match(error.message, /HTTP 503/);
   return true;
  });
  const saved = JSON.parse(await readFile(join(f.root, '.rer/deploy/production.json'), 'utf8'));
  assert.equal(saved.receipt.provider.versionId, f.provider.state.version.id);
  assert.equal(f.provider.state.secrets.some(item => item.name === 'SESSION_SECRET'), Boolean(options.setSecret));
 }
 assert.equal(f.builds(), builds);
});


test('a function owner hook failing after bootstrap names its last hosted call', async t => {
 const f = await fixture(t);
 const fetch = globalThis.fetch;
 t.mock.method(globalThis, 'fetch', (input,init) => {
  const url = new URL(input);
  if (url.hostname.endsWith('.workers.dev') && url.pathname === '/setup') return Response.json({error:'setup_unavailable'},{status:503});
  return fetch(input,init);
 });
 await assert.rejects(f.run(), error => {
  assert.match(error.message,/GET \/setup returned HTTP 503 \(setup_unavailable\)/);
  assert.match(error.message,/run rer deploy/);
  return true;
 });
});
