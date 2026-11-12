import { caseRow, caseRows } from './fold-case.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudflare, deploy, verifyHealth, defaultStagePlan } from '../index.mjs';
import { hash } from '../validation.mjs';
import { providerFixture } from './provider-fixture.mjs';

function setup(t) {
  const fixture = providerFixture();
  t.after(()=>fixture.close());
  // Preserve the original fixture; adapt only consumer GETs to the observed wire response.
  const fetch = async (url,init) => {
    const response = await fixture.fetch(url,init);
    if ((init?.method ?? 'GET') !== 'GET' || !new URL(url).pathname.endsWith('/consumers')) return response;
    const body = await response.json();
    body.result = body.result.map(({script_name,...row})=>({...row,script:script_name}));
    return Response.json(body);
  };
  const source = 'export default {scheduled() {},fetch(){return new Response("ok")}}';
  const sql = 'CREATE TABLE retained_notes(body TEXT NOT NULL);';
  const artifact = {version:1,source:{sha:'3'.repeat(40),tree:'4'.repeat(40)},run:{id:'67890',attempt:'1'},main:'index.js',modules:[{path:'index.js',base64:Buffer.from(source).toString('base64'),sha256:hash(source)}],assets:[],migrations:[{binding:'DB',name:'0001_notes.sql',sql,sha256:hash(sql)}]};
  const plan = defaultStagePlan(artifact);
  plan.queues[0].consumer = {batch_size:10,max_retries:3,max_wait_time_ms:1000,retry_delay:0};
  plan.queues[0].deadLetterQueue = `${plan.worker}-dead`;
  plan.queues.push({binding:'DEAD',name:`${plan.worker}-dead`});
  return {...fixture,args:{api:cloudflare({...fixture,fetch}),plan,artifact,artifactSha256:hash(artifact),fetch}};
}

test('native script response supports initial health, repeated health and retained receipt with zero repair writes',async t => {
  await caseRows(t, [['independent checks', async t => {
  const {args,state} = setup(t);
  const receipt = await deploy(args);
  const receiptBytes = JSON.stringify(receipt);
  state.databases[0].db.exec("INSERT INTO retained_notes VALUES ('owner data')");
  const writes = state.writes.length;
  const ids = state.queues.map(queue=>queue.queue_id);
  let rowAt35 = 0;
  for (let i=0;i<2;i++) {
    await caseRow(t, 'table at line 35 row ' + rowAt35++, async () => {
assert.equal((await verifyHealth({...args,receipt})).ok,true);
    });
  }
  const second = await deploy({...args,previousReceipt:receipt,repeatOnly:true});
  await caseRow(t, 'following assertion at line 37', async () => { assert.equal(second.changed,false); });
  await caseRow(t, 'following assertion at line 38', async () => { assert.equal(state.writes.length,writes); });
  await caseRow(t, 'following assertion at line 39', async () => { assert.equal(JSON.stringify(receipt),receiptBytes); });
  await caseRow(t, 'following assertion at line 40', async () => { assert.deepEqual(state.queues.map(queue=>queue.queue_id),ids); });
  await caseRow(t, 'following assertion at line 41', async () => { assert.equal(state.databases[0].db.prepare('SELECT body FROM retained_notes').get().body,'owner data'); });
  const consumerWrite = state.writes.find(x=>x.path.endsWith('/consumers'));
  await caseRow(t, 'following assertion at line 43', async () => { assert.equal(consumerWrite.body.script_name,args.plan.worker); });
  await caseRow(t, 'following assertion at line 44', async () => { assert(!Object.hasOwn(consumerWrite.body,'script')); });
  }]]);
});

test('native foreign ownership blocks health and retained repeat without writes or changes',async t => {
  const {args,state} = setup(t);
  const receipt = await deploy(args);
  state.queues[0].consumers[0].script_name = 'foreign-worker';
  const before = JSON.stringify(state.queues);
  const receiptBytes = JSON.stringify(receipt);
  const writes = state.writes.length;
  await assert.rejects(verifyHealth({...args,receipt}),/queue-consumer-conflict/);
  await assert.rejects(deploy({...args,previousReceipt:receipt,repeatOnly:true}),/queue-consumer-conflict/);
  assert.equal(state.writes.length,writes);
  assert.equal(JSON.stringify(state.queues),before);
  assert.equal(JSON.stringify(receipt),receiptBytes);
});
