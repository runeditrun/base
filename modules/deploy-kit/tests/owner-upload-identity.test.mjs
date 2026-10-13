import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cloudflare } from '../provider.mjs';
import { ownerDeploy, ownerPlan, ownerTarget } from '../owner.mjs';
import { hash } from '../validation.mjs';
import { ownerProvider } from './owner-provider.mjs';

const declaration = {version:1,project:'runeditrun/penny',compatibilityDate:'2026-09-08',
  r2:[{binding:'FILES'}],crons:['* * * * *']};
const kinds = ['d1','r2','kv','queues'];
const uploads = state => state.writes.filter(x => x.method === 'PUT' && x.path === '/workers/scripts/penny-production').length;
const replaced = error => error.message === 'owned-resource-replaced';

function build(text = 'first') {
  const source = `export default {scheduled() {},fetch(){return new Response(${JSON.stringify(text)})}}`;
  const html = `<h1>${text}</h1>`;
  return {version:1,source:{sha:hash(source).slice(0,40),tree:'6'.repeat(40)},run:{id:'0',attempt:'1'},main:'index.js',
    modules:[{path:'index.js',base64:Buffer.from(source).toString('base64'),sha256:hash(source)}],
    assets:[{path:'index.html',base64:Buffer.from(html).toString('base64'),sha256:hash(html)}],migrations:[]};
}
async function setup(t, declared = declaration) {
  const dir = await realpath(await mkdtemp(join(tmpdir(),'deploy-kit-owner-upload-identity-')));
  t.after(() => rm(dir,{recursive:true,force:true}));
  const provider = ownerProvider({creationDates:true});
  t.after(() => provider.close());
  const api = cloudflare(provider);
  const target = await ownerTarget(api,{project:declaration.project,environment:'production'});
  const artifact = build();
  return {...provider,args:{api,target,artifact,plan:ownerPlan(target,declared,artifact),statePath:join(dir,'state.json'),fetch:provider.fetch}};
}
function upgrade(args, declared = declaration) {
  const artifact = build('next');
  return {...args,artifact,plan:ownerPlan(args.target,declared,artifact)};
}

// Replacing a resource during upload must refuse the in-flight upgrade.
test('R2 replaced during asset upload must be refused before the Worker PUT', async t => {
  const {args,state,foreign} = await setup(t);
  await ownerDeploy(args);
  const bytes = await readFile(args.statePath), count = uploads(state);
  const bindings = structuredClone(state.settings.bindings);
  const originalIdentity = state.buckets[0].creation_date;
  let replacementIdentity, writesAtReplacement, healthCalls = 0;
  const api = {...args.api,async request(path,options) {
    const result = await args.api.request(path,options);
    if (path === '/workers/assets/upload?base64=true') {
      state.buckets.splice(0,1); foreign.r2('penny-production-files');
      replacementIdentity = state.buckets[0].creation_date;
      writesAtReplacement = state.writes.length;
    }
    return result;
  }};
  let error;
  try { await ownerDeploy({...upgrade(args),api,fetch:async (...parameters) => {
    healthCalls++; return args.fetch(...parameters);
  }}); } catch (caught) { error = caught; }
  assert(replacementIdentity && replacementIdentity !== originalIdentity);
  // The following run already refused on the old implementation; the in-flight run must too.
  await assert.rejects(ownerDeploy(upgrade(args)),replaced);
  assert.equal(error?.message,'owned-resource-replaced','the in-flight upgrade accepted and bound a replaced bucket');
  assert.equal(error.resource,'r2:penny-production-files');
  assert.equal(uploads(state),count);
  assert.equal(state.writes.length,writesAtReplacement);
  assert.deepEqual(state.settings.bindings,bindings);
  assert.deepEqual(await readFile(args.statePath),bytes);
  assert.equal(healthCalls,0);
  await assert.rejects(access(`${args.statePath}.lock`),{code:'ENOENT'});
});

function replaceResource(state, foreign, kind, name) {
  const rows = {d1:state.databases,r2:state.buckets,kv:state.kv,queues:state.queues}[kind];
  const key = {d1:'name',r2:'name',kv:'title',queues:'queue_name'}[kind];
  const [original] = rows.splice(rows.findIndex(row => row[key] === name),1);
  if (kind === 'd1') original.db.close();
  foreign[kind](name);
  const identity = {d1:'uuid',r2:'creation_date',kv:'id',queues:'queue_id'}[kind];
  assert.notEqual(rows.at(-1)[identity],original[identity]);
}

for (const kind of ['worker',...kinds.filter(kind => kind !== 'r2')]) {
  test(`${kind} replaced during asset upload is refused before the Worker PUT`, async t => {
    const declared = {...declaration,...(kind === 'worker' ? {} : {[kind]:[{binding:'EXTRA'}]})};
    const {args,state,foreign} = await setup(t,declared);
    await ownerDeploy(args);
    const bytes = await readFile(args.statePath), count = uploads(state);
    const name = kind === 'worker' ? args.plan.worker : args.plan[kind][0].name;
    let settingsAtReplacement, writesAtReplacement, healthCalls = 0;
    const api = {...args.api,async request(path,options) {
      const result = await args.api.request(path,options);
      if (path === '/workers/assets/upload?base64=true') {
        if (kind === 'worker') foreign.replaceWorker();
        else replaceResource(state,foreign,kind,name);
        settingsAtReplacement = structuredClone(state.settings);
        writesAtReplacement = state.writes.length;
      }
      return result;
    }};
    await assert.rejects(ownerDeploy({...upgrade(args,declared),api,fetch:async (...parameters) => {
      healthCalls++; return args.fetch(...parameters);
    }}),error => replaced(error) && error.resource === `${kind}:${name}`);
    assert(settingsAtReplacement,'the replacement occurred after preflight');
    assert.equal(uploads(state),count);
    assert.equal(state.writes.length,writesAtReplacement);
    assert.deepEqual(state.settings,settingsAtReplacement);
    assert.deepEqual(await readFile(args.statePath),bytes);
    assert.equal(healthCalls,0);
    await assert.rejects(access(`${args.statePath}.lock`),{code:'ENOENT'});
  });
}

for (const kind of kinds) {
  test(`the final guard checks saved ${kind} identities omitted from the upgrade plan`, async t => {
    const declared = {...declaration,[kind]:[{binding:'EXTRA'}]};
    const {args,state,foreign} = await setup(t,declared);
    await ownerDeploy(args);
    const bytes = await readFile(args.statePath), count = uploads(state);
    const name = args.plan[kind][0].name;
    const nextDeclaration = {...declared,[kind]:[]};
    let writesAtReplacement;
    const api = {...args.api,async request(path,options) {
      const result = await args.api.request(path,options);
      if (path === '/workers/assets/upload?base64=true') {
        replaceResource(state,foreign,kind,name);
        writesAtReplacement = state.writes.length;
      }
      return result;
    }};
    await assert.rejects(ownerDeploy({...upgrade(args,nextDeclaration),api}),
      error => replaced(error) && error.resource === `${kind}:${name}`);
    assert.notEqual(writesAtReplacement,undefined);
    assert.equal(uploads(state),count);
    assert.equal(state.writes.length,writesAtReplacement);
    assert.deepEqual(await readFile(args.statePath),bytes);
  });
}
