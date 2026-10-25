import test from 'node:test';
import assert from 'node:assert/strict';
import { createPortabilityHandler } from '../index.mjs';
import { database,bundle } from './regression-helpers.mjs';
import { ddl,policy,seed } from './fixtures/erasure-hook.mjs';

const route=async(target,input=policy)=>{
  const handler=await createPortabilityHandler({db:target.db,policy:input,appOrigin:'https://app.test',authorize:request=>request.headers.get('X-Fixture-Actor')});
  return (path,method='GET',body,actor='owner')=>handler(new Request('https://app.test/api/portability/'+path,{
    method,headers:{Origin:'https://app.test',...(actor?{'X-Fixture-Actor':actor}:{})},body:body===undefined?undefined:JSON.stringify(body),
  }));
};
test('owner reclaims verified staging and restores an old archive through the seed erasure hook',async t=>{
  let now=Date.now();t.mock.method(Date,'now',()=>now);
  const source=await database(t,ddl,policy),target=await database(t,ddl,policy);await seed(source.db);
  const archive=await bundle(source.service),call=await route(target);
  await target.db.prepare("INSERT INTO erased_accounts VALUES('opaque-erased')").run();
  const id=(await (await call('imports','POST',{confirmed:true,manifest:archive.manifest})).json()).id;
  await call(`imports/${id}/parts/0`,'PUT',archive.parts[0]);
  assert.equal((await call(`imports/${id}/reclaim`,'POST')).status,409);
  now+=6*60*1000;
  assert.equal((await call(`imports/${id}/reclaim`,'POST',undefined,null)).status,401);
  assert.equal((await call(`imports/${id}/reclaim`,'POST',undefined,'other')).status,404);
  const winners=await Promise.all([call(`imports/${id}/reclaim`,'POST'),call(`imports/${id}/reclaim`,'POST')]);
  assert.deepEqual(winners.map(r=>r.status).sort(),[200,409]);
  const resumed=await winners.find(r=>r.status===200).json();assert.equal(resumed.completed,1);
  for(const part of archive.parts.slice(resumed.completed))assert.equal((await call(`imports/${id}/parts/${part.index}`,'PUT',part)).status,200);
  assert.equal((await call(`imports/${id}/finalize`,'POST',archive.closing)).status,200);
  const rows=async table=>(await target.db.prepare(`SELECT * FROM ${table}`).all()).results;
  assert.deepEqual(await rows('accounts'),[{id:'opaque-erased',state:'erased'},{id:'opaque-live',state:'active'}]);
  assert.equal((await rows('credentials')).length,1);assert.equal((await rows('delegations')).length,0);
  assert.deepEqual(await rows('erased_accounts'),[{id:'opaque-erased'}]);
  const audit=await rows('rer_portability_restore_audit');assert.equal(audit.length,1);
  assert.equal(audit[0].opaque_id,'opaque-erased');assert.deepEqual(Object.values(JSON.parse(audit[0].revocations)),Array(8).fill(1));
  assert.equal((await call(`imports/${id}/finalize`,'POST',archive.closing)).status,200);
  assert.equal((await rows('rer_portability_restore_audit')).length,1);
  assert.equal((await call(`imports/${id}/reclaim`,'POST')).status,409);
});
test('a seed hook failure aborts the restore before any activation or live audit',async t=>{
  const source=await database(t,ddl,policy),target=await database(t,ddl,policy);await seed(source.db);
  const archive=await bundle(source.service),call=await route(target,{...policy,restoreHook:{...policy.restoreHook,
    async run(context){await policy.restoreHook.run(context);throw Error('fixture removal failure');},
  }});
  await target.db.prepare("INSERT INTO erased_accounts VALUES('opaque-erased')").run();
  const id=(await (await call('imports','POST',{confirmed:true,manifest:archive.manifest})).json()).id;
  for(const part of archive.parts)await call(`imports/${id}/parts/${part.index}`,'PUT',part);
  const failed=await call(`imports/${id}/finalize`,'POST',archive.closing);
  assert.equal(failed.status,409);assert.deepEqual(await failed.json(),{error:'restore_hook_failed'});
  assert.equal((await target.service.imports.status(id)).phase,'aborted');
  for(const table of ['accounts','credentials','delegations','rer_portability_restore_audit'])
    assert.equal((await target.db.prepare(`SELECT count(*) AS n FROM ${table}`).first()).n,0);
  assert.equal((await target.db.prepare('SELECT count(*) AS n FROM erased_accounts').first()).n,1);
  assert.equal((await call(`imports/${id}/reclaim`,'POST')).status,409);
});
