import { runCases } from './cases.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makePart,canonicalJson,sha256,readArchive } from '../index.mjs';
import { ContentVerifier } from '../format.mjs';
import { checkPart } from '../format.mjs';
import { database,bundle,stream } from './regression-helpers.mjs';

test("archive part byte limits remain inclusive and precede staging writes", async t => {
  const foldedCases = [];
foldedCases.push(['oversized checksummed uploads are refused before any staging or part write', async t=>{
  const ddl=['CREATE TABLE data(id INTEGER PRIMARY KEY,value TEXT)'],policy={product:'fixture',partBytes:1024};
  const source=await database(t,ddl,policy),target=await database(t,ddl,policy);
  await source.db.prepare("INSERT INTO data VALUES(1,'plain')").run();
  const archive=await bundle(source.service),id=await target.service.imports.create(archive.manifest);
  const part=await makePart(0,[{kind:'row',table:'data',index:0,row:{id:1,value:'x'.repeat(4096)}}]);
  assert.equal(Buffer.byteLength(canonicalJson(part)),4273);
  await assert.rejects(target.service.imports.uploadPart(id,0,part),/part_byte_limit/);
  assert.equal((await target.service.imports.status(id)).completed,0);
  assert.equal((await target.db.prepare('SELECT COUNT(*) AS n FROM rer_portability_parts').first()).n,0);
  const job=await target.db.prepare('SELECT metadata FROM rer_portability_jobs WHERE id=?').bind(id).first();
  const copy=JSON.parse(job.metadata).copies.data;
  assert.equal((await target.db.prepare('SELECT COUNT(*) AS n FROM "'+copy+'"').first()).n,0);
}]);
foldedCases.push(['byte bounds count canonical UTF-8 and accept the exact inclusive limit', async(t)=>{
  await runCases(t, Array.from(['row','payload'], (kind, rowIndex) => [`${t.name}: kind row ${rowIndex + 1}`, async t => {
    const item=kind==='row'?{kind,table:'data',index:0,row:{id:1,value:'😀'.repeat(250)}}:{kind,name:'bytes',offset:0,data:'YQ=='.repeat(250)};
    const part=await makePart(0,[item]),bytes=Buffer.byteLength(canonicalJson(part));
    await checkPart(part,0,bytes);
    await assert.rejects(checkPart(part,0,bytes-1),/part_byte_limit/);
}]));
}]);
foldedCases.push(['the default reader refuses the checksummed 700-row part above 16 MiB', async()=>{
  const table={name:'data',sql:'CREATE TABLE data(id INTEGER PRIMARY KEY,value TEXT)',
    columns:[{name:'id',type:'INTEGER',notnull:0,pk:1},{name:'value',type:'TEXT',notnull:0,pk:0}],dependencies:[],rowidAlias:null,count:700};
  const manifest={kind:'manifest',format:'runeditrun-portability',version:2,product:'fixture',sourceIdentity:'fixture',exportedAt:'2026-01-01',
    schema:await sha256(canonicalJson([{name:table.name,sql:table.sql}])),tables:[table],objects:[],payloads:[],excludedTables:[],excludedColumns:{},
    requiredConfiguration:[],epoch:0,journal:[],partCount:1};
  const part=await makePart(0,Array.from({length:700},(_,index)=>({kind:'row',table:'data',index,row:{id:index+1,value:'x'.repeat(25000)}})));
  assert.equal(Buffer.byteLength(canonicalJson(part)),17548893);
  const verifier=new ContentVerifier(manifest);for(const item of part.items)verifier.add(item);
  await assert.rejects(async()=>{for await(const record of readArchive(stream([manifest,part,{kind:'closing',partCount:1,contentHash:verifier.digest()}]))){}},/part_byte_limit/);
}]);
  await runCases(t, foldedCases);
});
