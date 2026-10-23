import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPortabilityHandler } from '../index.mjs';
import { runtime,seed,archive } from './helpers.mjs';
import { fixturePolicy } from './fixture-policy.mjs';
async function setup(t,{maxBodyBytes,authorize}={}) {
  const f=await runtime(t);let actor='owner',calls=[];
  const handler=await createPortabilityHandler({db:f.db,buckets:{FILES:f.bucket},policy:fixturePolicy,appOrigin:'https://app.test',maxBodyBytes,
    authorize:authorize??((request,context)=>{calls.push(context);return actor;})});
  const call=(path,method='GET',body,origin='https://app.test')=>handler(new Request('https://app.test/api/portability/'+path,{method,headers:origin?{Origin:origin}:{},body:body===undefined?undefined:typeof body==='string'?body:JSON.stringify(body)}));
  return {f,handler,call,calls,setActor(value){actor=value;}};
}
test('HTTP returns null for paths owned by other dispatchers',async t=>{const {handler}=await setup(t);assert.equal(await handler(new Request('https://app.test/other')),null);assert.equal(await handler(new Request('https://app.test/api/portability-other')),null);});
test('HTTP checks authorization on every route; null actors receive 401 and no-store',async t=>{
  const source=await runtime(t);await seed(source);const bundle=await archive(await source.connect()),{call,calls,setActor}=await setup(t);
  const exportId=(await (await call('exports','POST',{})).json()).id,importId=(await (await call('imports','POST',{confirmed:true,manifest:bundle.manifest})).json()).id;
  const routes=[['exports','POST',{}],['exports/'+exportId,'GET'],['exports/'+exportId+'/advance','POST',{}],['exports/'+exportId+'/download','GET'],['exports/'+exportId+'/abort','POST',{}],
    ['imports','POST',{confirmed:true,manifest:bundle.manifest}],['imports/'+importId,'GET'],['imports/'+importId+'/parts/0','PUT',bundle.parts[0]],['imports/'+importId+'/finalize','POST',{}],['imports/'+importId+'/abort','POST',{}]];
  setActor(null);for(const route of routes){const before=calls.length,response=await call(...route);assert.equal(response.status,401);assert.equal(calls.length,before+1);assert.equal(response.headers.get('Cache-Control'),'no-store');assert.deepEqual(await response.json(),{error:'unauthorized'});}
});
test('HTTP hides another actors jobs with 404',async t=>{const {call,setActor}=await setup(t);const id=(await (await call('exports','POST',{})).json()).id;setActor('other');for(const route of [[`exports/${id}`,'GET'],[`exports/${id}/advance`,'POST',{}]]){const r=await call(...route);assert.equal(r.status,404);assert.deepEqual(await r.json(),{error:'job_not_found'});}});
test('HTTP rejects wrong and missing Origin on unsafe methods',async t=>{const {call}=await setup(t);for(const origin of ['https://wrong.test',null]){const r=await call('exports','POST',{},origin);assert.equal(r.status,403);assert.deepEqual(await r.json(),{error:'origin_refused'});}});
test('HTTP bounds streamed bodies before JSON parsing',async t=>{const {call}=await setup(t,{maxBodyBytes:32});const r=await call('exports','POST',JSON.stringify({padding:'x'.repeat(33)}));assert.equal(r.status,413);assert.deepEqual(await r.json(),{error:'body_too_large'});});
test('HTTP requires explicit import confirmation',async t=>{const source=await runtime(t);const a=await archive(await source.connect()),{call}=await setup(t);const r=await call('imports','POST',{manifest:a.manifest});assert.equal(r.status,400);assert.deepEqual(await r.json(),{error:'confirmation_required'});});
test('HTTP success, download and error responses all prevent caching',async t=>{
  const {call}=await setup(t);const created=await call('exports','POST',{});assert.equal(created.headers.get('Cache-Control'),'no-store');const id=(await created.json()).id;
  let r;do{r=await call(`exports/${id}/advance`,'POST',{maxParts:100});}while((await r.clone().json()).phase==='building');
  for(const route of [[`exports/${id}`,'GET'],[`exports/${id}/download`,'GET'],['unknown','GET'],['exports','POST','invalid JSON']]){const response=await call(...route);assert.equal(response.headers.get('Cache-Control'),'no-store');await response.text();}
});

test('HTTP preserves typed authority refusals and distinguishes transient storage failures without leaking diagnostics',async t=>{
 let failure;
 const {call}=await setup(t,{authorize:()=>{throw failure;}});
 const cases=[
  [Object.assign(new Error('private authority context'),{status:401,code:'unauthorized'}),401,'unauthorized'],
  [Object.assign(new Error('private authority context'),{status:403,code:'step_up_required'}),403,'step_up_required'],
  [Object.assign(new Error('private authority context'),{status:429,code:'rate_limited'}),429,'rate_limited'],
  [new Error('private database context',{cause:new Error('D1_ERROR: database is overloaded')}),503,'operation_failed'],
  [Object.assign(new Error('private timeout context'),{name:'TimeoutError'}),504,'operation_failed'],
  [new Error('D1_ERROR: no such table: private_table'),500,'operation_failed'],
  [new TypeError('private programming context'),500,'operation_failed'],
 ];
 for(const [error,status,code] of cases){
  failure=error;
  const response=await call('exports','POST',{}),body=await response.json();
  console.log('export failure:',error.name,error.code??'native','=>',response.status,body.error);
  assert.equal(response.status,status);assert.deepEqual(body,{error:code});
  assert.equal(response.headers.get('Cache-Control'),'no-store');
  assert.doesNotMatch(JSON.stringify(body),/private/);
 }
});
