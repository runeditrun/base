import test from 'node:test';
import { caseRow, caseRows } from './fold-case.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, stat, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cloudflare, ownerWorkerName, ownerResourceName, ownerTarget, ownerPlan, ownerDeploy, ownerHealth, readOwnerState } from '../index.mjs';
import { hash, validatePlan } from '../validation.mjs';
import { renderConfig } from '../render.mjs';
import { ownerProvider } from './owner-provider.mjs';
import { ownerSecret } from '../owner-secret.mjs';
import { ownerRemove } from '../owner-remove.mjs';
import { settleOwnerState, writeOwnerState } from '../owner.mjs';

const reconcileCaseRows = [];
const reconcileCase = (name, run) => reconcileCaseRows.push({name,run});
const ownershipCaseRows = [];
const ownershipCase = (name, run) => ownershipCaseRows.push({name,run});
const settlementCaseRows = [];
const settlementCase = (name, run) => settlementCaseRows.push({name,run});

const source = 'export default {scheduled() {},fetch(){return new Response("ok")}}';
const sql = 'CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT NOT NULL);';
const artifact = {version:1,source:{sha:'5'.repeat(40),tree:'6'.repeat(40)},run:{id:'0',attempt:'1'},main:'index.js',
  modules:[{path:'index.js',base64:Buffer.from(source).toString('base64'),sha256:hash(source)}],
  assets:[{path:'index.html',base64:Buffer.from('<h1>Owner</h1>').toString('base64'),sha256:hash('<h1>Owner</h1>')}],
  migrations:[{binding:'DB',name:'0001_notes.sql',sql,sha256:hash(sql)}]};
const declaration = () => ({version:1,project:'runeditrun/penny',compatibilityDate:'2026-09-08',compatibilityFlags:['nodejs_compat'],
  d1:[{binding:'DB'}],r2:[{binding:'FILES'}],kv:[{binding:'CACHE'}],
  queues:[{binding:'JOBS',consumer:{batch_size:10,max_retries:3},deadLetterQueue:'JOBS_DEAD'},{binding:'JOBS_DEAD'}],
  durableObjects:[{binding:'ROOM',className:'Room',storage:'sqlite'}],
  secrets:[{binding:'AUTH_SECRET',environment:'AUTH_SECRET'}],crons:['* * * * *'],vars:{MAIL_PROVIDER:'sendgrid'},originVar:'APP_ORIGIN'});

async function setup(t, {environment = 'production', build = artifact, declared = declaration()} = {}) {
  const provider = ownerProvider(); t.after(() => provider.close());
  const dir = await realpath(await mkdtemp(join(tmpdir(),'deploy-kit-owner-'))); t.after(() => rm(dir,{recursive:true,force:true}));
  const api = cloudflare(provider);
  const target = await ownerTarget(api,{project:'runeditrun/penny',environment});
  const plan = ownerPlan(target,declared,build);
  const statePath = join(dir,'state',`${environment}.json`);
  return {...provider,api,target,plan,statePath,args:{api,target,plan,artifact:build,statePath,env:{AUTH_SECRET:'test-only-auth-value'},fetch:provider.fetch}};
}
const posts = (state, path) => state.writes.filter(x => x.method === 'POST' && x.path === path).length;
const exists = path => access(path).then(() => true,() => false);

test('names derive from the project id and the owner environment only', async t => {
  await caseRows(t, [['independent checks', async t => {
  const {plan,target} = await setup(t);
  assert.equal(target.worker,'penny-production');
  assert.equal(target.origin,'https://penny-production.fixture-account.workers.dev');
  assert.deepEqual([plan.d1[0].name,plan.r2[0].name,plan.kv[0].name,...plan.queues.map(x => x.name)],
    ['penny-production-db','penny-production-files','penny-production-cache','penny-production-jobs','penny-production-jobs-dead']);
  assert.equal(plan.queues[0].deadLetterQueue,'penny-production-jobs-dead');
  assert.equal(plan.vars.APP_ORIGIN,target.origin);
  assert.deepEqual(plan.d1[0].migrations,[{name:'0001_notes.sql',sql,sha256:hash(sql)}]);
  assert.equal(ownerWorkerName('penny','staging'),'penny-staging');
  assert.equal(ownerResourceName('penny-staging','JOBS_DEAD'),'penny-staging-jobs-dead');
  let rowAt57 = 0;
  for (const [project,environment] of [['runeditrun/penny','Production'],['runeditrun/penny','prod-'],['runeditrun/Penny','production'],['../penny','production'],['runeditrun/penny','x'.repeat(33)],['runeditrun/'+'p'.repeat(50),'production-environment']])
    {
    await caseRow(t, 'table at line 57 row ' + rowAt57++, async () => {
assert.throws(() => ownerWorkerName(project,environment),/invalid-owner|too-long/);
    });
  }
  await caseRow(t, 'following assertion at line 59', async () => { assert.throws(() => ownerPlan(target,{...declaration(),d1:[{binding:'DB',name:'chosen-name'}]},artifact),/invalid-owner-declaration/); });
  await caseRow(t, 'following assertion at line 60', async () => { assert.throws(() => ownerPlan(target,{...declaration(),project:'runeditrun/other'},artifact),/owner-project-mismatch/); });
  await caseRow(t, 'following assertion at line 61', async () => { assert.throws(() => ownerPlan(target,{...declaration(),d1:[]},artifact),/undeclared-migration-binding/); });
  }]]);
});

reconcileCase('first deploy creates every declared resource under the owner account, migrates and passes health', async t => {
  const {args,state,statePath,target} = await setup(t);
  const {receipt,created} = await ownerDeploy(args);
  assert.equal(receipt.changed,true);
  assert.deepEqual(created,['d1:penny-production-db','r2:penny-production-files','kv:penny-production-cache','queues:penny-production-jobs','queues:penny-production-jobs-dead']);
  assert.deepEqual(state.databases.map(x => x.name),['penny-production-db']);
  assert.deepEqual(state.buckets.map(x => x.name),['penny-production-files']);
  assert.deepEqual(state.kv.map(x => x.title),['penny-production-cache']);
  assert.deepEqual(state.queues.map(x => x.queue_name),['penny-production-jobs','penny-production-jobs-dead']);
  assert.deepEqual(state.namespaces.map(x => [x.script,x.class,x.use_sqlite]),[['penny-production','Room',true]]);
  assert.deepEqual(state.schedules,[{cron:'* * * * *'}]);
  assert.equal(state.queues[0].consumers[0].dead_letter_queue,'penny-production-jobs-dead');
  assert.equal(state.databases[0].db.prepare("SELECT name FROM sqlite_master WHERE name='notes'").get().name,'notes');
  assert(state.settings.bindings.some(x => x.type === 'kv_namespace' && x.name === 'CACHE' && x.namespace_id === state.kv[0].id));
  assert(state.settings.bindings.some(x => x.type === 'plain_text' && x.name === 'APP_ORIGIN' && x.text === target.origin));
  assert.equal(receipt.origin,target.origin);
  const saved = await readOwnerState(statePath,target);
  assert.deepEqual(saved.owned,{worker:{status:'created'},d1:{'penny-production-db':{status:'created',id:state.databases[0].uuid}},r2:{'penny-production-files':{status:'created',id:state.buckets[0].creation_date}},
    kv:{'penny-production-cache':{status:'created',id:state.kv[0].id}},queues:Object.fromEntries(state.queues.map(x => [x.queue_name,{status:'created',id:x.queue_id}]))});
  assert.deepEqual(saved.receipt,receipt);
  assert.equal((await stat(statePath)).mode & 0o777,0o600);
  assert(!(await readFile(statePath,'utf8')).includes('test-only-auth-value'));
});

reconcileCase('a re-run of the same build changes nothing: no provider writes and a byte-identical state file', async t => {
  await caseRows(t, [['independent checks', async t => {
  const {args,state,statePath,api,plan,target} = await setup(t);
  await ownerDeploy(args);
  state.databases[0].db.exec("INSERT INTO notes(body) VALUES ('owner data')");
  const writes = state.writes.length, bytes = await readFile(statePath), secret = state.secrets[0].value;
  let rowAt93 = 0;
  for (let i = 0; i < 2; i++) {
    await caseRow(t, 'table at line 93 row ' + rowAt93++, async () => {

    const {receipt,created} = await ownerDeploy({...args,env:{AUTH_SECRET:'test-only-new-value-is-not-written'}});
    assert.equal(receipt.changed,false); assert.deepEqual(created,[]);
      });
  }
  await caseRow(t, 'following assertion at line 97', async () => { assert.equal(state.writes.length,writes); });
  await caseRow(t, 'following assertion at line 98', async () => { assert.deepEqual(await readFile(statePath),bytes); });
  await caseRow(t, 'following assertion at line 99', async () => { assert.equal(state.secrets[0].value,secret); });
  await caseRow(t, 'following assertion at line 100', async () => { assert.equal(state.databases[0].db.prepare('SELECT body FROM notes').get().body,'owner data'); });
  await caseRow(t, 'following assertion at line 101', async () => { assert.equal((await ownerHealth({api,target,plan,statePath,fetch:args.fetch})).ok,true); });
  await caseRow(t, 'following assertion at line 102', async () => { assert.equal(state.writes.length,writes); });
  }]]);
});

reconcileCase('a resource failure stops the run; the next run resumes without creating anything twice', async t => {
  const {args,state,statePath,target,fail} = await setup(t);
  fail('POST',/^\/r2\/buckets$/);
  await assert.rejects(ownerDeploy(args),/provider-http-500/);
  let saved = await readOwnerState(statePath,target);
  assert.equal(saved.owned.d1['penny-production-db'].status,'created');
  assert.deepEqual(saved.owned.r2,{'penny-production-files':{status:'pending'}});
  assert.equal(saved.owned.worker,null); assert.equal(state.settings,null);
  const {receipt,created} = await ownerDeploy(args);
  assert.equal(receipt.changed,true);
  assert.deepEqual(created,['r2:penny-production-files','kv:penny-production-cache','queues:penny-production-jobs','queues:penny-production-jobs-dead']);
  assert.equal(posts(state,'/d1/database'),1); assert.equal(posts(state,'/r2/buckets'),1);
  assert.equal(state.databases.length,1); assert.equal(state.buckets.length,1);
  saved = await readOwnerState(statePath,target);
  assert.equal(saved.owned.r2['penny-production-files'].status,'created');
  const writes = state.writes.length;
  assert.equal((await ownerDeploy(args)).receipt.changed,false);
  assert.equal(state.writes.length,writes);
});

reconcileCase('a failed Worker upload resumes with one upload; a failure after upload re-uploads without a receipt', async t => {
  const {args,state,statePath,target,fail} = await setup(t);
  fail('PUT',/^\/workers\/scripts\/penny-production$/);
  await assert.rejects(ownerDeploy(args),/provider-http-500/);
  assert.deepEqual((await readOwnerState(statePath,target)).owned.worker,{status:'pending'});
  assert.equal(state.settings,null);
  fail('PUT',/^\/workers\/scripts\/penny-production\/schedules$/);
  await assert.rejects(ownerDeploy(args),/provider-http-500/);
  let saved = await readOwnerState(statePath,target);
  assert.deepEqual(saved.owned.worker,{status:'created'}); assert.equal(saved.receipt,null);
  const uploads = () => state.writes.filter(x => x.method === 'PUT' && x.path === '/workers/scripts/penny-production').length;
  assert.equal(uploads(),1);
  const {receipt} = await ownerDeploy(args);
  assert.equal(receipt.changed,true); assert.equal(uploads(),2);
  assert.deepEqual(state.schedules,[{cron:'* * * * *'}]);
  assert.equal(posts(state,'/d1/database'),1); assert.equal(state.queues.length,2);
  saved = await readOwnerState(statePath,target);
  assert.deepEqual(saved.receipt,receipt);
});

ownershipCase('a lost create response is an uncertain outcome: the resume refuses before any write', async t => {
  const {args,state,fail} = await setup(t);
  fail('POST',/^\/storage\/kv\/namespaces$/,{afterApply:true});
  await assert.rejects(ownerDeploy(args),/provider-transport-failed/);
  assert.equal(state.kv.length,1);
  const writes = state.writes.length;
  await assert.rejects(ownerDeploy(args),error => error.message === 'uncertain-resource-create' && error.resource === 'kv:penny-production-cache');
  assert.equal(state.writes.length,writes);
});

ownershipCase('a same-named resource the kit did not create is refused, never adopted, before any write', async t => {
  await caseRows(t, ([['d1','penny-production-db'],['r2','penny-production-files'],['kv','penny-production-cache'],['queues','penny-production-jobs-dead'],['worker','penny-production']]).map(([kind,name]) => [kind, async t => {
      const {args,state,statePath,foreign} = await setup(t);
      foreign[kind](name);
      const before = JSON.stringify({d:state.databases.map(x => x.name),b:state.buckets,k:state.kv,q:state.queues});
      await assert.rejects(ownerDeploy(args),error => error.message === 'resource-name-collision' && error.resource === `${kind}:${name}`);
      assert.equal(state.writes.length,0);
      assert.equal(state.calls.filter(x => x.method !== 'GET').length,0);
      assert.equal(JSON.stringify({d:state.databases.map(x => x.name),b:state.buckets,k:state.kv,q:state.queues}),before);
      assert.equal(await exists(statePath),false);
    }]));
});

ownershipCase('an owned resource that disappeared or was replaced is refused, never recreated or adopted', async t => {
  const {args,state,foreign} = await setup(t);
  await ownerDeploy(args);
  const writes = state.writes.length;
  const [database] = state.databases.splice(0,1);
  await assert.rejects(ownerDeploy(args),error => error.message === 'owned-resource-missing' && error.resource === 'd1:penny-production-db');
  foreign.d1('penny-production-db');
  await assert.rejects(ownerDeploy(args),error => error.message === 'owned-resource-replaced' && error.resource === 'd1:penny-production-db');
  assert.equal(state.writes.length,writes);
  database.db.close();
});

ownershipCase('state from another account, project or environment is refused', async t => {
  const {args,statePath} = await setup(t);
  await ownerDeploy(args);
  const other = await setup(t,{environment:'staging'});
  await assert.rejects(ownerDeploy({...other.args,statePath}),/owner-state-target-mismatch/);
  await assert.rejects(ownerDeploy({...args,target:{...args.target,accountId:'b'.repeat(32)}}),/owner-account-mismatch/);
  await assert.rejects(ownerDeploy({...args,plan:{...args.plan,d1:[{...args.plan.d1[0],name:'chosen-db'}]}}),/owner-plan-name-mismatch/);
});

test('a missing first-deploy secret fails before any resource is created', async t => {
  const {args,state,statePath} = await setup(t);
  await assert.rejects(ownerDeploy({...args,env:{}}),/missing-secret-AUTH_SECRET/);
  assert.equal(state.writes.length,0); assert.equal(await exists(statePath),false);
});

reconcileCase('a later release that declares a new resource creates only that resource', async t => {
  const first = await setup(t);
  await ownerDeploy(first.args);
  const declared = declaration(); declared.kv.push({binding:'SESSIONS'});
  const plan = ownerPlan(first.target,declared,artifact);
  const {receipt,created} = await ownerDeploy({...first.args,plan});
  assert.deepEqual(created,['kv:penny-production-sessions']);
  assert.equal(receipt.changed,true);
  assert.equal(posts(first.state,'/d1/database'),1);
  assert(first.state.settings.bindings.some(x => x.type === 'kv_namespace' && x.name === 'SESSIONS'));
});

test('owner-account mode never reads throwaway-controller variables', async () => {
  for (const file of ['owner.mjs','owner-cli.mjs']) {
    const text = await readFile(new URL(`../${file}`,import.meta.url),'utf8');
    assert(!/CF_THROWAWAY|RER_DEPLOY_|seedproof/.test(text),file);
  }
});

test('KV is validated like other named resources, and plans without KV keep their earlier config shape', async t => {
  const {plan} = await setup(t);
  assert.throws(() => validatePlan({...plan,kv:[{binding:'CACHE',name:'Bad_Name'}]}),/invalid-resource-name/);
  assert.throws(() => validatePlan({...plan,kv:[{binding:'DB',name:'penny-production-cache'}]}),/duplicate-or-invalid-binding/);
  assert.throws(() => validatePlan({...plan,kv:[{binding:'A',name:'same-name'},{binding:'B',name:'same-name'}]}),/duplicate-resource-name/);
  assert.throws(() => validatePlan({...plan,kv:{}}),/invalid-plan-resources/);
  const {kv,...withoutKv} = plan;
  const resources = {d1:[],r2:[],queues:[]};
  assert.equal(Object.hasOwn(renderConfig(validatePlan(withoutKv),resources,'a'.repeat(32),'1'.repeat(40),'f','index.js'),'kv_namespaces'),false);
  assert.deepEqual(renderConfig(plan,{...resources,kv:[{binding:'CACHE',name:kv[0].name,id:'c'.repeat(32)}]},'a'.repeat(32),'1'.repeat(40),'f','index.js').kv_namespaces,[{binding:'CACHE',id:'c'.repeat(32)}]);
});

settlementCase('secret writes settle ambiguous answers within their window and clear refusals before later dashboard changes', async t => {
  const answers = [{afterApply:true,status:504}, {afterApply:true,status:524}, {afterApply:true},
    {status:500}, {transport:true}, {status:403}, {status:200}, {status:500,concurrent:true}, {transport:true,concurrent:true}];
  await caseRows(t, ([true,false]).flatMap((present) => (answers.filter(answer => present || !answer.concurrent)).map((answer) => [`${present ? 'set' : 'unset'} ${JSON.stringify(answer)}`, async t => {
    const fixture = await setup(t), {args,api,target,statePath,state,fail} = fixture;
    await ownerDeploy(args);
    const before = await readOwnerState(statePath,target);
    let elapsed = 0, sleeps = 0, intent, foreignVersion, puts = 0;
    const observed = {...api, async request(path, options) {
      if (options?.method === (present ? 'PUT' : 'DELETE') && path.includes('/secrets')) intent = (await readOwnerState(statePath,target)).pendingSecret;
      if (options?.method === 'PUT' && path.endsWith('/secrets')) puts++;
      try { return await api.request(path,options); }
      finally {
        if (answer.concurrent && !foreignVersion && options?.method === 'PUT' && path.endsWith('/secrets')) {
          await api.request(path,{method:'PUT',body:{name:'OTHER',text:'test-only-foreign',type:'secret_text'}});
          foreignVersion = state.version.id;
        }
      }
    }};
    fail(present ? 'PUT' : 'DELETE', present ? /\/secrets$/ : /\/secrets\/AUTH_SECRET$/, answer);
    const change = ownerSecret({api:observed,target,statePath,fetch:args.fetch,changes:[{binding:'AUTH_SECRET',...(present ? {value:'test-only-rotated'} : {})}],
      windowMs:6000,clock:() => elapsed,sleep:async ms => { elapsed += ms; sleeps++; }});
    if (answer.afterApply) await change;
    else await assert.rejects(change, /provider|token-scope-missing/);
    assert.equal(intent.versionId,before.receipt.provider.versionId, 'intent is anchored before the provider write');
    const saved = await readOwnerState(statePath,target);
    assert.equal(saved.pendingSecret !== undefined,!!answer.concurrent);
    assert.deepEqual(intent.names,[]);
    if (answer.afterApply) {
      assert.equal(saved.receipt.provider.versionId,state.version.id);
      assert.equal(state.secrets.some(item => item.name === 'AUTH_SECRET'),present);
      assert.equal((saved.retiredSecrets ?? []).includes('AUTH_SECRET'),!present);
      if (present) {
        assert.equal(state.secrets.find(item => item.name === 'AUTH_SECRET').value,'test-only-rotated');
        assert.ok(puts >= 2, 'an ambiguous rotation re-PUTs the same value before reporting success');
      }
    } else {
      assert.deepEqual(saved.receipt,before.receipt);
      assert.equal(state.secrets.find(item => item.name === 'AUTH_SECRET').value,args.env.AUTH_SECRET);
      assert.equal(sleeps > 0,answer.status === 500 || !!answer.transport, 'only ambiguous failures wait for readback');
    }
    if (answer.concurrent) assert.equal(puts,1, 'a foreign added name forbids the confirming PUT');
    await api.request(`/workers/scripts/${target.worker}/secrets`,{method:'PUT',body:{name:'DASHBOARD_ADDED',text:'test-only-foreign',type:'secret_text'}});
    const writes = state.writes.length;
    await assert.rejects(ownerDeploy(args),/owned-resource-replaced/);
    await assert.rejects(ownerRemove({api,target,statePath}),/owned-resource-replaced/);
    assert.equal(state.writes.length,writes, 'neither command changes the foreign Worker or its resources');
  }])));
});

settlementCase('interrupted secret settlement requires its recorded immediate successor, and a new upload clears old intent', async t => {
  await caseRows(t, [['independent checks', async t => {
  await caseRows(t, (['inspect','deploy','secret','remove']).map((command) => [`unchanged preflight ${command}`, async t => {
    const {args,api,target,statePath,state} = await setup(t);
    await ownerDeploy(args);
    const saved = await readOwnerState(statePath,target);
    saved.pendingSecret = {binding:'AUTH_SECRET',present:false,versionId:saved.receipt.provider.versionId};
    await writeOwnerState(statePath,saved);
    if (command === 'inspect') {
      const current = await settleOwnerState({api,target,statePath});
      assert.equal(current.pendingSecret,undefined);
      assert.deepEqual(current.receipt,saved.receipt);
      assert.equal(current.retiredSecrets,undefined, 'an abandoned unset never retires a live binding');
    } else if (command === 'deploy') assert.equal((await ownerDeploy(args)).receipt.changed,false);
    else if (command === 'secret') await ownerSecret({api,target,statePath,fetch:args.fetch,changes:[{binding:'AUTH_SECRET',value:'test-only-rotated'}]});
    else {
      await ownerRemove({api,target,statePath});
      assert.equal(state.settings,null);
      return;
    }
    assert.equal((await readOwnerState(statePath,target)).pendingSecret,undefined);
    await api.request(`/workers/scripts/${target.worker}/secrets`,{method:'PUT',body:{name:'OTHER',text:'test-only-foreign',type:'secret_text'}});
    const writes = state.writes.length;
    await assert.rejects(ownerDeploy(args),/owned-resource-replaced/);
    await assert.rejects(ownerRemove({api,target,statePath}),/owned-resource-replaced/);
    assert.equal(state.writes.length,writes);
  }]));
  await caseRows(t, (['immediate','later-change','stale-receipt','new-upload']).map((scenario) => [scenario, async t => {
    const {args,api,target,statePath,state} = await setup(t);
    await ownerDeploy(args);
    const saved = await readOwnerState(statePath,target);
    saved.pendingSecret = {binding:'AUTH_SECRET',present:true,versionId:saved.receipt.provider.versionId};
    await writeOwnerState(statePath,saved);
    const path = `/workers/scripts/${target.worker}/secrets`;
    if (scenario !== 'new-upload') await api.request(path,{method:'PUT',body:{name:'AUTH_SECRET',text:'test-only-rotated',type:'secret_text'}});
    if (scenario === 'later-change' || scenario === 'stale-receipt') {
      if (scenario === 'stale-receipt') {
        saved.receipt.provider = {versionId:state.version.id,deploymentId:state.deployments[0].id,etag:state.version.resources.script.etag};
        await writeOwnerState(statePath,saved);
      }
      await api.request(path,{method:'PUT',body:{name:'DASHBOARD_ADDED',text:'test-only-foreign',type:'secret_text'}});
      const writes = state.writes.length;
      await settleOwnerState({api,target,statePath});
      await assert.rejects(ownerDeploy(args),/owned-resource-replaced/);
      await assert.rejects(ownerRemove({api,target,statePath}),/owned-resource-replaced/);
      assert.equal(state.writes.length,writes);
    } else {
      if (scenario === 'immediate') {
        await settleOwnerState({api,target,statePath});
        const settled = await readOwnerState(statePath,target);
        assert.equal(settled.receipt.provider.versionId,state.version.id);
        assert.equal((await ownerDeploy(args)).receipt.changed,false);
      } else {
        const changed = {...artifact,source:{...artifact.source,sha:'7'.repeat(40)}};
        const result = await ownerDeploy({...args,artifact:changed,plan:ownerPlan(target,declaration(),changed)});
        assert.equal(result.receipt.changed,true);
      }
      assert.equal((await readOwnerState(statePath,target)).pendingSecret,undefined);
    }
  }]));
  }]]);
});

settlementCase('secret settlement polls delayed or failed reads, preserves unconfirmed intent and refuses drift', async t => {
  const scenarios = ['read-503','read-reset','lag','unsettled','unavailable','active-lag','active-lag-reset','all-reads-lag','wrong-presence','script-drift','two-versions',
    'lost-response','applied-524','applied-504','repeat-unsettled','repeat-read-failed','repeat-refused','repeat-foreign','repeat-lost-response','repeat-later-change'];
  await caseRows(t, ([true,false]).flatMap((present) => (scenarios.filter(name => present || !name.startsWith('repeat-'))).map((scenario) => [`${present ? 'set' : 'unset'} ${scenario}`, async t => {
    const {args,api,target,statePath,state,foreign,fail} = await setup(t);
    await ownerDeploy(args);
    const before = await readOwnerState(statePath,target);
    const deployments = await api.request(`/workers/scripts/${target.worker}/deployments`);
    let writing = false, reads = 0, elapsed = 0, attempts = 0;
    const ambiguous = ['lost-response','applied-524','applied-504'].includes(scenario);
    if (ambiguous || scenario.startsWith('repeat-') || scenario === 'active-lag-reset') fail(present ? 'PUT' : 'DELETE', /\/secrets(?:\/AUTH_SECRET)?$/, {
      afterApply:true, ...(['lost-response','active-lag-reset'].includes(scenario) ? {} : {status:scenario === 'applied-524' ? 524 : 504})
    });
    const observed = {...api, async request(path, options) {
      if (options?.method === (present ? 'PUT' : 'DELETE') && path.includes('/secrets')) {
        writing = true; attempts++;
        if (attempts === 2) {
          if (scenario === 'repeat-refused') fail('PUT', /\/secrets$/, {status:403});
          if (scenario === 'repeat-foreign') fail('PUT', /\/secrets$/, {status:500});
          if (scenario === 'repeat-lost-response') fail('PUT', /\/secrets$/, {afterApply:true});
        }
        let result;
        try { result = await api.request(path,options); }
        finally {
          if (scenario === 'repeat-foreign' && attempts === 2) await api.request(path,{method:'PUT',body:{name:'OTHER',text:'test-only-foreign',type:'secret_text'}});
        }
        if (scenario === 'script-drift') foreign.replaceWorker();
        if (scenario === 'two-versions' || scenario === 'repeat-later-change' && attempts === 2) await api.request(`/workers/scripts/${target.worker}/secrets`,{method:'PUT',body:{name:'OTHER',text:'test-only-foreign',type:'secret_text'}});
        return result;
      }
      if (writing && ['active-lag','active-lag-reset','all-reads-lag'].includes(scenario) && path.endsWith('/deployments')) return deployments;
      if (writing && path.endsWith('/versions')) {
        if (scenario === 'unavailable' || ambiguous || scenario === 'repeat-read-failed' && attempts > 1) throw Object.assign(new Error('provider-http-503'),{status:503});
        if (scenario === 'read-503' && reads++ === 0) throw Object.assign(new Error('provider-http-503'),{status:503});
        if (scenario === 'read-reset' && reads++ === 0) throw new Error('provider-transport-failed');
        if (['unsettled','all-reads-lag'].includes(scenario) || scenario === 'repeat-unsettled' && attempts > 1 || scenario === 'lag' && reads++ < 2) return {items:[{id:before.receipt.provider.versionId}]};
      }
      if (writing && scenario === 'wrong-presence' && path.endsWith('/secrets')) return present ? [] : [{name:'AUTH_SECRET',type:'secret_text'}];
      return api.request(path,options);
    }};
    const change = ownerSecret({api:observed,target,statePath,fetch:args.fetch,changes:[{binding:'AUTH_SECRET',...(present ? {value:'test-only-rotated'} : {})}],
      windowMs:6000,clock:() => elapsed,sleep:async ms => { elapsed += ms; }});
    if (['read-503','read-reset','lag'].includes(scenario)) {
      await change;
      assert.ok(elapsed > 0, 'settlement waited for the provider readback');
      assert.equal((await readOwnerState(statePath,target)).receipt.provider.versionId,state.version.id);
    } else {
      await assert.rejects(change,/secret-change-unsettled|provider|token-scope-missing/);
      assert.deepEqual((await readOwnerState(statePath,target)).receipt,before.receipt);
      if (!['script-drift','two-versions','repeat-later-change','repeat-foreign'].includes(scenario)) {
        const pending = (await readOwnerState(statePath,target)).pendingSecret;
        assert.equal(pending.versionId,before.receipt.provider.versionId);
        if (scenario.startsWith('repeat-')) assert.ok(pending.repeatVersionId, 'the confirming PUT is anchored before it can be interrupted');
        await ownerSecret({api,target,statePath,fetch:args.fetch,changes:[{binding:'AUTH_SECRET',...(present ? {value:'test-only-rotated'} : {})}]});
        await ownerDeploy({...args,plan:ownerPlan(target,{...declaration(),...(present ? {} : {secrets:[]})},artifact)});
        assert.equal(state.secrets.some(item => item.name === 'AUTH_SECRET'),present);
      } else {
        const writes = state.writes.length;
        await assert.rejects(ownerDeploy(args),/owned-resource-replaced/);
        await assert.rejects(ownerRemove({api,target,statePath}),/owned-resource-replaced/);
        assert.equal(state.writes.length,writes);
      }
    }
    assert.equal((await readOwnerState(statePath,target)).pendingSecret !== undefined,['script-drift','two-versions','repeat-later-change','repeat-foreign'].includes(scenario));
  }])));
});

settlementCase('stale preflight retains intent until deployment and versions agree, then retries safely', async t => {
  await caseRows(t, (['newer','missing','empty','malformed','malformed-tail','failed']).map((listing) => [listing, async t => {
  await caseRows(t, [['independent checks', async t => {
    const {args,api,target,statePath,state} = await setup(t);
    await ownerDeploy(args);
    const deployments = await api.request(`/workers/scripts/${target.worker}/deployments`);
    const stale = {...api, async request(path, options) {
      if (path.endsWith('/deployments')) return deployments;
      if (path.endsWith('/versions')) {
        if (listing === 'failed') throw Object.assign(new Error('provider-http-503'),{status:503});
        if (listing === 'missing') return {};
        if (listing === 'empty') return {items:[]};
        if (listing === 'malformed-tail') return {items:[{id:deployments.deployments[0].versions[0].version_id},null]};
        if (listing === 'malformed') return {items:{0:{id:deployments.deployments[0].versions[0].version_id}}};
      }
      return api.request(path,options);
    }};
    await assert.rejects(ownerSecret({api:stale,target,statePath,fetch:args.fetch,changes:[{binding:'AUTH_SECRET',value:'test-only-new-value'}],windowMs:0}),/secret-change-unsettled|provider/);
    const bytes = await readFile(statePath), writes = state.writes.length;
    let rowAt422 = 0;
  for (const command of [() => settleOwnerState({api:stale,target,statePath}),
      () => ownerSecret({api:stale,target,statePath,fetch:args.fetch,changes:[{binding:'AUTH_SECRET',value:'test-only-retry'}]}),
      () => ownerSecret({api:stale,target,statePath,fetch:args.fetch,changes:[{binding:'OTHER',value:'test-only-new-intent'}]}),
      () => ownerDeploy({...args,api:stale}), () => ownerRemove({api:stale,target,statePath})]) {
    await caseRow(t, 'table at line 422 row ' + rowAt422++, async () => {

      try { await command(); } catch (error) { assert.match(error.message,/secret-change-unsettled|provider/); }
      assert.deepEqual(await readFile(statePath),bytes);
      assert.equal(state.writes.length,writes, 'unconfirmed intent blocks every further mutation');
        });
  }
    await ownerSecret({api,target,statePath,fetch:args.fetch,changes:[{binding:'AUTH_SECRET',value:'test-only-retry'}]});
    await caseRow(t, 'following assertion at line 431', async () => { assert.equal((await ownerDeploy(args)).receipt.changed,false); });
    await caseRow(t, 'following assertion at line 432', async () => { assert.equal((await readOwnerState(statePath,target)).pendingSecret,undefined); });
    }]]);
}]));
});

settlementCase('pending name snapshots use live names before writes and only adopt unchanged other-name sets', async t => {
  const malformedTypes = {'legacy-blank-type':' ','legacy-padded-type':'secret_text ','legacy-unknown-type':'unknown_binding','legacy-inherit-type':'inherit'};
  await caseRows(t, (['add','remove','rename','order','empty','set','unset','legacy-own','legacy-add','legacy-unset','legacy-missing','legacy-unavailable','legacy-malformed','legacy-wrong-id','legacy-wrong-etag','legacy-wrong-fingerprint',...Object.keys(malformedTypes)]).map((scenario) => [scenario, async t => {
  await caseRows(t, [['independent checks', async t => {
    const {args,api,target,statePath,state} = await setup(t);
    await ownerDeploy(args);
    const path = `/workers/scripts/${target.worker}/secrets`;
    // These are live, undeclared names; the plan cannot reconstruct this snapshot.
    if (scenario !== 'empty') for (const name of ['Z_OTHER','A_OTHER']) await ownerSecret({api,target,statePath,fetch:args.fetch,changes:[{binding:name,value:'test-only-other-value'}]});
    const before = await readOwnerState(statePath,target), anchor = before.receipt.provider.versionId;
    let boundary;
    const interrupted = {...api, async request(requestPath, options) {
      if (requestPath.includes('/secrets') && ['PUT','DELETE'].includes(options?.method)) {
        const bytes = await readFile(statePath,'utf8');
        boundary = JSON.parse(bytes).pendingSecret;
        assert.deepEqual(boundary.names,scenario === 'empty' ? [] : scenario === 'set' ? ['AUTH_SECRET','A_OTHER','Z_OTHER'] : ['A_OTHER','Z_OTHER']);
        for (const value of ['test-only-other-value','test-only-new-value',args.env.AUTH_SECRET]) assert.ok(!bytes.includes(value));
        throw new Error('test-only-interruption');
      }
      return api.request(requestPath,options);
    }};
    const unset = scenario === 'unset' || scenario === 'legacy-unset';
    const binding = scenario === 'set' ? 'NEW_SECRET' : 'AUTH_SECRET';
    await assert.rejects(ownerSecret({api:interrupted,target,statePath,fetch:args.fetch,changes:[{binding,...(unset ? {} : {value:'test-only-new-value'})}],windowMs:0}),/test-only-interruption/);
    // The thrown write has a corroborated unchanged readback, so emulate process
    // interruption with the exact intent observed durably at the mutation boundary.
    const saved = await readOwnerState(statePath,target);
    saved.pendingSecret = boundary;
    if (scenario.startsWith('legacy-')) delete saved.pendingSecret.names;
    await writeOwnerState(statePath,saved);
    if (['add','legacy-add'].includes(scenario)) await api.request(path,{method:'PUT',body:{name:'FOREIGN',text:'test-only-foreign',type:'secret_text'}});
    else if (scenario === 'remove' || Object.hasOwn(malformedTypes,scenario)) await api.request(`${path}/A_OTHER`,{method:'DELETE'});
    else if (scenario === 'rename') {
      // A single foreign version can change several bindings at once.
      state.secrets = state.secrets.filter(row => row.name !== 'A_OTHER');
      await api.request(path,{method:'PUT',body:{name:'RENAMED',text:'test-only-foreign',type:'secret_text'}});
    } else if (unset) await api.request(`${path}/${binding}`,{method:'DELETE'});
    else await api.request(path,{method:'PUT',body:{name:binding,text:'test-only-new-value',type:'secret_text'}});
    if (scenario === 'order') state.secrets.reverse();
    const observed = {...api, async request(requestPath, options) {
      if (requestPath === `/workers/scripts/${target.worker}/versions/${anchor}` && scenario.startsWith('legacy-')) {
        if (scenario === 'legacy-unavailable') throw Object.assign(new Error('provider-http-404'),{status:404});
        const version = structuredClone(await api.request(requestPath,options));
        if (scenario === 'legacy-missing') delete version.resources.bindings;
        if (scenario === 'legacy-malformed') version.resources.bindings = [{type:'secret_text',name:null}];
        if (Object.hasOwn(malformedTypes,scenario)) version.resources.bindings.find(row => row.name === 'A_OTHER').type = malformedTypes[scenario];
        if (scenario === 'legacy-wrong-id') version.id = state.version.id;
        if (scenario === 'legacy-wrong-etag') version.resources.script.etag = 'foreign-script';
        if (scenario === 'legacy-wrong-fingerprint') version.resources.bindings = version.resources.bindings.filter(row => row.name !== 'RER_DEPLOY_FINGERPRINT');
        return version;
      }
      return api.request(requestPath,options);
    }};
    const writes = state.writes.length;
    const refused = Object.hasOwn(malformedTypes,scenario) || ['add','remove','rename','legacy-add','legacy-missing','legacy-unavailable','legacy-malformed','legacy-wrong-id','legacy-wrong-etag','legacy-wrong-fingerprint'].includes(scenario);
    if (refused) {
      let rowAt491 = 0;
  for (const command of [() => ownerDeploy({...args,api:observed}), () => ownerRemove({api:observed,target,statePath}),
        () => ownerSecret({api:observed,target,statePath,changes:[{binding:'AUTH_SECRET',value:'test-only-retry'}]})]) {
    await caseRow(t, 'table at line 491 row ' + rowAt491++, async () => {
await assert.rejects(command(),/owned-resource-replaced/);
    });
  }
      await caseRow(t, 'following assertion at line 493', async () => { assert.equal(state.writes.length,writes); });
      await caseRow(t, 'following assertion at line 494', async () => { assert.deepEqual(await readOwnerState(statePath,target),saved); });
    } else {
      const settled = await settleOwnerState({api:observed,target,statePath});
      assert.equal(settled.pendingSecret,undefined);
      assert.equal(settled.receipt.provider.versionId,state.version.id);
      if (unset) assert.ok(settled.retiredSecrets.includes(binding));
      assert.equal(state.writes.length,writes);
    }
    }]]);
}]));
});

settlementCase('legacy own secret addition recovers with every supported declared binding family', async t => {
  const declared = {...declaration(),services:[{binding:'UPSTREAM',project:'runeditrun/upstream'}]};
  const fixture = await setup(t,{declared});
  const {target,statePath,state} = fixture;
  const api = {...fixture.api, async request(path, options) {
    // The account fake serves one Worker; model the declared service's presence.
    if (path === '/workers/scripts/upstream-production/settings') return {bindings:[]};
    return fixture.api.request(path,options);
  }};
  await ownerDeploy({...fixture.args,api});
  await ownerSecret({api,target,statePath,fetch:fixture.args.fetch,changes:[{binding:'OTHER',value:'test-only-other'}]});
  let pending;
  const interrupted = {...api, async request(path, options) {
    if (path.endsWith('/secrets') && options?.method === 'PUT') {
      pending = await readOwnerState(statePath,target);
      await api.request(path,options);
      throw new Error('test-only-interruption');
    }
    if (pending && path.endsWith('/deployments')) throw Object.assign(new Error('provider-http-503'),{status:503});
    return api.request(path,options);
  }};
  await assert.rejects(ownerSecret({api:interrupted,target,statePath,fetch:fixture.args.fetch,changes:[{binding:'NEW_SECRET',value:'test-only-new'}],windowMs:0}),/test-only-interruption/);
  assert.deepEqual(await readOwnerState(statePath,target),pending);
  delete pending.pendingSecret.names;
  await writeOwnerState(statePath,pending);
  const writes = state.writes.length;
  const settled = await settleOwnerState({api,target,statePath});
  assert.equal(settled.pendingSecret,undefined);
  assert.equal(settled.receipt.provider.versionId,state.version.id);
  assert.equal(state.writes.length,writes);
  await ownerHealth({...fixture.args,api});
});

settlementCase('stored pending names must be unique identifiers excluding the changed binding', async t => {
  const {args,api,target,statePath,state} = await setup(t);
  await ownerDeploy(args);
  const saved = await readOwnerState(statePath,target), writes = state.writes.length;
  for (const names of [null,{},'OTHER',['OTHER','OTHER'],['AUTH_SECRET'],['bad-name'],[null],[{name:'OTHER',text:'test-only-value'}]]) {
    await writeOwnerState(statePath,{...saved,pendingSecret:{binding:'AUTH_SECRET',present:true,versionId:saved.receipt.provider.versionId,names}});
    await assert.rejects(ownerSecret({api,target,statePath,changes:[{binding:'AUTH_SECRET',value:'test-only-new-value'}]}),/invalid-owner-state/);
    assert.equal(state.writes.length,writes);
  }
});

test('owner deploy reconciles first, repeated, resumed and extended resource declarations', async (t) => {
  await caseRows(t, reconcileCaseRows.map(({name,run}) => [name,run]));
});

test('owner deploy refuses uncertain, foreign, replaced or wrong-target resources before writes', async (t) => {
  await caseRows(t, ownershipCaseRows.map(({name,run}) => [name,run]));
});

test('owner secret settlement preserves anchored intent, foreign names and recoverable state', async (t) => {
  await caseRows(t, settlementCaseRows.map(({name,run}) => [name,run]));
});
