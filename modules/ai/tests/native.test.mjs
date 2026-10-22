import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeRuntime, declaration, authority, samplePng } from './native-runtime.mjs';
const text = command => ({action:'text',purpose:'site-read',command,input:'Synthetic site data'});
const image = command => ({action:'generate',purpose:'house-style',command,input:'Synthetic house style'});
const post = (r,body,extra={}) => r.call('/api/ai',{body,cookie:r.cookie,...extra});
const output = (usage={prompt_tokens:12,completion_tokens:8})=>Response.json({choices:[{message:{role:'assistant',content:'Synthetic summary'},finish_reason:'stop'}],...(usage?{usage}:{})});

test('reference app requires current owner, same origin and trusted declaration before native effects',async t=>{
 const r=await nativeRuntime(t);
 for(const options of [{cookie:undefined},{origin:'https://other.test'},{body:{...text('override'),tenant:'other'}},{body:{...text('override'),model:'arbitrary'}},{body:{...text('override'),prices:{}}}]){
  const response=await post(r,options.body??text('unauthorized'),options);assert.ok(response.status>=400);assert.match(response.headers.get('cache-control'),/no-store/);
 }
 assert.equal(r.hits.length,0);
 await r.db.prepare("UPDATE oa_operators SET role='member'").run();
 assert.equal((await post(r,text('member'))).status,403);
 await r.db.prepare("UPDATE oa_operators SET role='owner'").run();
 await r.db.prepare('UPDATE oa_sessions SET revoked_at=?').bind(Date.now()).run();
 assert.equal((await post(r,image('revoked'))).status,403);
 assert.equal((await r.call('/api/ai?purpose=house-style',{cookie:r.cookie})).status,403);
 assert.equal(r.hits.length,0);
});

test('two dependent text calls reserve atomically, settle usage and deduplicate through restart',async t=>{
 const request={...declaration,limits:{...declaration.limits,calls:2}};
 const r=await nativeRuntime(t,{request});
 const responses=await Promise.all([post(r,text('first')),post(r,text('second'))]);
 assert.deepEqual(responses.map(x=>x.status).sort(),[200,402]);
 assert.equal(r.hits.length,2);
 assert.match(r.hits[1].input.messages[1].content,/Synthetic summary/);
 const before=await r.status();assert.equal(before.totals.calls,2);assert.equal(before.calls.filter(c=>c.status==='settled').length,2);
 await r.restart();
 assert.deepEqual(await r.status(),before);
 assert.ok((await post(r,text('first'))).status>=400);assert.equal(r.hits.length,2);
 assert.ok(!JSON.stringify(before).includes('Synthetic site data'));
});

test('uncertain, partial and excessive usage keep liability, never retry, and fence late settlement',async t=>{
 for(const mode of ['missing','error','partial','excess','late'])await t.test(mode,async t=>{
  const request={...declaration,operations:{...declaration.operations,timeoutMs:50}};
  const r=await nativeRuntime(t,{request,provider:async(_,n)=>{
   if(mode==='missing')return output(null);
   if(mode==='error')return new Response('synthetic-secret-sentinel',{status:500});
   if(mode==='partial'&&n===2)return output(null);
   if(mode==='excess')return output({prompt_tokens:300000,completion_tokens:9000});
   if(mode==='late'){await new Promise(resolve=>setTimeout(resolve,150));return output();}
   return output();
  }});
  assert.ok((await post(r,text('uncertain'))).status>=400);
  const count=r.hits.length;
  assert.ok((await post(r,text('uncertain'))).status>=400);assert.equal(r.hits.length,count);
  if(mode==='late')await new Promise(resolve=>setTimeout(resolve,180));
  const state=await r.status();
  if(mode==='excess'){assert.equal(state.frozen,true);assert.ok(state.totals.units>262144);}
  else if(mode==='partial'){assert.equal(state.calls[0].status,'settled');assert.equal(state.calls[1].status,'uncertain');}
  else if(mode==='late'){assert.equal(state.calls[0].status,'settled');assert.equal(state.calls[1].status,'unsent');}
  else {assert.equal(state.calls[0].status,'uncertain');assert.equal(state.calls[1].status,'unsent');assert.equal(state.totals.calls,1);}
  assert.ok(!JSON.stringify(state).includes('synthetic-secret-sentinel'));
  await r.restart();assert.deepEqual(await r.status(),state);
 });
});

test('stable private image purpose dispatches once, reuses R2, and refuses changed input or public drift',async t=>{
 const r=await nativeRuntime(t);
 const results=await Promise.all([post(r,image('one')),post(r,image('two'))]);
 assert.ok(results.some(r=>r.status===200));assert.equal(r.hits.length,1);
 assert.equal((await post(r,image('three'))).status,200);assert.equal(r.hits.length,1);
 assert.equal((await post(r,{...image('four'),input:'different'})).status,409);
 await r.restart();
 const response=await r.call('/api/ai?purpose=house-style',{cookie:r.cookie});
 assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),samplePng());assert.match(response.headers.get('cache-control'),/private, no-store/);
 assert.equal((await r.call('/api/ai?purpose=house-style&key=arbitrary',{cookie:r.cookie})).status,400);
 assert.equal((await r.call('/api/ai?purpose=house-style')).status,403);
 r.public(true);
 assert.equal((await r.call('/api/ai?purpose=house-style',{cookie:r.cookie})).status,503);
 assert.equal((await post(r,image('five'))).status,503);assert.equal(r.hits.length,1);
});

test('invalid images leave a durable purpose tombstone without overwrite or regeneration',async t=>{
 for(const invalid of [{image:'<svg/>'},{image:samplePng().subarray(0,60).toString('base64')},{url:'https://provider.test/secret'}])await t.test('invalid output',async t=>{
  const r=await nativeRuntime(t,{provider:()=>Response.json(invalid)});
  assert.equal((await post(r,image('first'))).status,422);
  assert.equal((await r.bucket.list()).objects.length,0);
  await r.restart();assert.equal((await post(r,image('second'))).status,409);assert.equal(r.hits.length,1);
  const state=await r.status();assert.equal(state.calls[0].status,'uncertain');assert.equal(state.totals.calls,1);
 });
});

test('opt-out, expired prices, unproved models and unsupported dev/demo refuse before dispatch',async t=>{
 for(const change of [
  {policy:{...authority,enabled:false}},
  {policy:{...authority,prices:{}}},
  {policy:{...authority,proofs:{}}},
  {bindings:{AUTH_LOCAL:'true'}},
  {bindings:{RER_DEMO:'true'}},
 ])await t.test('refusal',async t=>{
  const r=await nativeRuntime(t,change);assert.ok((await post(r,text('blocked'))).status>=400);assert.equal(r.hits.length,0);
 });
});
