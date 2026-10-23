import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { cloudflare } from '../provider.mjs';
import { ownerTarget, ownerPlan, ownerDeploy } from '../owner.mjs';
import { hash } from '../validation.mjs';
import { ownerProvider } from './owner-provider.mjs';

const build = text => ({ version:1, source:{sha:hash(text).slice(0,40),tree:'6'.repeat(40)},run:{id:'0',attempt:'1'},main:'index.js',
  modules:[{path:'index.js',base64:Buffer.from(text).toString('base64'),sha256:hash(text)}],assets:[],migrations:[] });
const declaration = {version:1,project:'runeditrun/penny',compatibilityDate:'2026-09-08',r2:[{binding:'FILES'}],crons:['* * * * *']};
async function setup(t, declared = declaration) {
  const provider = ownerProvider({creationDates:true}); t.after(() => provider.close());
  const dir = await realpath(await mkdtemp(join(tmpdir(),'owner-identity-'))); t.after(() => rm(dir,{recursive:true,force:true}));
  const api = cloudflare(provider);
  const target = await ownerTarget(api,{project:declaration.project,environment:'production'});
  const artifact = build('export default {scheduled() {},fetch(){return new Response("first")}}');
  const args = {api,target,artifact,plan:ownerPlan(target,declared,artifact),statePath:join(dir,'state.json'),fetch:provider.fetch};
  return {...provider,args};
}
function change(args) {
  const artifact = build('export default {scheduled() {},fetch(){return new Response("next")}}');
  return {...args,artifact,plan:ownerPlan(args.target,declaration,artifact)};
}

test('Worker ownership checks each receipt identity even if a replacement preserves its fingerprint', async t => {
  for (const field of ['versionId','deploymentId','etag']) await t.test(field, async t => {
    const {args,state} = await setup(t);
    await ownerDeploy(args);
    // Settings and the old fingerprint remain intact; only the provider identity changes.
    if (field === 'versionId') {
      state.version.id = randomUUID(); state.deployments[0].versions[0].version_id = state.version.id;
    } else if (field === 'deploymentId') state.deployments[0].id = randomUUID();
    else state.version.resources.script.etag = 'replacement-etag';
    const bytes = await readFile(args.statePath), writes = state.writes.length;
    await assert.rejects(ownerDeploy(change(args)), error => error.message === 'owned-resource-replaced' && error.resource === 'worker:penny-production');
    assert.equal(state.writes.length,writes);
    assert.deepEqual(await readFile(args.statePath),bytes);
  });
});

test('a replacement of an interrupted successful upload cannot inherit its pending fingerprint', async t => {
  const {args,state,fail} = await setup(t);
  fail('PUT',/^\/workers\/scripts\/penny-production\/schedules$/);
  await assert.rejects(ownerDeploy(args),/provider-http-500/);
  state.deployments[0].id = randomUUID();
  const writes = state.writes.length, bytes = await readFile(args.statePath);
  await assert.rejects(ownerDeploy(args),error => error.message === 'owned-resource-replaced');
  assert.equal(state.writes.length,writes); assert.deepEqual(await readFile(args.statePath),bytes);
});

test('missing workers.dev registration is named for both 404 and an empty successful response', async t => {
  const provider = ownerProvider(); t.after(() => provider.close());
  provider.fail('GET',/^\/workers\/subdomain$/,{status:404});
  await assert.rejects(ownerTarget(cloudflare(provider),{project:declaration.project,environment:'production'}),/workers-subdomain-missing/);
  const fetch = async () => Response.json({success:true,errors:[],result:{subdomain:null}});
  await assert.rejects(ownerTarget(cloudflare({...provider,fetch}),{project:declaration.project,environment:'production'}),/workers-subdomain-missing/);
  assert.equal(provider.state.writes.length,0);
});

test('replaced R2 creation identity refuses an upgrade before any write', async t => {
  const {args,state,foreign} = await setup(t);
  await ownerDeploy(args);
  const saved = JSON.parse(await readFile(args.statePath,'utf8'));
  assert.equal(saved.owned.r2['penny-production-files'].id,state.buckets[0].creation_date);
  state.buckets.splice(0,1); foreign.r2('penny-production-files');
  const writes = state.writes.length;
  await assert.rejects(ownerDeploy(change(args)),error => error.message === 'owned-resource-replaced' && error.resource === 'r2:penny-production-files');
  assert.equal(state.writes.length,writes);
});

test('a lost state file refuses existing resources, then the restored backup permits a no-op', async t => {
  const {args,state} = await setup(t);
  await ownerDeploy(args);
  const bytes = await readFile(args.statePath), writes = state.writes.length;
  await rm(args.statePath);
  await assert.rejects(ownerDeploy(args),error => error.message === 'resource-name-collision' && error.resource === 'worker:penny-production');
  assert.equal(state.writes.length,writes);
  await writeFile(args.statePath,bytes,{mode:0o600});
  assert.equal((await ownerDeploy(args)).receipt.changed,false);
  assert.equal(state.writes.length,writes); assert.deepEqual(await readFile(args.statePath),bytes);
});

test('a state-file lock refuses before any provider request and preserves the other run\'s lock', async t => {
  const {args,state} = await setup(t);
  await writeFile(`${args.statePath}.lock`,'other-run\n');
  const calls = state.calls.length;
  await assert.rejects(ownerDeploy(args),/owner-state-locked/);
  assert.equal(state.calls.length,calls);
  assert.equal(await readFile(`${args.statePath}.lock`,'utf8'),'other-run\n');
});

test('first-upload recovery requires the pending fingerprint as binding and annotation, and remains resumable after another lost response', async t => {
  const {args,state,fail} = await setup(t);
  fail('PUT',/^\/workers\/scripts\/penny-production$/,{afterApply:true});
  await assert.rejects(ownerDeploy(args),/provider-transport-failed/);
  const annotation = state.version.annotations['workers/message'];
  state.version.annotations['workers/message'] = 'Deploy from the dashboard';
  const writes = state.writes.length, bytes = await readFile(args.statePath);
  await assert.rejects(ownerDeploy(change(args)),/uncertain-resource-create/);
  assert.equal(state.writes.length,writes); assert.deepEqual(await readFile(args.statePath),bytes);
  state.version.annotations['workers/message'] = annotation;
  fail('PUT',/^\/workers\/scripts\/penny-production$/,{afterApply:true});
  await assert.rejects(ownerDeploy(change(args)),/provider-transport-failed/);
  assert.equal((await ownerDeploy(change(args))).receipt.changed,true);
  assert.equal((await ownerDeploy(change(args))).receipt.changed,false);
});

test('provider input errors use neutral codes before any request', () => {
  let calls = 0;
  const fetch = async () => { calls++; throw new Error('unexpected request'); };
  assert.throws(() => cloudflare({accountId:'bad',token:'test-only',fetch}),/invalid-cloudflare-account-id/);
  assert.throws(() => cloudflare({accountId:'a'.repeat(32),token:'',fetch}),/invalid-cloudflare-api-token/);
  assert.throws(() => cloudflare({accountId:'a'.repeat(32),token:'bad\ntoken',fetch}),/invalid-cloudflare-api-token/);
  assert.equal(calls,0);
});

test('R2 legacy compatibility does not permit missing D1, KV or Queue ownership identities', async t => {
  for (const [kind,binding] of [['d1','DB'],['kv','CACHE'],['queues','JOBS']]) await t.test(kind,async t => {
    const declared = {...declaration,[kind]:[{binding}]};
    const {args,state} = await setup(t,declared);
    await ownerDeploy(args);
    const saved = JSON.parse(await readFile(args.statePath,'utf8'));
    const name = args.plan[kind][0].name;
    delete saved.owned[kind][name].id;
    await writeFile(args.statePath,JSON.stringify(saved));
    const writes = state.writes.length;
    await assert.rejects(ownerDeploy(args),error => error.message === 'owned-resource-replaced' && error.resource === `${kind}:${name}`);
    assert.equal(state.writes.length,writes);
  });
});

test('a Worker replaced during asset upload is refused immediately before the Worker PUT', async t => {
  const {args,state} = await setup(t);
  await ownerDeploy(args);
  const bytes = await readFile(args.statePath);
  const next = change(args), html = '<h1>Next</h1>';
  next.artifact.assets = [{path:'index.html',base64:Buffer.from(html).toString('base64'),sha256:hash(html)}];
  next.plan = ownerPlan(args.target,declaration,next.artifact);
  let replaced = false;
  const api = {...args.api, async request(path,options) {
    const result = await args.api.request(path,options);
    if (path === '/workers/assets/upload?base64=true') { state.deployments[0].id = randomUUID(); replaced = true; }
    return result;
  }};
  await assert.rejects(ownerDeploy({...next,api}),error => error.message === 'owned-resource-replaced' && error.resource === 'worker:penny-production');
  assert.equal(replaced,true);
  assert.equal(state.writes.filter(x => x.method === 'PUT' && x.path === '/workers/scripts/penny-production').length,1);
  assert.deepEqual(await readFile(args.statePath),bytes);
});
