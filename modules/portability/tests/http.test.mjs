import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPortabilityHandler, PortabilityError } from '../index.mjs';
import { runtime,seed,archive } from './helpers.mjs';
import { fixturePolicy } from './fixture-policy.mjs';
import { AuthError } from '../../operator-auth/errors.mjs';
async function setup(t,{maxBodyBytes,authorize,policy=fixturePolicy}={}) {
  const f=await runtime(t,{policy});let actor='owner',calls=[];
  const handler=await createPortabilityHandler({db:f.db,buckets:{FILES:f.bucket},policy,appOrigin:'https://app.test',maxBodyBytes,
    authorize:authorize??((request,context)=>{calls.push(context);return actor;})});
  const call=(path,method='GET',body,origin='https://app.test')=>handler(new Request('https://app.test/api/portability/'+path,{method,headers:origin?{Origin:origin}:{},body:body===undefined?undefined:typeof body==='string'?body:JSON.stringify(body)}));
  return {f,handler,call,calls,setActor(value){actor=value;}};
}
test('HTTP returns null for paths owned by other dispatchers',async t=>{const {handler}=await setup(t);assert.equal(await handler(new Request('https://app.test/other')),null);assert.equal(await handler(new Request('https://app.test/api/portability-other')),null);});
test('HTTP checks authorization on every route; null actors receive 401 and no-store',async t=>{
  const source=await runtime(t);await seed(source);const bundle=await archive(await source.connect()),{call,calls,setActor}=await setup(t);
  const exportId=(await (await call('exports','POST',{})).json()).id,importId=(await (await call('imports','POST',{confirmed:true,manifest:bundle.manifest,acknowledgeUnverifiedSchemaObjects:true})).json()).id;
  const routes=[['exports','POST',{}],['exports/'+exportId,'GET'],['exports/'+exportId+'/advance','POST',{}],['exports/'+exportId+'/download','GET'],['exports/'+exportId+'/abort','POST',{}],
    ['imports','POST',{confirmed:true,manifest:bundle.manifest,acknowledgeUnverifiedSchemaObjects:true}],['imports/'+importId,'GET'],['imports/'+importId+'/parts/0','PUT',bundle.parts[0]],['imports/'+importId+'/finalize','POST',{}],['imports/'+importId+'/abort','POST',{}]];
  setActor(null);for(const route of routes){const before=calls.length,response=await call(...route);assert.equal(response.status,401);assert.equal(calls.length,before+1);assert.equal(response.headers.get('Cache-Control'),'no-store');assert.deepEqual(await response.json(),{error:'unauthorized'});}
});

test('HTTP redacts arbitrary typed codes and unwraps authority causes', async t => {
 let failure;
 const {call} = await setup(t, {authorize: () => { throw failure; }});
 const typed = Object.assign(new Error('private authority context'), {status: 403, code: 'private_token_abc123'});
 const wrappers = [
  ['direct', error => error],
  ['Error cause', error => new Error('private wrapper', {cause: error})],
  ['structural cause', error => ({cause: error})],
  ['nested cause', error => new Error('private outer', {cause: new Error('private inner', {cause: error})})],
 ];
 for (const [label, wrap] of wrappers) await t.test(label, async t => {
  for (const [error, status, code] of [[typed, 403, 'operation_failed'], [new PortabilityError('private_token_abc123', 403), 403, 'operation_failed'], [new AuthError('forbidden', 403), 403, 'forbidden'], [new AuthError('unauthenticated', 401), 401, 'unauthenticated']]) await t.test(error.constructor.name + ': ' + code, async () => {
   failure = wrap(error);
   const response = await call('exports', 'POST', {}), text = await response.text();
   console.log(label, status, '=>', response.status, text);
   assert.equal(response.status, status); assert.deepEqual(JSON.parse(text), {error: code});
   assert.doesNotMatch(text + JSON.stringify([...response.headers]), /private|abc123/);
  });
 });
});
test('HTTP authorization failures cannot impersonate import lease metadata',async t=>{
 let failure;
 const {call}=await setup(t,{authorize:()=>{throw failure;}}),sentinel='private-lease-sentinel';
 const wrappers=[['direct',error=>error],['Error',error=>Object.assign(new Error('private wrapper',{cause:error}),{status:500})],
  ['structural',error=>({status:502,cause:error})],['nested',error=>new Error('private outer',{cause:{cause:new Error('private inner',{cause:error})}})]];
 const results=[];
 for(const status of [403,401])for(const [kind,make] of [
  ['PortabilityError',code=>new PortabilityError(code,status)],['AuthError',code=>new AuthError(code,status)],
  ['Error',code=>Object.assign(new Error(code),{status,code})],['non-Error',code=>({status,code})],
  ['prototype',code=>Object.assign(Object.create(PortabilityError.prototype),{status,code})],
 ])for(const [wrapper,wrap] of wrappers){
  failure=wrap(Object.assign(make('import_running:'+sentinel),{jobId:sentinel,abortableAt:sentinel}));
  const response=await call('imports','POST',{}),text=await response.text(),headers=[...response.headers];
  console.log('authority lease:',kind,wrapper,status,'=>',response.status,text,JSON.stringify(headers));
  results.push({response,text,headers,status});
 }
 for(const {response,text,headers,status} of results){
  assert.equal(response.status,status);assert.deepEqual(JSON.parse(text),{error:'import_running'});
  assert.equal(response.headers.get('Cache-Control'),'no-store');assert.doesNotMatch(text+JSON.stringify(headers),/private|sentinel/);
 }
});
test('HTTP publishes genuine import lease details after authorization and suppresses replays during authorization',async t=>{
 let failure,validationFailure,actor='owner';
 const source=await runtime(t),bundle=await archive(await source.connect()),{call,f}=await setup(t,{
  authorize:()=>{if(failure)throw failure;return actor;},policy:{...fixturePolicy,validateStaged:()=>{if(validationFailure)throw validationFailure;}},
 });
 const body={confirmed:true,manifest:bundle.manifest,acknowledgeUnverifiedSchemaObjects:true},created=await call('imports','POST',body),id=(await created.json()).id;
 assert.equal(created.status,201);
 const status=await (await call('imports/'+id)).json(),blocked=await call('imports','POST',body);
 assert.equal(blocked.status,409);assert.deepEqual(await blocked.json(),{error:'import_running',jobId:id,abortableAt:status.abortableAt});
 assert.ok(Date.parse(status.abortableAt)>Date.now());
 actor='other';
 const other=await call('imports','POST',body),otherText=await other.text();
 console.log('another actor lease:',other.status,otherText);
 assert.equal(other.status,409);assert.deepEqual(JSON.parse(otherText),{error:'import_running'});assert.ok(!otherText.includes(id));
 assert.equal(other.headers.get('Cache-Control'),'no-store');
 let refusal;try{await (await f.connect()).imports.create(bundle.manifest,'owner');}catch(error){refusal=error;}
 assert.ok(refusal instanceof PortabilityError);
 const results=[];
 for(const currentActor of ['owner','other'])for(const wrap of [error=>error,error=>new Error('private wrapper',{cause:error}),error=>({cause:error}),error=>new Error('private outer',{cause:{cause:error}})]){
  actor=currentActor;
  failure=wrap(refusal);
  const response=await call('imports','POST',body),text=await response.text();
  console.log('replayed lease:',actor,response.status,text);
  results.push({response,text});
 }
 for(const {response,text} of results){assert.equal(response.status,409);assert.deepEqual(JSON.parse(text),{error:'import_running'});assert.ok(!text.includes(id));}
 failure=undefined;actor='owner';
 for(const part of bundle.parts)assert.equal((await call('imports/'+id+'/parts/'+part.index,'PUT',part)).status,200);
 for(const error of [new PortabilityError('import_running',409),new AuthError('import_running',409),{status:409,code:'import_running'}]){
  validationFailure=Object.assign(error,{jobId:'private-lease-sentinel',abortableAt:new Date(Date.now()+60000).toISOString()});
  const response=await call('imports/'+id+'/finalize','POST',bundle.closing),text=await response.text();
  console.log('untrusted staged lease:',response.status,text);
  assert.equal(response.status,409);assert.deepEqual(JSON.parse(text),{error:'import_running'});assert.doesNotMatch(text,/private|sentinel/);
 }
});
test('HTTP hides another actors jobs with 404',async t=>{const {call,setActor}=await setup(t);const id=(await (await call('exports','POST',{})).json()).id;setActor('other');for(const route of [[`exports/${id}`,'GET'],[`exports/${id}/advance`,'POST',{}]]){const r=await call(...route);assert.equal(r.status,404);assert.deepEqual(await r.json(),{error:'job_not_found'});}});
test('HTTP rejects wrong and missing Origin on unsafe methods',async t=>{const {call}=await setup(t);for(const origin of ['https://wrong.test',null]){const r=await call('exports','POST',{},origin);assert.equal(r.status,403);assert.deepEqual(await r.json(),{error:'origin_refused'});}});
test('HTTP bounds streamed bodies before JSON parsing',async t=>{const {call}=await setup(t,{maxBodyBytes:32});const r=await call('exports','POST',JSON.stringify({padding:'x'.repeat(33)}));assert.equal(r.status,413);assert.deepEqual(await r.json(),{error:'body_too_large'});});
test('HTTP requires explicit import confirmation',async t=>{const source=await runtime(t);const a=await archive(await source.connect()),{call}=await setup(t);const r=await call('imports','POST',{manifest:a.manifest,acknowledgeUnverifiedSchemaObjects:true});assert.equal(r.status,400);assert.deepEqual(await r.json(),{error:'confirmation_required'});});
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
  [Object.assign(new Error('private server wrapper',{cause:new AuthError('step_up_required:private',403)}),{status:500,code:'operation_failed'}),403,'step_up_required'],
  [{status:502,cause:{cause:new AuthError('unauthenticated:private',401)}},401,'unauthenticated'],
  [Object.assign(new Error('private bad request',{cause:new AuthError('unauthenticated',401)}),{status:400,code:'confirmation_required:private'}),400,'confirmation_required'],
  [{status:400,code:'confirmation_required:private',cause:new AuthError('forbidden',403)},400,'confirmation_required'],
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
