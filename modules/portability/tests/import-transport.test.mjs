import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPortability,makePart,canonicalJson,MAX_PART_BYTES } from '../index.mjs';
import { ContentVerifier,ArchiveVerifier } from '../format.mjs';
import { database,bundle,rows } from './regression-helpers.mjs';
import { faultDatabase } from './faults.mjs';

test('a large escaped UTF-8 part resumes mid-upload without publishing partial rows',async t=>{
  const policy={product:'fixture',partBytes:MAX_PART_BYTES};
  const target=await database(t,['CREATE TABLE data(id INTEGER PRIMARY KEY,value TEXT)'],policy);
  const empty=await bundle(target.service),manifest=structuredClone(empty.manifest);
  const value=('x'.repeat(1200)+'"'.repeat(100)+'😀東').repeat(116);
  const items=Array.from({length:100},(_,index)=>({kind:'row',table:'data',index,row:{id:index+1,value}}));
  manifest.tables[0].count=items.length;manifest.partCount=1;
  const part=await makePart(0,items);
  assert.ok(Buffer.byteLength(canonicalJson(part))<MAX_PART_BYTES);
  const content=new ContentVerifier(manifest),integrity=new ArchiveVerifier(manifest);
  for(const item of items)content.add(item);integrity.add(part);
  const contentHash=content.digest(),archiveHash=integrity.digest();
  let interrupted=false;
  const db=faultDatabase(target.db,async(sql,commit)=>{
    const result=await commit();
    if(!interrupted && sql.some(s=>s.startsWith('INSERT INTO rer_portability_segments'))){interrupted=true;throw new Error('lost_chunk_ack');}
    return result;
  });
  const service=await createPortability({db,policy}),id=await service.imports.create(manifest);
  await assert.rejects(service.imports.uploadPart(id,0,part),/lost_chunk_ack/);
  assert.equal((await service.imports.status(id)).completed,0);
  assert.equal((await target.db.prepare('SELECT COUNT(*) AS n FROM data').first()).n,0);
  await assert.rejects(service.imports.finalize(id,{archiveHash}),/parts_missing/);
  const altered=await makePart(0,[...items.slice(0,-1),{...items.at(-1),row:{id:100,value:'changed'}}]);
  await assert.rejects(service.imports.uploadPart(id,0,altered),/part_conflict/);
  const resumed=await createPortability({db:target.db,policy});
  await resumed.imports.uploadPart(id,0,part);
  await resumed.imports.uploadPart(id,0,part);
  assert.equal((await target.db.prepare('SELECT COUNT(*) AS n FROM data').first()).n,0);
  assert.equal((await resumed.imports.finalize(id,{contentHash,archiveHash})).phase,'complete');
  const after=await bundle(resumed);
  assert.equal(after.closing.contentHash,contentHash);assert.deepEqual(rows(after),items);
});
