import { caseRow, caseRows } from './fold-case.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudflare } from '../provider.mjs';
import { deploy } from '../index.mjs';
import { verifyHealth } from '../health.mjs';
import { checkCronOwnership, reconcileTriggers } from '../resources.mjs';
import { hash } from '../validation.mjs';
import { defaultStagePlan } from '../default-stage.mjs';
import { documentedProvider } from './documented-provider.mjs';

const cronCaseRows = [];
const cronCase = (name, run) => cronCaseRows.push({name,run});

function setup(t) {
  const fixture = documentedProvider(); t.after(() => fixture.close());
  const sql = 'CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT NOT NULL);';
  const code = 'export default {scheduled() {},fetch() {return new Response("fixture");}};';
  const artifact = {version:1,source:{sha:'3'.repeat(40),tree:'4'.repeat(40)},run:{id:'951',attempt:'1'},main:'index.js',
    modules:[{path:'index.js',base64:Buffer.from(code).toString('base64'),sha256:hash(code)}],assets:[],
    migrations:[{binding:'DB',name:'0001_notes.sql',sql,sha256:hash(sql)}]};
  const plan = defaultStagePlan(artifact);
  const api = cloudflare(fixture);
  return {...fixture,api,plan,artifact,args:{api,plan,artifact,artifactSha256:hash(artifact),fetch:fixture.fetch}};
}

cronCase('Cron deployment reapplies changed releases, checks capability and schedule readback, and retains no-write repeats', async t => {
  await caseRows(t, [['independent checks', async t => {
  const {state,args,api,plan} = setup(t);
  plan.crons = ['* * * * *'];
  plan.r2 = [{binding:'FILES',name:'cron-proof-files'}];
  plan.durableObjects = [{binding:'ROOM',className:'Room',storage:'sqlite'}];
  plan.secrets = [{binding:'MAIL',environment:'RESEND_API_KEY'}];
  const first = await deploy({...args,env:{RESEND_API_KEY:'test-only-retained-value'}});
  assert(first.changed);
  assert.deepEqual(state.schedules.map(x => x.cron),plan.crons);
  assert.deepEqual(state.scheduleApplications.at(-1),{versionId:first.provider.versionId,deploymentId:first.provider.deploymentId,crons:plan.crons});
  state.databases[0].db.exec("INSERT INTO notes(body) VALUES ('previous release row')");
  state.objects.set('owner.txt',Buffer.from('previous release object'));
  const upgradedCode = 'export default {scheduled() {},fetch() {return new Response("upgraded fixture");}};';
  const upgradedArgs = {...args,artifact:{...args.artifact,source:{sha:'5'.repeat(40),tree:'6'.repeat(40)},
    modules:[{path:'index.js',base64:Buffer.from(upgradedCode).toString('base64'),sha256:hash(upgradedCode)}]}};
  upgradedArgs.artifactSha256 = hash(upgradedArgs.artifact);
  const upgraded = await deploy({...upgradedArgs,previousReceipt:first});
  assert(upgraded.changed);
  assert.notEqual(upgraded.provider.versionId,first.provider.versionId);
  assert.notEqual(upgraded.provider.etag,first.provider.etag);
  assert.notDeepEqual(upgraded.source,first.source);
  assert.deepEqual(upgraded.resources,first.resources);
  assert.deepEqual(state.scheduleApplications.at(-1),{versionId:upgraded.provider.versionId,deploymentId:upgraded.provider.deploymentId,crons:plan.crons},'declared schedules must be applied to the current changed deployment');
  const writes = state.writes.length;
  await verifyHealth({api,plan,receipt:upgraded,fetch:args.fetch});
  const second = await deploy({...upgradedArgs,previousReceipt:upgraded,repeatOnly:true});
  assert.equal(second.changed,false);
  assert.equal(state.writes.length,writes);
  assert.deepEqual(second.resources,first.resources);
  assert.deepEqual(second.durableObjects,first.durableObjects);
  assert.deepEqual(second.migrations[0].applied,[]);
  assert.equal(state.databases[0].db.prepare('SELECT body FROM notes').get().body,'previous release row');
  assert.equal(state.objects.get('owner.txt').toString(),'previous release object');
  assert.equal(state.secrets[0].value,'test-only-retained-value');
  assert(!JSON.stringify(second).includes('test-only-retained-value'));
  const handlers = state.version.resources.script.handlers;
  let rowAt63 = 0;
  for (const reported of [undefined,null,{},[],['fetch']]) {
    await caseRow(t, 'table at line 63 row ' + rowAt63++, async () => {

    state.version.resources.script.handlers = reported;
    await assert.rejects(verifyHealth({api,plan,receipt:upgraded,fetch:args.fetch}),/missing-scheduled-handler/);
    await assert.rejects(deploy({...upgradedArgs,previousReceipt:upgraded,repeatOnly:true}),/missing-scheduled-handler/);
      });
  }
  state.version.resources.script.handlers = handlers;
  await caseRow(t, 'following assertion at line 69', async () => { assert.equal(state.writes.length,writes); });
  const request = api.request;
  let rowAt71 = 0;
  for (const schedules of [[],[{cron:'0 12 * * *'}]]) {
    await caseRow(t, 'table at line 71 row ' + rowAt71++, async () => {

    state.schedules = plan.crons.map(cron => ({cron}));
    api.request = async (path,options) => {
      const result = await request(path,options);
      if (path.endsWith('/schedules') && options?.method === 'PUT') state.schedules = schedules;
      return result;
    };
    let receipt;
    await assert.rejects(deploy({...upgradedArgs,plan:{...plan,vars:{RELEASE:`bad-readback-${schedules.length}`}},previousReceipt:upgraded,onReceipt:value => {receipt=value;}}),/cron-drift/);
    assert.equal(receipt,undefined,'a successful write with failed readback must not produce a deployment receipt');
      });
  }
  state.schedules = plan.crons.map(cron => ({cron}));
  api.request = async (path,options) => {
    const result = await request(path,options);
    if (path.endsWith('/schedules') && options?.method === 'PUT') state.deployments[0].id = crypto.randomUUID();
    return result;
  };
  await caseRow(t, 'following assertion at line 88', async () => { await assert.rejects(deploy({...upgradedArgs,plan:{...plan,vars:{RELEASE:'concurrent-deployment'}},previousReceipt:upgraded}),/deployment-changed-during-triggers/); });
  api.request = request;
  state.schedules = plan.crons.map(cron => ({cron}));
  const cronWrites = state.writes.filter(x => x.path.endsWith('/schedules')).length;
  const code = 'export default {fetch() {return new Response("missing scheduled handler");}};';
  const artifact = {...upgradedArgs.artifact,modules:[{path:'index.js',base64:Buffer.from(code).toString('base64'),sha256:hash(code)}]};
  state.uploadHandlers = ['fetch'];
  await caseRow(t, 'following assertion at line 95', async () => { await assert.rejects(deploy({...upgradedArgs,artifact,artifactSha256:hash(artifact),previousReceipt:upgraded}),/missing-scheduled-handler/); });
  await caseRow(t, 'following assertion at line 96', async () => { assert.equal(state.writes.filter(x => x.path.endsWith('/schedules')).length,cronWrites,'a Worker without a scheduled handler cannot publish Cron triggers'); });
  }]]);
});

test('bare-array, missing, malformed, empty-string and duplicate schedule results fail closed', async () => {
  for (const result of [[],null,{}, {schedules:{}},{schedules:[null]},{schedules:[{cron:7}]},{schedules:[{cron:''}]},{schedules:[{cron:'* * * * *'},{cron:'* * * * *'}]}]) {
    const api = {request:async () => result};
    await assert.rejects(checkCronOwnership(api,{worker:'fixture-worker',crons:['* * * * *']}),/invalid-cron-list/);
  }
});

test('schedule timestamps and ordering do not cause redundant PUTs', async () => {
  const plan = {worker:'fixture-worker',queues:[],crons:['0 5 * * *','*/10 * * * *']};
  const calls = [];
  const api = {request:async (path,options) => { calls.push({path,options}); return {schedules:plan.crons.toReversed().map(cron => ({cron,created_on:'2026-10-06T00:00:00Z'}))}; }};
  await reconcileTriggers(api,plan,{queues:[]});
  assert.equal(calls.length,1);
  assert.equal(calls[0].options,undefined);
});

cronCase('unmanaged Cron on ordinary changed-source upgrade fails before upload, migrations or any other mutation', async t => {
  const {state,args,plan,artifact} = setup(t);
  const first = await deploy(args);
  state.databases[0].db.exec("INSERT INTO notes(body) VALUES ('keep')");
  state.schedules.push({cron:'0 12 * * *',created_on:'2026-01-01T00:00:00Z'});
  const schedules = structuredClone(state.schedules);
  const sql = 'ALTER TABLE notes ADD COLUMN label TEXT;';
  plan.d1[0].migrations.push({name:'0002_label.sql',sql,sha256:hash(sql)});
  const nextArtifact = {...artifact,source:{sha:'5'.repeat(40),tree:'6'.repeat(40)}};
  const writes = state.writes.length;
  await assert.rejects(deploy({...args,artifact:nextArtifact,artifactSha256:hash(nextArtifact),previousReceipt:first}),/cron-drift/);
  assert.equal(state.writes.length,writes);
  assert.deepEqual(state.schedules,schedules);
  assert.equal(state.version.id,first.provider.versionId);
  assert.equal(state.databases[0].db.prepare('SELECT body FROM notes').get().body,'keep');
  assert.equal(state.databases[0].db.prepare('PRAGMA table_info(notes)').all().length,2);
});

cronCase('existing Worker without a prior receipt also rejects unmanaged Cron before writes', async t => {
  const {state,args,artifact} = setup(t);
  await deploy(args);
  state.schedules.push({cron:'0 12 * * *'});
  const writes = state.writes.length;
  await assert.rejects(deploy({...args,artifact:{...artifact,source:{sha:'7'.repeat(40),tree:'8'.repeat(40)}}}),/cron-drift/);
  assert.equal(state.writes.length,writes);
});

cronCase('intentional Cron removal is refused instead of deleting an existing schedule', async t => {
  const {state,args,plan} = setup(t);
  const first = await deploy(args);
  plan.crons = [];
  const writes = state.writes.length;
  await assert.rejects(deploy({...args,previousReceipt:first}),/cron-drift/);
  assert.equal(state.writes.length,writes);
  assert.equal(state.schedules.length,1);
});

cronCase('ordinary upgrade may add a requested Cron while retaining old schedules and prior migrations', async t => {
  const {state,args,plan} = setup(t);
  const first = await deploy(args);
  plan.crons.push('0 12 * * *');
  const second = await deploy({...args,previousReceipt:first});
  assert(second.changed);
  assert.deepEqual(state.schedules.map(x => x.cron).sort(),[...plan.crons].sort());
  const writes = state.writes.length;
  await deploy({...args,previousReceipt:second,repeatOnly:true});
  assert.equal(state.writes.length,writes);
});

cronCase('Cron drift introduced after upload is detected before trigger writes and retained', async t => {
  const {state,args,api} = setup(t);
  const first = await deploy(args);
  args.plan.vars = {RELEASE:'changed'};
  const request = api.request;
  api.request = async (path,options) => {
    const result = await request(path,options);
    if (options?.body instanceof FormData) state.schedules.push({cron:'0 12 * * *'});
    return result;
  };
  const cronWrites = state.writes.filter(x => x.path.endsWith('/schedules')).length;
  await assert.rejects(deploy({...args,previousReceipt:first}),/cron-drift/);
  assert.equal(state.writes.filter(x => x.path.endsWith('/schedules')).length,cronWrites);
  assert(state.schedules.some(x => x.cron === '0 12 * * *'));
});

cronCase('same-source missing Cron, extra Cron and stale health still fail without repair', async t => {
  const {state,args,plan,api} = setup(t);
  const first = await deploy(args);
  const schedules = structuredClone(state.schedules);
  const writes = state.writes.length;
  state.schedules = [];
  await assert.rejects(deploy({...args,previousReceipt:first}),/cron-drift/);
  state.schedules = [...schedules,{cron:'0 12 * * *'}];
  await assert.rejects(verifyHealth({api,plan,receipt:first,fetch:args.fetch}),/cron-drift/);
  state.schedules = schedules;
  state.healthOverride = () => Response.json({ok:true,deployment:{sourceSha:'old'}});
  await assert.rejects(verifyHealth({api,plan,receipt:first,fetch:args.fetch}),/health-identity-mismatch/);
  assert.equal(state.writes.length,writes);
});

test('valid upgrade extends Durable Object and D1 migration history once and retains opaque secrets', async t => {
  const {state,args,plan} = setup(t);
  plan.durableObjects = [{binding:'ROOM',className:'Room',storage:'sqlite'}];
  plan.secrets = [{binding:'MAIL',environment:'RESEND_API_KEY'}];
  const first = await deploy({...args,env:{RESEND_API_KEY:'first-test-value'}});
  const tag = state.settings.migration_tag;
  state.databases[0].db.exec("INSERT INTO notes(body) VALUES ('retained')");
  plan.durableObjects.push({binding:'INBOX',className:'Inbox',storage:'sqlite'});
  const sql = 'ALTER TABLE notes ADD COLUMN label TEXT;';
  plan.d1[0].migrations.push({name:'0002_label.sql',sql,sha256:hash(sql)});
  const second = await deploy({...args,previousReceipt:first,env:{RESEND_API_KEY:['test', 'never', 'replace', 'existing'].join('-')}});
  assert.deepEqual(state.settings.migrations.new_sqlite_classes,['Inbox']);
  assert.equal(state.settings.migrations.old_tag,tag);
  assert.notEqual(state.settings.migration_tag,tag);
  assert.equal(second.durableObjects[0].id,first.durableObjects[0].id);
  assert.equal(state.namespaces.length,2);
  assert.deepEqual(second.migrations[0].applied,['0002_label.sql']);
  assert.equal(state.databases[0].db.prepare('SELECT body FROM notes').get().body,'retained');
  assert.deepEqual(state.secrets,[{name:'MAIL',value:'first-test-value'}]);
  const writes = state.writes.length;
  await deploy({...args,previousReceipt:second,repeatOnly:true});
  assert.equal(state.writes.length,writes);
});

cronCase('malformed schedule read on an existing Worker stops an upgrade before writes', async t => {
  const {state,args,api} = setup(t);
  const first = await deploy(args);
  args.plan.vars = {RELEASE:'next'};
  const request = api.request;
  api.request = async (path,options) => path.endsWith('/schedules') ? [] : request(path,options);
  const writes = state.writes.length;
  await assert.rejects(deploy({...args,previousReceipt:first}),/invalid-cron-list/);
  assert.equal(state.writes.length,writes);
});

cronCase('no-op still requires the recorded active version and etag with correct Cron responses', async t => {
  const {state,args} = setup(t);
  const first = await deploy(args);
  const writes = state.writes.length;
  state.version.resources.script.etag = 'changed-by-another-writer';
  await assert.rejects(deploy({...args,previousReceipt:first}),/no-op-requires-authenticated-prior-receipt/);
  assert.equal(state.writes.length,writes);
});

test('deployment reconciles declared Cron schedules while refusing removal, drift and stale identities', async (t) => {
  await caseRows(t, cronCaseRows.map(({name,run}) => [name,run]));
});
