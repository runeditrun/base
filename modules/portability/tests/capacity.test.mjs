import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createPortability,readArchive,canonicalJson } from '../index.mjs';
import { runtime,seed,archive,restore,rows } from './helpers.mjs';
import { fixturePolicy } from './fixture-policy.mjs';
test('export and import resume after client interruption and Miniflare reopen',async t=>{
  const source=await runtime(t);await seed(source);let exportRestarted=false,importRestarted=false;
  const a=await archive(await source.connect(),{interrupt:async()=>{if(!exportRestarted){exportRestarted=true;return source.reopen();}return source.connect();}});
  const target=await runtime(t);await restore(await target.connect(),a,{interrupt:async()=>{if(!importRestarted){importRestarted=true;return target.reopen();}return target.connect();}});
  assert.ok(exportRestarted && importRestarted);assert.equal((await archive(await target.connect())).contentHash,a.contentHash);
});
test('multiple pages across five tables restore in one atomic batch',async t=>{
  // Per-push proof still crosses pages and tables; release proof uses 20k rows.
  const perTable=process.env.PORTABILITY_SCALE==='1'?4000:60;
  const source=await runtime(t),target=await runtime(t),schema=Array.from({length:5},(_,i)=>`CREATE TABLE capacity_${i}(id INTEGER PRIMARY KEY,value TEXT NOT NULL)`);
  for(const f of [source,target])await f.db.batch(schema.map(s=>f.db.prepare(s)));
  for(let table=0;table<5;table++)await source.db.prepare(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<${perTable}) INSERT INTO capacity_${table} SELECT i,'synthetic row '||i FROM n`).run();
  const start=performance.now(),a=await archive(await source.connect());assert.ok(a.parts.length>5,'the restore spans multiple archive pages');
  await restore(await target.connect(),a);const b=await archive(await target.connect());
  assert.equal(b.contentHash,a.contentHash);assert.deepEqual(rows(b),rows(a));
  const bytes=a.records.reduce((sum,r)=>sum+new TextEncoder().encode(canonicalJson(r)+'\n').length,0),elapsed=performance.now()-start;
  console.log(JSON.stringify({capacity:{rows:rows(a).length,tables:5,parts:a.parts.length,archiveBytes:bytes,elapsedMilliseconds:Math.round(elapsed)}}));
});
test('payload bytes and hashes round trip through optional producers and consumers',async t=>{
  let received;const bytes=new Uint8Array(10000).map((_,i)=>i%247),policy={...fixturePolicy,extraPayloads:{named:{produce:()=>bytes,consume:async source=>{received=new Uint8Array(await new Response(source).arrayBuffer());}}}};
  const source=await runtime(t,{policy}),target=await runtime(t,{policy}),a=await archive(await source.connect());await restore(await target.connect(),a);
  assert.deepEqual(received,bytes);assert.equal((await archive(await target.connect())).contentHash,a.contentHash);
});
test('objects beyond five MiB restore through multipart upload with exact metadata',async t=>{
  const policy={...fixturePolicy,partBytes:1024*1024},source=await runtime(t,{policy}),target=await runtime(t,{policy});await seed(source);
  const bytes=new Uint8Array(5*1024*1024+127).map((_,i)=>i%251);await source.bucket.put('large',bytes,{httpMetadata:{contentType:'application/octet-stream',cacheExpiry:new Date('2030-01-01T00:00:00Z')},customMetadata:{purpose:'multipart'}});
  const a=await archive(await source.connect());await restore(await target.connect(),a);const object=await target.bucket.get('large');
  assert.deepEqual(new Uint8Array(await object.arrayBuffer()),bytes);assert.deepEqual(object.customMetadata,{purpose:'multipart'});assert.equal(object.httpMetadata.cacheExpiry.toISOString(),'2030-01-01T00:00:00.000Z');
  assert.equal((await archive(await target.connect())).contentHash,a.contentHash);
});
