import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Objects } from '../adapters/objects.mjs';
test('persistent objects retain conditional writes, ranges and multipart uploads across reopening',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'rer-objects-'));let db=new DatabaseSync(join(directory,'index.sqlite'));
 try {
  let store=new Objects(db,join(directory,'objects'),'files');const original=await store.put('document','abcdef');
  assert.equal(await store.put('document','wrong',{onlyIf:{etagMatches:'unmatched'}}),null);
  assert.equal(await (await store.get('document',{range:{offset:1,length:3}})).text(),'bcd');
  const multipart=await store.createMultipartUpload('bundle'),first=await multipart.uploadPart(1,'first'),second=await multipart.uploadPart(2,'second');
  await writeFile(join(directory,'objects','interrupted.partial'),'unfinished');db.close();db=new DatabaseSync(join(directory,'index.sqlite'));store=new Objects(db,join(directory,'objects'),'files');await store.recover();
  assert.equal((await store.head('document')).etag,original.etag);assert.equal(await(await store.get('document')).text(),'abcdef');
  await store.resumeMultipartUpload('bundle',multipart.uploadId).complete([first,second]);assert.equal(await(await store.get('bundle')).text(),'firstsecond');
  const changed=await store.put('document','updated',{onlyIf:{etagMatches:original.etag}});assert.ok(changed);assert.equal(await(await store.get('document')).text(),'updated');
  await store.delete('bundle');assert.equal(await store.get('bundle'),null);
 }finally{db.close();await rm(directory,{recursive:true,force:true});}
});
