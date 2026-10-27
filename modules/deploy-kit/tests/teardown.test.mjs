import { runCase } from './fold-case.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudflare } from '../provider.mjs';
import { verifyTeardown, deleteWorker } from '../teardown.mjs';

const inventoryCaseRows = [];
const inventoryCase = (name, run) => inventoryCaseRows.push({name,run});

const prefix='rer-seedproof-base11',accountId='a'.repeat(32),databaseId='12345678-1234-1234-1234-123456789abc',queueId='b'.repeat(32);
const receipt={version:1,worker:prefix,accountId,resources:{d1:[{name:prefix+'-db',id:databaseId}],r2:[],queues:[]},durableObjects:[]};
const response=(result,result_info)=>Response.json({success:true,result,errors:[],...(result_info?{result_info}:{})});
function fixture({drift=0,d1=[],queues=[],consumers=[],workers=[],r2=[],durableObjects=[]}={}) {
  let rounds=0;const calls=[];
  const api=cloudflare({accountId,token:'test-only',fetch:async input=>{
    const url=new URL(input);const path=url.pathname.split(accountId)[1];calls.push(path+url.search);
    if(path==='/workers/scripts') {rounds++;return response(workers);}
    if(path.endsWith('/consumers')) return response(consumers);
    if(path==='/r2/buckets') return response({buckets:r2});
    const page=Number(url.searchParams.get('page'));let rows=path==='/d1/database'?d1:path==='/queues'?queues:durableObjects;
    if(path==='/d1/database' && rounds<=drift) return page===1?response([{uuid:databaseId,name:prefix+'-db'}],{page:1,total_count:2,total_pages:2}):response([],{page:2,total_count:0,total_pages:1});
    return response(rows,{page,total_count:rows.length,total_pages:1});
  }});
  return {api,calls};
}
const args=api=>({api,plan:{worker:prefix},receipt,sleep:async()=>{}});
inventoryCase('post-delete count drop restarts complete listing and returns authenticated empty snapshot',async()=>{
  const {api,calls}=fixture({drift:1});const result=await verifyTeardown(args(api));
  assert.equal(result.ok,true);assert.deepEqual(result.listing,{workers:[],d1:[],r2:[],queues:[],consumers:[],durableObjects:[]});assert.deepEqual(result.attempts[1].counts,{workers:0,d1:0,r2:0,queues:0,consumers:0,durableObjects:0});assert.equal(result.attempts.length,2);assert.equal(result.attempts[0].errorClass,'provider-pagination-changed');assert.equal(result.attempts[1].errorClass,null);assert.equal(calls.filter(x=>x==='/workers/scripts').length,2);
});
test('ordinary listing still rejects count drop',async()=>{
  const {api}=fixture({drift:1});await api.list('/workers/scripts',{pagination:'single'});await assert.rejects(api.list('/d1/database'),/pagination-changed/);
});
inventoryCase('owned D1 survives with a changed name: fails and names exact identity',async()=>{
  const {api}=fixture({d1:[{uuid:databaseId,name:'renamed-owned-db'}]});
  await assert.rejects(verifyTeardown(args(api)),error=>{assert.equal(error.message,'teardown-resources-remain');assert.deepEqual(error.remaining,[{type:'d1',name:'renamed-owned-db',id:databaseId}]);assert.equal(error.attempts.length,1);return true;});
});
inventoryCase('foreign resource with disposable prefix cannot pass',async()=>{
  const {api}=fixture({d1:[{uuid:'22345678-1234-1234-1234-123456789abc',name:prefix+'-foreign'}]});await assert.rejects(verifyTeardown(args(api)),error=>{assert.equal(error.remaining[0].name,prefix+'-foreign');return true;});
});
inventoryCase('drift beyond bounded attempts fails with every attempt and backoff',async()=>{
  const {api}=fixture({drift:9});const sleeps=[];const records=[];
  await assert.rejects(verifyTeardown({...args(api),maxAttempts:3,sleep:async ms=>sleeps.push(ms),onAttempt:async x=>records.push({...x})}),error=>{assert.equal(error.message,'provider-pagination-changed');assert.equal(error.attempts.length,3);assert(error.attempts.every(x=>x.errorClass==='provider-pagination-changed'));return true;});assert.equal(sleeps.length,2);assert(sleeps.every(ms=>ms>0));assert(sleeps[1]>sleeps[0]);assert.equal(records.length,3);
});
inventoryCase('consumer on foreign queue referencing owned worker prevents a false empty result',async()=>{
  const {api,calls}=fixture({queues:[{queue_id:queueId,queue_name:'foreign-queue'}],consumers:[{consumer_id:'c'.repeat(32),type:'worker',script:prefix}]});
  await assert.rejects(verifyTeardown(args(api)),error=>{assert.equal(error.remaining[0].type,'consumers');return true;});assert(calls.some(x=>x===`/queues/${queueId}/consumers`));
});
for (const [type,rows] of Object.entries({workers:[{id:prefix}],r2:[{name:prefix+'-files'}],queues:[{queue_name:prefix+'-jobs',queue_id:queueId}],durableObjects:[{id:'d'.repeat(32),script:prefix,class:'Room'}]})) inventoryCase(`${type} survivor prevents success`,async()=>{
  const {api}=fixture({[type]:rows});await assert.rejects(verifyTeardown(args(api)),error=>{assert(error.remaining.some(x=>x.type===type));return true;});
});

// A local stand-in for the provider: the schedule list keeps reporting `lag` reads after it was cleared.
function workerProvider({lag=0,stuck=false}={}) {
  const calls=[];let schedules=[{cron:'* * * * *'}],reads=0,cleared=false;
  const api=cloudflare({accountId,token:'test-only',fetch:async(input,init)=>{
    const path=new URL(input).pathname.split(accountId)[1];calls.push(`${init.method} ${path}`);
    if(path===`/workers/scripts/${prefix}/schedules`&&init.method==='PUT'){cleared=JSON.parse(init.body).length===0;return response({schedules:[]});}
    if(path===`/workers/scripts/${prefix}/schedules`) return response({schedules:cleared&&!stuck&&reads++>=lag?[]:schedules});
    if(path===`/workers/scripts/${prefix}`&&init.method==='DELETE') return response(null);
    return new Response('{}',{status:404});
  }});
  return {api,calls};
}
test('deleting a Worker clears its schedules, waits until the provider reports none, then deletes',async()=>{
  const {api,calls}=workerProvider({lag:2});
  await deleteWorker({api,worker:prefix,sleep:async()=>{}});
  assert.deepEqual(calls.map(call=>call.split('?')[0]),['PUT','GET','GET','GET','DELETE'].map(method=>`${method} /workers/scripts/${prefix}${method==='DELETE'?'':'/schedules'}`));
});
test('a schedule set that never clears leaves the Worker in place with a plain message',async()=>{
  const {api,calls}=workerProvider({stuck:true});let waited=0;
  await assert.rejects(deleteWorker({api,worker:prefix,maxWaitMs:5000,clock:()=>waited,sleep:async ms=>{waited+=ms;}}),error=>{assert.equal(error.code,'teardown-schedules-not-cleared');assert.match(error.message,/was not deleted/);return true;});
  assert(!calls.some(call=>call.startsWith('DELETE')));
});

test('teardown verification requires a complete empty owned-resource inventory', async () => {
  for (const {name,run} of inventoryCaseRows) await runCase(name,run);
});
