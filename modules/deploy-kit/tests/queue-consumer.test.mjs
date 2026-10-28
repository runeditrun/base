import { runCase } from './fold-case.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { workerConsumerScript } from '../index.mjs';
import { reconcileTriggers } from '../resources.mjs';

const identityCaseRows = [];
const identityCase = (name, run) => identityCaseRows.push({name,run});

const worker = 'identity-proof-worker';
const valid = {type:'worker',script:worker,consumer_id:'a'.repeat(32),settings:{batch_size:10,max_retries:3,max_wait_time_ms:1000,retry_delay:0},dead_letter_queue:'identity-proof-dead'};
const invalid = [
  ['null',null], ['array',[]], ['missing type',{script:worker}],
  ['nonworker',{...valid,type:'http_pull'}], ['missing identity',{type:'worker'}],
  ...['script','script_name'].flatMap(key => [undefined,null,{},[],42,true,'',' ',' worker','worker\n','/worker'].map((value,i) => [`${key} malformed ${i}`,{type:'worker',[key]:value}])),
  ['conflicting aliases',{...valid,script_name:'different-worker'}],
  ['bad documented alias',{...valid,script_name:null}],
  ['bad observed alias',{...valid,script_name:worker,script:{name:worker}}],
];

identityCase('consumer identity accepts explicit string variants and agreeing aliases without changing the row', () => {
  for (const row of [valid,{...valid,script_name:worker,script:undefined},{...valid,script_name:worker}]) {
    if (row.script === undefined) delete row.script;
    const before = structuredClone(row);
    assert.equal(workerConsumerScript(row),worker);
    assert.deepEqual(row,before);
  }
});

function transport(consumers) {
  const calls = [];
  const plan = {worker,crons:['*/10 * * * *'],queues:[{binding:'JOBS',name:'identity-proof-jobs',consumer:valid.settings,deadLetterQueue:valid.dead_letter_queue}]};
  const resources = {queues:[{binding:'JOBS',id:'b'.repeat(32)}]};
  const api = {request:async (path,options) => {
    calls.push({path,options});
    if (options) return {};
    return path.endsWith('/schedules') ? {schedules:plan.crons.map(cron=>({cron}))} : consumers;
  }};
  return {api,plan,resources,calls};
}

for (const [label,row] of invalid) identityCase(`malformed consumer ${label} fails closed without writes`,async () => {
  assert.equal(workerConsumerScript(row),null);
  for (const mutate of [false,true]) {
    const {api,plan,resources,calls} = transport([row]);
    await assert.rejects(reconcileTriggers(api,plan,resources,{mutate}),/queue-consumer-conflict/);
    assert(calls.every(call=>!call.options));
  }
});

for (const [label,consumers] of [
  ['foreign',[{...valid,script:'foreign-worker'}]],
  ['duplicate observed',[valid,valid]],
  ['duplicate mixed',[valid,{...valid,script_name:worker}]],
]) identityCase(`${label} consumers fail closed without writes`,async () => {
  for (const mutate of [false,true]) {
    const {api,plan,resources,calls} = transport(consumers);
    await assert.rejects(reconcileTriggers(api,plan,resources,{mutate}),/queue-consumer-conflict/);
    assert(calls.every(call=>!call.options));
  }
});

test('later foreign consumer blocks an earlier pending trigger write',async () => {
  const {api,plan,resources,calls} = transport([{...valid,script:'foreign-worker'}]);
  plan.queues.unshift({binding:'FIRST',name:'identity-first',consumer:valid.settings});
  resources.queues.unshift({binding:'FIRST',id:'c'.repeat(32)});
  const request = api.request;
  api.request = async (path,options) => path === `/queues/${'c'.repeat(32)}/consumers` && !options ? [] : request(path,options);
  await assert.rejects(reconcileTriggers(api,plan,resources),/queue-consumer-conflict/);
  assert(calls.every(call=>!call.options));
});

test('observed response settings and DLQ remain strict; repair uses documented request identity',async () => {
  for (const row of [{...valid,settings:{...valid.settings,max_retries:4}},{...valid,dead_letter_queue:'other-dead'}]) {
    const {api,plan,resources,calls} = transport([row]);
    await assert.rejects(reconcileTriggers(api,plan,resources,{mutate:false}),/queue-consumer-drift/);
    assert(calls.every(call=>!call.options));
    await reconcileTriggers(api,plan,resources);
    const writes = calls.filter(call=>call.options);
    assert.equal(writes.length,1);
    assert.equal(writes[0].path,`/queues/${resources.queues[0].id}/consumers/${valid.consumer_id}`);
    assert.deepEqual(writes[0].options,{method:'PUT',body:{type:'worker',script_name:worker,settings:valid.settings,dead_letter_queue:valid.dead_letter_queue}});
  }
});

test('consumer identity admission accepts agreeing Worker aliases and refuses malformed or foreign owners', async () => {
  for (const {name,run} of identityCaseRows) await runCase(name,run);
});
