import { caseRow, caseRows } from './fold-case.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudflare } from '../provider.mjs';
import { validatePlan } from '../validation.mjs';
import { defaultStagePlan } from '../default-stage.mjs';
import { reconcileTriggers } from '../resources.mjs';
import { renderConfig } from '../render.mjs';

test('R2 explicit null pagination is terminal only for a short requested-limit page', async (t) => {
  await caseRows(t, [['independent checks', async t => {
  const accountId = 'a'.repeat(32);
  let rowAt11 = 0;
  for (const rows of [[], [{name:'owned-files'}]]) {
    await caseRow(t, 'table at line 11 row ' + rowAt11++, async () => {

    const api = cloudflare({accountId,token:'fixture',fetch:async url => {
      assert(url.endsWith('/r2/buckets?per_page=1000'));
      return Response.json({success:true,result:{buckets:rows},result_info:null});
    }});
    assert.deepEqual(await api.list('/r2/buckets',{field:'buckets',pagination:'cursor'}),rows);
      });
  }
  const full = cloudflare({accountId,token:'fixture',fetch:async () => Response.json({success:true,result:{buckets:Array.from({length:1000},(_,i)=>({name:`bucket-${i}`}))},result_info:null})});
  await caseRow(t, 'following assertion at line 19', async () => { await assert.rejects(full.list('/r2/buckets',{field:'buckets',pagination:'cursor'}),/incomplete-pagination/); });
  const missing = cloudflare({accountId,token:'fixture',fetch:async () => Response.json({success:true,result:{buckets:[]}})});
  await caseRow(t, 'following assertion at line 21', async () => { assert.deepEqual(await missing.list('/r2/buckets',{field:'buckets',pagination:'cursor'}),[]); });
  }]]);
});

test('declared DLQ is provisioned as a queue and reconciled at consumer top level, including no-write health', async () => {
  const plan = defaultStagePlan({run:{id:'1'},migrations:[]});
  plan.queues[0].deadLetterQueue = 'proof-dead';
  plan.queues.push({binding:'DEAD',name:'proof-dead'});
  validatePlan(plan);
  const resources = {d1:[],r2:[],queues:plan.queues.map((x,i)=>({...x,id:String(i+1).repeat(32)}))};
  const rendered = renderConfig(plan,resources,'a'.repeat(32),'b'.repeat(40),'f','index.js');
  assert.equal(rendered.queues.consumers[0].dead_letter_queue,'proof-dead');
  let consumer; const writes=[];
  const api = {request:async (path,options) => {
    if(path.endsWith('/schedules')) return {schedules:plan.crons.map(cron=>({cron}))};
    if(options) {writes.push(options);consumer={...options.body,consumer_id:'c'.repeat(32)};return consumer;}
    return consumer ? [consumer] : [];
  }};
  await reconcileTriggers(api,plan,resources);
  assert.equal(writes.length,1);assert.equal(writes[0].body.dead_letter_queue,'proof-dead');
  assert(!Object.hasOwn(writes[0].body.settings,'dead_letter_queue'));
  await reconcileTriggers(api,plan,resources,{mutate:false});assert.equal(writes.length,1);
  consumer.dead_letter_queue='wrong-dead';
  await assert.rejects(reconcileTriggers(api,plan,resources,{mutate:false}),/queue-consumer-drift/);
  await reconcileTriggers(api,plan,resources);assert.equal(writes.length,2);assert.equal(writes[1].method,'PUT');
  for(const bad of ['undeclared-dead',plan.queues[0].name]) {
    const invalid=structuredClone(plan);invalid.queues[0].deadLetterQueue=bad;
    assert.throws(()=>validatePlan(invalid),/invalid-dead-letter-queue/);
  }
});
