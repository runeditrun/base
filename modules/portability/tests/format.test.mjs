import { test } from 'node:test';
import assert from 'node:assert/strict';
import { archiveLines,readArchive,makePart,canonicalJson,sha256 } from '../index.mjs';
import { ContentVerifier,ArchiveVerifier,checkPart } from '../format.mjs';
import { StreamHash,unbase64 } from '../hash.mjs';
import { validateRow } from '../catalogue.mjs';
import { bytesStream,bundleStream,collect } from './helpers.mjs';
async function fixture() {
  const table={name:'data',sql:'CREATE TABLE data(id INTEGER PRIMARY KEY,data BLOB)',columns:[{name:'id',type:'INTEGER',pk:1,notnull:0},{name:'data',type:'BLOB',pk:0,notnull:0}],dependencies:[],count:2};
  const manifest={kind:'manifest',format:'runeditrun-portability',version:2,product:'fixture',sourceIdentity:'source',exportedAt:new Date().toISOString(),schema:await sha256(canonicalJson([{name:table.name,sql:table.sql}])),tables:[table],objects:[],payloads:[],excludedColumns:{},excludedTables:[],requiredConfiguration:[],partCount:2,epoch:0,journal:[]};
  const parts=await Promise.all([0,1].map(index=>makePart(index,[{kind:'row',table:'data',index,row:{id:index+1,data:{blob:'AAH/gA=='}}}])));
  const verifier=new ContentVerifier(manifest);parts.forEach(p=>p.items.forEach(item=>verifier.add(item)));
  const integrity=new ArchiveVerifier(manifest);parts.forEach(p=>integrity.add(p));
  return [manifest,...parts,{kind:'closing',partCount:2,contentHash:verifier.digest(),archiveHash:integrity.digest()}];
}
test('bounded reader rejects an over-long line',async()=>{await assert.rejects(collect(archiveLines(bytesStream('12345\n'),4)),/exceeds/);});
test('bounded reader rejects invalid UTF-8 as malformed archive text',async()=>{await assert.rejects(collect(archiveLines(new Response(Uint8Array.of(255,10)).body,10)),/^Error: archive_json$/);});
test('bounded reader accepts fragmented UTF-8, CRLF and final unterminated lines',async()=>{
  const bytes=new TextEncoder().encode('🙂\r\nlast'),source=new ReadableStream({start(c){for(const b of bytes)c.enqueue(Uint8Array.of(b));c.close();}});
  assert.deepEqual(await collect(archiveLines(source,16)),['🙂','last']);
  await assert.rejects(collect(archiveLines(bytesStream('x'),0)),/Invalid/);
});
test('archive reader refuses a missing part',async()=>{const a=await fixture();a.splice(2,1);await assert.rejects(collect(readArchive(bundleStream(a))),/part_count/);});
test('archive reader refuses an extra part',async()=>{const a=await fixture();a.splice(3,0,await makePart(2,a[1].items));await assert.rejects(collect(readArchive(bundleStream(a))),/extra_part/);});
test('archive reader refuses a part out of order',async()=>{const a=await fixture();[a[1],a[2]]=[a[2],a[1]];await assert.rejects(collect(readArchive(bundleStream(a))),/part_order/);});
test('archive reader refuses a checksum mismatch',async()=>{const a=await fixture();a[1].items[0].row.id=9;await assert.rejects(collect(readArchive(bundleStream(a))),/part_checksum/);});
test('archive reader refuses data after closing',async()=>{const a=await fixture();a.push(a[1]);await assert.rejects(collect(readArchive(bundleStream(a))),/data_after_closing/);});
test('archive reader refuses missing closing and content mismatch',async()=>{
  const a=await fixture();await assert.rejects(collect(readArchive(bundleStream(a.slice(0,-1)))),/closing_missing/);
  a.at(-1).contentHash='0'.repeat(64);await assert.rejects(collect(readArchive(bundleStream(a))),/content_checksum/);
});
test('unsafe integers are refused by column name',async()=>{const [m]=await fixture();assert.throws(()=>validateRow(m.tables[0],{id:2**53,data:null}),/unsafe_integer:data:id/);});
test('BLOB cells round trip without string coercion',async()=>{const a=await collect(readArchive(bundleStream(await fixture())));assert.deepEqual([...unbase64(a[1].items[0].row.data.blob)],[0,1,255,128]);});
test('content equivalence ignores boundaries and source metadata while archive integrity binds them',async()=>{
  const a=await fixture(),b=structuredClone(a[0]);b.exportedAt='other time';b.sourceIdentity='other source';b.partCount=1;
  const part=await makePart(0,[...a[1].items,...a[2].items]),v=new ContentVerifier(b);part.items.forEach(x=>v.add(x));
  assert.equal(v.digest(),a.at(-1).contentHash);
  const integrity=new ArchiveVerifier(b);integrity.add(part);
  assert.notEqual(integrity.digest(),a.at(-1).archiveHash);
});
test('streaming SHA-256 agrees with Web Crypto across block boundaries',async()=>{
  for(const n of [0,1,55,56,63,64,65,128,10000]){const bytes=new Uint8Array(n).map((_,i)=>i%251),hash=new StreamHash();for(let i=0;i<n;i+=17)hash.update(bytes.subarray(i,i+17));assert.equal(hash.digest(),await sha256(bytes));}
});
test('content and archive digests agree with independent canonical JSON hashing',async()=>{
  const records=await fixture(),m=records[0],semantic={schema:m.schema,tables:[{name:'data',rows:records.slice(1,-1).flatMap(p=>p.items.map(x=>x.row))}],objects:[],payloads:[],requiredConfiguration:[]};
  assert.equal(records.at(-1).contentHash,await sha256(canonicalJson(semantic)));
  assert.equal(records.at(-1).archiveHash,await sha256(canonicalJson({manifest:m,parts:records.slice(1,-1).map(part=>part.sha256)})));
});
test('manifest format, version and schema checksums are required',async()=>{
  for(const change of [{format:'other'},{version:3},{schema:'0'.repeat(64)}]){const a=await fixture();Object.assign(a[0],change);await assert.rejects(collect(readArchive(bundleStream(a))),/archive_format|schema_checksum/);}
});
test('row parts cannot exceed one thousand records',async()=>{const part=await makePart(0,Array.from({length:1001},(_,index)=>({kind:'row',table:'data',index,row:{id:index,data:null}})));await assert.rejects(checkPart(part,0),/part_row_limit/);});
test('row order is verified independently of the part checksum',async()=>{const a=await fixture();a[1]=await makePart(0,[{...a[1].items[0],index:1}]);await assert.rejects(collect(readArchive(bundleStream(a))),/row_order/);});
test('object and payload hashes are checked independently of part checksums',async()=>{
  const [m]=await fixture();m.tables=[];m.schema=await sha256('[]');m.partCount=1;m.payloads=[{name:'bytes',size:3,sha256:await sha256(Uint8Array.of(1,2,3))}];
  const p=await makePart(0,[{kind:'payload',name:'bytes',offset:0,data:'AQIE'}]);await assert.rejects(collect(readArchive(bundleStream([m,p]))),/binary_checksum/);
});
