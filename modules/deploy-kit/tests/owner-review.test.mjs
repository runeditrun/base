import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { cloudflare, withScopeHints, ownerTarget, ownerPlan, ownerDeploy, readOwnerState } from '../index.mjs';
import { main, report } from '../owner-cli.mjs';
import { hash } from '../validation.mjs';
import { ownerProvider } from './owner-provider.mjs';

/* Resource ownership, complete pagination and failed upgrades must preserve owner state. */

const source = 'export default {scheduled() {},fetch(){return new Response("ok")}}';
const sql = 'CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT NOT NULL);';
const build = text => ({version:1,source:{sha:hash(text).slice(0,40),tree:'6'.repeat(40)},run:{id:'0',attempt:'1'},main:'index.js',
  modules:[{path:'index.js',base64:Buffer.from(text).toString('base64'),sha256:hash(text)}],
  assets:[{path:'index.html',base64:Buffer.from('<h1>Owner</h1>').toString('base64'),sha256:hash('<h1>Owner</h1>')}],
  migrations:[{binding:'DB',name:'0001_notes.sql',sql,sha256:hash(sql)}]});
const declaration = (extra = {}) => ({version:1,project:'runeditrun/penny',compatibilityDate:'2026-09-08',compatibilityFlags:['nodejs_compat'],
  d1:[{binding:'DB'}],r2:[{binding:'FILES'}],crons:['* * * * *'],secrets:[{binding:'AUTH_SECRET',environment:'AUTH_SECRET'}],originVar:'APP_ORIGIN',...extra});

async function setup(t, {creationDates = false, artifact = build(source), declared = declaration()} = {}) {
  const provider = ownerProvider({creationDates}); t.after(() => provider.close());
  const dir = await realpath(await mkdtemp(join(tmpdir(),'deploy-kit-owner-review-'))); t.after(() => rm(dir,{recursive:true,force:true}));
  const api = cloudflare(provider);
  const target = await ownerTarget(api,{project:'runeditrun/penny',environment:'production'});
  const plan = ownerPlan(target,declared,artifact);
  const statePath = join(dir,'state','production.json');
  return {...provider,dir,api,target,plan,statePath,args:{api,target,plan,artifact,statePath,env:{AUTH_SECRET:'test-only-auth-value'},fetch:provider.fetch}};
}
const exists = path => access(path).then(() => true,() => false);
const uploads = state => state.writes.filter(x => x.method === 'PUT' && x.path === '/workers/scripts/penny-production').length;

test('a Worker replaced by someone else is refused before any write, never overwritten', async t => {
  const {args,state,foreign,statePath,target} = await setup(t);
  await ownerDeploy(args);
  foreign.replaceWorker();
  const writes = state.writes.length, bytes = await readFile(statePath), settings = JSON.stringify(state.settings);
  const changed = build('export default {scheduled() {},fetch(){return new Response("changed")}}');
  const replan = ownerPlan(target,declaration(),changed);
  await assert.rejects(ownerDeploy({...args,plan:replan,artifact:changed}),error => error.message === 'owned-resource-replaced' && error.resource === 'worker:penny-production');
  await assert.rejects(ownerDeploy(args),error => error.message === 'owned-resource-replaced' && error.resource === 'worker:penny-production');
  assert.equal(state.writes.length,writes); assert.equal(JSON.stringify(state.settings),settings);
  assert.deepEqual(await readFile(statePath),bytes);
});

test('a Worker replaced before the first receipt is refused too', async t => {
  const {args,state,fail,foreign} = await setup(t);
  fail('PUT',/^\/workers\/scripts\/penny-production\/schedules$/);
  await assert.rejects(ownerDeploy(args),/provider-http-500/);
  foreign.replaceWorker();
  const writes = state.writes.length;
  await assert.rejects(ownerDeploy(args),error => error.message === 'owned-resource-replaced');
  assert.equal(state.writes.length,writes);
});

test('an interrupted upgrade of the kit\'s own Worker resumes; it is not mistaken for a replacement', async t => {
  const {args,state,fail,foreign,target,statePath} = await setup(t);
  const first = await ownerDeploy(args);
  // Cloudflare can activate an upload before its own read of that version finds it (code 100146).
  const readback = () => { const before = uploads(state); return {test:path => uploads(state) > before && path === `/workers/scripts/penny-production/versions/${state.version.id}`}; };
  const unreadable = {status:404,errors:[{code:100146,message:'The requested Worker version could not be found'}]};
  const quick = {...args,readiness:{sleep:async () => {}}};
  const propagating = build('export default {scheduled() {},fetch(){return new Response("propagating")}}');
  const waited = readback(); fail('GET',waited,unreadable); fail('GET',waited,unreadable);
  const settled = await ownerDeploy({...quick,plan:ownerPlan(target,declaration(),propagating),artifact:propagating});
  assert.equal(settled.receipt.changed,true); assert.equal(settled.receipt.provider.versionId,state.version.id);
  assert.equal(state.calls.filter(x => x.failed && x.path.includes('/versions/')).length,2);
  const next = build('export default {scheduled() {},fetch(){return new Response("v2")}}');
  const plan = ownerPlan(target,declaration({crons:['* * * * *','*/5 * * * *']}),next);
  fail('PUT',/^\/workers\/scripts\/penny-production\/schedules$/);
  await assert.rejects(ownerDeploy({...args,plan,artifact:next}),/provider-http-500/);
  assert.deepEqual((await readOwnerState(statePath,target)).receipt,settled.receipt);
  const {receipt} = await ownerDeploy({...args,plan,artifact:next});
  assert.equal(receipt.changed,true); assert.notEqual(receipt.provider.versionId,first.receipt.provider.versionId);
  assert.deepEqual(state.schedules,[{cron:'* * * * *'},{cron:'*/5 * * * *'}]);
  // Any other readback error fails and leaves the upload without its provider identity.
  const later = build('export default {scheduled() {},fetch(){return new Response("v3")}}');
  const laterArgs = {...quick,plan:ownerPlan(target,declaration({crons:['* * * * *','*/5 * * * *']}),later),artifact:later};
  fail('GET',readback(),{status:404});
  await assert.rejects(ownerDeploy(laterArgs),/provider-http-404/);
  const interrupted = await readOwnerState(statePath,target);
  assert.deepEqual(interrupted.receipt,receipt); assert.equal(interrupted.pendingUpload.provider,undefined);
  assert.equal(interrupted.pendingUpload.fingerprint,state.settings.bindings.find(x => x.name === 'RER_DEPLOY_FINGERPRINT').text);
  // Only a live version carrying that fingerprint as binding and annotation is this deploy's own.
  const live = {settings:state.settings,version:state.version,deployments:state.deployments}, annotation = state.version.annotations['workers/message'];
  for (const replace of [() => { state.version.annotations['workers/message'] = 'Deploy from the dashboard'; }, () => foreign.replaceWorker()]) {
    replace();
    const writes = state.writes.length, bytes = await readFile(statePath);
    await assert.rejects(ownerDeploy(laterArgs),error => error.message === 'owned-resource-replaced' && error.resource === 'worker:penny-production');
    assert.equal(state.writes.length,writes); assert.deepEqual(await readFile(statePath),bytes);
    Object.assign(state,live); state.version.annotations['workers/message'] = annotation;
  }
  const resumed = await ownerDeploy(laterArgs);
  assert.equal(resumed.receipt.changed,true); assert.equal(resumed.receipt.provider.versionId,state.version.id);
  const saved = await readOwnerState(statePath,target);
  assert.deepEqual(saved.receipt,resumed.receipt); assert.equal(saved.pendingUpload,undefined);
});

test('a bucket replaced under the same name is refused, never adopted', async t => {
  const {args,state,foreign,statePath,target} = await setup(t,{creationDates:true});
  await ownerDeploy(args);
  const saved = await readOwnerState(statePath,target);
  assert.match(saved.owned.r2['penny-production-files'].id,/^2026-10-08T/);
  const writes = state.writes.length;
  assert.equal((await ownerDeploy(args)).receipt.changed,false);
  state.buckets.splice(0,1);
  await assert.rejects(ownerDeploy(args),error => error.message === 'owned-resource-missing' && error.resource === 'r2:penny-production-files');
  foreign.r2('penny-production-files');
  await assert.rejects(ownerDeploy(args),error => error.message === 'owned-resource-replaced' && error.resource === 'r2:penny-production-files');
  assert.equal(state.writes.length,writes);
});

test('a state file from before bucket identities were recorded does not refuse the same bucket', async t => {
  const {args,statePath,target} = await setup(t,{creationDates:true});
  await ownerDeploy(args);
  const state = JSON.parse(await readFile(statePath,'utf8')); delete state.owned.r2['penny-production-files'].id;
  await writeFile(statePath,JSON.stringify(state));
  assert.equal((await ownerDeploy(args)).receipt.changed,false);
  assert.equal((await readOwnerState(statePath,target)).owned.r2['penny-production-files'].status,'created');
});

test('an account with no workers.dev subdomain gets a named error before anything is created', async t => {
  const provider = ownerProvider(); t.after(() => provider.close());
  const api = cloudflare(provider);
  provider.fail('GET',/^\/workers\/subdomain$/,{status:404});
  await assert.rejects(ownerTarget(api,{project:'runeditrun/penny',environment:'production'}),error => error.message === 'workers-subdomain-missing');
  const empty = {...provider.fetch && {}, fetch:async (input,init) => new URL(input).pathname.endsWith('/workers/subdomain') ? Response.json({success:true,errors:[],result:{subdomain:null}}) : provider.fetch(input,init)};
  await assert.rejects(ownerTarget(cloudflare({...provider,fetch:empty.fetch}),{project:'runeditrun/penny',environment:'production'}),/workers-subdomain-missing/);
  assert.equal(provider.state.writes.length,0);
  assert.deepEqual(report(new Error('workers-subdomain-missing')),{ok:false,code:'workers-subdomain-missing'});
});

test('a lost response on the first Worker upload resumes when the live Worker carries the recorded fingerprint', async t => {
  const {args,state,fail,statePath,target} = await setup(t);
  fail('PUT',/^\/workers\/scripts\/penny-production$/,{afterApply:true});
  await assert.rejects(ownerDeploy(args),/provider-transport-failed/);
  assert.deepEqual((await readOwnerState(statePath,target)).owned.worker,{status:'pending'});
  assert(state.settings);
  const {receipt} = await ownerDeploy(args);
  assert.equal(receipt.changed,true); assert.equal(uploads(state),2);
  const saved = await readOwnerState(statePath,target);
  assert.deepEqual(saved.owned.worker,{status:'created'}); assert.deepEqual(saved.receipt,receipt);
  assert.equal(state.databases.length,1);
});

test('a pending Worker that does not carry a recorded build is still refused as uncertain', async t => {
  const {args,state,fail,foreign} = await setup(t);
  fail('PUT',/^\/workers\/scripts\/penny-production$/,{afterApply:true});
  await assert.rejects(ownerDeploy(args),/provider-transport-failed/);
  foreign.replaceWorker();
  const writes = state.writes.length;
  await assert.rejects(ownerDeploy(args),error => error.message === 'uncertain-resource-create' && error.resource === 'worker:penny-production');
  assert.equal(state.writes.length,writes);
});

test('a token missing a scope names the scope, not just the status', async t => {
  for (const [method,path,scope] of [['GET',/^\/d1\/database$/,'d1'],['GET',/^\/r2\/buckets$/,'r2'],['GET',/^\/storage\/kv\/namespaces$/,'kv'],['GET',/^\/queues$/,'queues'],
      ['GET',/^\/workers\/scripts\/penny-production\/settings$/,'workers'],['POST',/^\/r2\/buckets$/,'r2'],['PUT',/^\/workers\/scripts\/penny-production$/,'workers']]) {
    await t.test(`${method} ${scope}`, async t => {
      const declared = declaration({kv:[{binding:'CACHE'}],queues:[{binding:'JOBS'}]});
      const {args,state,fail} = await setup(t,{declared});
      for (const status of [401,403]) {
        fail(method,path,{status});
        await assert.rejects(ownerDeploy(args),error => error.message === `token-scope-missing-${scope}` && error.status === status);
        for (const x of state.writes.splice(0)) void x;
        state.kv.splice(0); state.queues.splice(0); state.databases.splice(0); state.buckets.splice(0); state.settings = null;
        await rm(args.statePath,{force:true});
      }
    });
  }
  const provider = ownerProvider(); t.after(() => provider.close());
  provider.fail('GET',/^\/workers\/subdomain$/,{status:403});
  await assert.rejects(ownerTarget(cloudflare(provider),{project:'runeditrun/penny',environment:'production'}),/token-scope-missing-workers/);
  assert.deepEqual(report(new Error('token-scope-missing-d1')),{ok:false,code:'token-scope-missing-d1'});
});

test('a path the kit does not map keeps the plain status code', async () => {
  const denied = Object.assign(new Error('provider-http-403'),{status:403});
  const api = withScopeHints({accountId:'a'.repeat(32),request:async () => { throw denied; },list:async () => { throw denied; },envelope:async () => { throw denied; }});
  await assert.rejects(api.request('/memberships'),error => error.message === 'provider-http-403');
  await assert.rejects(api.list('/queuesandmore'),error => error.message === 'provider-http-403');
  assert.equal(withScopeHints(api),api);
});

test('library errors name no throwaway variable in owner mode', () => {
  for (const options of [{accountId:'nope',token:'test-only'},{accountId:'a'.repeat(32),token:''},{accountId:'a'.repeat(32),token:'bad\ntoken'}]) {
    assert.throws(() => cloudflare(options),error => /^invalid-cloudflare-(account-id|api-token)$/.test(error.message) && !/THROWAWAY/.test(error.message));
  }
});

test('two deploys on one state file cannot overlap; the lock is released afterwards, even after a failure', async t => {
  const {args,state,statePath,fail} = await setup(t);
  const results = await Promise.allSettled([ownerDeploy(args),ownerDeploy(args)]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length,1);
  const rejected = results.find(x => x.status === 'rejected');
  assert.equal(rejected.reason.message,'owner-state-locked');
  assert.equal(await exists(`${statePath}.lock`),false);
  assert.deepEqual(await readdir(join(statePath,'..')),['production.json']);
  assert.equal((await ownerDeploy(args)).receipt.changed,false);
  const next = build('export default {scheduled() {},fetch(){return new Response("v3")}}');
  fail('PUT',/^\/workers\/scripts\/penny-production$/);
  await assert.rejects(ownerDeploy({...args,artifact:next,plan:ownerPlan(args.target,declaration(),next)}),/provider-http-500/);
  assert.equal(await exists(`${statePath}.lock`),false);
  assert.equal(uploads(state),1);
});

test('a lock held by another run refuses before any provider request', async t => {
  const {args,state,statePath} = await setup(t);
  await mkdir(join(statePath,'..'),{recursive:true});
  await writeFile(`${statePath}.lock`,'12345\n');
  const calls = state.calls.length;
  await assert.rejects(ownerDeploy(args),error => error.message === 'owner-state-locked');
  assert.equal(state.calls.length,calls); assert.equal(await exists(statePath),false);
  assert.equal(await readFile(`${statePath}.lock`,'utf8'),'12345\n');
});

test('the owner CLI reports the named codes', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(),'deploy-kit-owner-review-cli-'))); t.after(() => rm(root,{recursive:true,force:true}));
  for (const dir of ['dist/server','dist/client','migrations/core']) await mkdir(join(root,dir),{recursive:true});
  await writeFile(join(root,'dist/server/wrangler.json'),JSON.stringify({main:'index.js',no_bundle:true,rules:[{type:'ESModule',globs:['**/*.js','**/*.mjs']}]}));
  await writeFile(join(root,'dist/server/index.js'),'export default {scheduled() {},fetch(){return new Response("v")}};');
  await writeFile(join(root,'dist/client/index.html'),'<h1>V</h1>');
  await writeFile(join(root,'migrations/core/0001_a.sql'),'CREATE TABLE a(id TEXT PRIMARY KEY);');
  await writeFile(join(root,'deploy.json'),JSON.stringify({version:1,project:'runeditrun/vector',compatibilityDate:'2026-09-08',d1:[{binding:'DB'}]}));
  await writeFile(join(root,'.gitignore'),'dist/\n.rer/\n');
  const git = (...a) => execFileSync('git',['-c','user.email=o@example.test','-c','user.name=O','-c','commit.gpgsign=false',...a],{cwd:root,stdio:'pipe'});
  git('init','-q'); git('add','.'); git('commit','-qm','seed');
  const provider = ownerProvider(); t.after(() => provider.close());
  const argv = ['deploy','--declaration','deploy.json','--environment','production'];
  const env = {CLOUDFLARE_ACCOUNT_ID:provider.accountId,CLOUDFLARE_API_TOKEN:provider.token};
  provider.fail('GET',/^\/workers\/subdomain$/,{status:404});
  await assert.rejects(main(argv,env,{fetch:provider.fetch,cwd:root}),error => report(error).code === 'workers-subdomain-missing');
  provider.fail('GET',/^\/d1\/database$/,{status:403});
  await assert.rejects(main(argv,env,{fetch:provider.fetch,cwd:root}),error => report(error).code === 'token-scope-missing-d1');
  assert.equal(provider.state.writes.length,0);
});
