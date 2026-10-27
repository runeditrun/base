import { runCases } from './cases.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPortability, createPortabilityHandler } from '../index.mjs';
import { database, bundle, stage } from './regression-helpers.mjs';

const ddl=['CREATE TABLE notes(id TEXT PRIMARY KEY,body TEXT)'];
const policy={product:'lease-fixture',buckets:{FILES:{}}};
async function setup(t) {
  let now=Date.now();t.mock.method(Date,'now',()=>now);
  const source=await database(t,ddl,policy),target=await database(t,ddl,policy);
  await source.db.prepare("INSERT INTO notes VALUES('note-1','Retained owner note')").run();
  await source.bucket.put('attachment','Retained attachment');
  return {source,target,archive:await bundle(source.service),elapse(){now+=10*60*1000;},advance(ms){now+=ms;}};
}
const objects=async bucket=>(await bucket.list()).objects.map(o=>o.key);
const rows=async db=>(await db.prepare('SELECT * FROM notes').all()).results;
const staging=async db=>(await db.prepare("SELECT name FROM sqlite_master WHERE name GLOB 'rer_portability_stage_*'").all()).results;

test("restore lease ownership survives expiration, restart and competing requests", async t => {
  const foldedCases = [];
foldedCases.push(['a new import reclaims expired staging and can restore the archive', async t=>{
  const {target,archive,elapse}=await setup(t),old=await stage(target.service,archive);
  assert.ok((await staging(target.db)).length);
  elapse();
  const id=await target.service.imports.create(archive.manifest);
  assert.equal((await target.service.imports.status(old)).phase,'aborted');
  assert.equal((await target.db.prepare('SELECT COUNT(*) AS n FROM rer_portability_segments WHERE job=?').bind(old).first()).n,0);
  assert.equal((await target.db.prepare('SELECT COUNT(*) AS n FROM rer_portability_parts WHERE job=?').bind(old).first()).n,0);
  assert.ok((await staging(target.db)).every(r=>!r.name.includes(old.replaceAll('-',''))));
  for(const part of archive.parts)await target.service.imports.uploadPart(id,part.index,part);
  assert.equal((await target.service.imports.finalize(id,archive.closing)).phase,'complete');
  assert.deepEqual(await rows(target.db),[{id:'note-1',body:'Retained owner note'}]);
  assert.deepEqual(await objects(target.bucket),['attachment']);
}]);
foldedCases.push(['a fresh lease blocks another import and reports when the owner can abort it', async t=>{
  const {target,archive,advance}=await setup(t),id=await target.service.imports.create(archive.manifest);
  advance(2*60*1000);await target.service.imports.uploadPart(id,0,archive.parts[0]);
  advance(4*60*1000); // Beyond creation's lease, still within the renewed lease.
  await assert.rejects(target.service.imports.create(archive.manifest),e=>{
    assert.equal(e.code,'import_running');assert.equal(e.status,409);
    assert.equal(e.jobId,id);assert.ok(Date.parse(e.abortableAt)>Date.now());return true;
  });
  const status=await target.service.imports.status(id);
  assert.equal(status.stale,false);assert.ok(Date.parse(status.abortableAt)>Date.now());
}]);
foldedCases.push(['expired uploads and finalize cannot revive or publish an abandoned import', async t=>{
  await runCases(t, [
    ['expired finalize cannot publish', async t => {
      const {target,archive,elapse}=await setup(t),id=await stage(target.service,archive);
      elapse();
      await assert.rejects(target.service.imports.finalize(id,archive.closing),e=>e.code==='import_lease_expired' && e.status===409);
    }],
    ['expired upload cannot revive staging', async t => {
      const {target,archive,elapse}=await setup(t),id=await stage(target.service,archive);
      elapse();
      await assert.rejects(target.service.imports.uploadPart(id,0,archive.parts[0]),e=>e.code==='import_lease_expired');
      assert.deepEqual(await rows(target.db),[]);assert.deepEqual(await objects(target.bucket),[]);
    }],
  ]);
}]);
foldedCases.push(['a worker lost after object apply is reclaimed through owned-object abort, preserving foreign data', async t=>{
  const {target,archive,elapse}=await setup(t);let offline=false;
  const db={prepare(sql){const raw=target.db.prepare(sql);const wrap=q=>({
    raw:q,bind:(...args)=>wrap(q.bind(...args)),all:()=>q.all(),run:()=>q.run(),
    first:(...args)=>offline?Promise.reject(new Error('worker_lost')):q.first(...args),
  });return wrap(raw);},batch:statements=>target.db.batch(statements.map(q=>q.raw))};
  const bucket={get:(...args)=>target.bucket.get(...args),list:(...args)=>target.bucket.list(...args),delete:(...args)=>target.bucket.delete(...args),
    async put(...args){await target.bucket.put(...args);offline=true;throw new Error('worker_lost');}};
  const service=await createPortability({db,buckets:{FILES:bucket},policy}),id=await stage(service,archive);
  await assert.rejects(service.imports.finalize(id,archive.closing),/worker_lost/);
  assert.equal((await target.service.imports.status(id)).phase,'applying');
  assert.deepEqual(await objects(target.bucket),['attachment']);assert.deepEqual(await rows(target.db),[]);
  await target.bucket.put('foreign','Keep this object');elapse();
  const next=await target.service.imports.create(archive.manifest);
  assert.notEqual(next,id);assert.equal((await target.service.imports.status(id)).phase,'aborted');
  assert.deepEqual(await objects(target.bucket),['foreign']);
  assert.equal(await (await target.bucket.get('foreign')).text(),'Keep this object');
  assert.equal((await target.db.prepare('SELECT applying FROM rer_portability_state').first()).applying,0);
  assert.deepEqual(await rows(target.db),[]);
}]);
foldedCases.push(['the authenticated owner can discover, inspect and abort a stale import through HTTP', async t=>{
  const {target,archive,elapse}=await setup(t);let actor='owner';
  const handler=await createPortabilityHandler({db:target.db,buckets:{FILES:target.bucket},policy,appOrigin:'https://app.test',authorize:()=>actor});
  const call=(path,method='GET',body,origin='https://app.test')=>handler(new Request('https://app.test/api/portability/'+path,{method,headers:{Origin:origin},body:body===undefined?undefined:JSON.stringify(body)}));
  const id=(await (await call('imports','POST',{confirmed:true,manifest:archive.manifest})).json()).id;
  const blocked=await call('imports','POST',{confirmed:true,manifest:archive.manifest});
  assert.equal(blocked.status,409);assert.equal((await blocked.json()).jobId,id);
  elapse();assert.equal((await (await call('imports/'+id)).json()).stale,true);
  const discovered=(await (await call('imports')).json()).active;
  assert.equal(discovered.id,id);assert.equal(discovered.stale,true);
  actor=null;assert.equal((await call('imports/'+id+'/abort','POST')).status,401);
  actor='other';assert.equal((await call('imports/'+id+'/abort','POST')).status,404);
  assert.deepEqual(await (await call('imports')).json(),{active:null});
  actor='owner';assert.equal((await call('imports/'+id+'/abort','POST',undefined,'https://wrong.test')).status,403);
  assert.equal((await (await call('imports/'+id+'/abort','POST')).json()).phase,'aborted');
  assert.deepEqual(await (await call('imports')).json(),{active:null});
  assert.equal((await call('imports','POST',{confirmed:true,manifest:archive.manifest})).status,201);
}]);
foldedCases.push(['an active finalize renews across a long callback and excludes concurrent abort and finalize', async t=>{
  await runCases(t, [
    ['active finalize excludes create across renewed lease', async t => {
      const {target,archive,advance}=await setup(t),paused=await pausedFinalize(target,archive),scheduled=heartbeats(t);
      const finishing=paused.service.imports.finalize(paused.id,archive.closing);await paused.entered;
      try {
        for(let minute=0;minute<8;minute++){advance(60*1000);assert.ok(scheduled.length);await scheduled.shift()();}
        const status=await target.service.imports.status(paused.id);assert.equal(status.stale,false);
        await assert.rejects(target.service.imports.create(archive.manifest),e=>e.code==='import_running');
      } finally { paused.release();await finishing; }
      assert.equal((await finishing).phase,'complete');
    }],
    ['active finalize excludes abort', async t => {
      const {target,archive}=await setup(t),paused=await pausedFinalize(target,archive);heartbeats(t);
      const finishing=paused.service.imports.finalize(paused.id,archive.closing);await paused.entered;
      try {
        await assert.rejects(target.service.imports.abort(paused.id),e=>e.code==='import_running');
      } finally { paused.release();await finishing; }
    }],
    ['active finalize excludes another finalize', async t => {
      const {target,archive}=await setup(t),paused=await pausedFinalize(target,archive);heartbeats(t);
      const finishing=paused.service.imports.finalize(paused.id,archive.closing);await paused.entered;
      try {
        await assert.rejects(target.service.imports.finalize(paused.id,archive.closing),e=>e.code==='import_running');
      } finally { paused.release();await finishing; }
    }],
  ]);
}]);
foldedCases.push(['a request that lost its lease cannot publish after its replacement restores', async t=>{
  const {target,archive,elapse}=await setup(t),paused=await pausedFinalize(target,archive);heartbeats(t);
  const finishing=paused.service.imports.finalize(paused.id,archive.closing);await paused.entered;
  elapse();const replacement=await stage(target.service,archive);
  assert.equal((await target.service.imports.finalize(replacement,archive.closing)).phase,'complete');
  paused.release();await assert.rejects(finishing,e=>e.code==='import_lease_expired');
  assert.equal((await target.service.imports.status(paused.id)).phase,'aborted');
  assert.equal((await target.service.imports.status(replacement)).phase,'complete');
  assert.deepEqual(await rows(target.db),[{id:'note-1',body:'Retained owner note'}]);
  assert.deepEqual(await objects(target.bucket),['attachment']);
}]);
  await runCases(t, foldedCases);
});









// Control only the import heartbeat; Miniflare's own timers stay real.
function heartbeats(t) {
  const scheduled=[],set=globalThis.setTimeout;
  t.mock.method(globalThis,'setTimeout',(fn,delay,...args)=>{
    if(delay===30*1000){scheduled.push(fn);return 0;}
    return set(fn,delay,...args);
  });
  return scheduled;
}
async function pausedFinalize(target,archive) {
  let enter,release;
  const entered=new Promise(resolve=>{enter=resolve;}),waiting=new Promise(resolve=>{release=resolve;});
  const service=await createPortability({db:target.db,buckets:{FILES:target.bucket},policy:{...policy,validateStaged:async()=>{enter();await waiting;}}});
  const id=await stage(service,archive);
  return {id,service,entered,release};
}
