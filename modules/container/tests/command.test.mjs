import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { makePart,ContentVerifier,ArchiveVerifier } from '../../portability/format.mjs';
import { canonicalJson,sha256 } from '../../portability/hash.mjs';
const run=promisify(execFile),cli=resolve(import.meta.dirname,'../../../bin/rer.mjs');
async function archive(path,rows){
 const tables=[{name:'notes',sql:'CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT)',columns:[{name:'id',type:'TEXT',pk:1,notnull:0},{name:'body',type:'TEXT',pk:0,notnull:0}],dependencies:[],count:rows.length,rowidAlias:null}];
 const manifest={kind:'manifest',format:'runeditrun-portability',version:2,product:'command-test',sourceIdentity:'fixture',exportedAt:new Date().toISOString(),partCount:1,epoch:0,tables,objects:[],payloads:[],journal:[],requiredConfiguration:[],excludedColumns:{},schema:await sha256(canonicalJson(tables.map(({name,sql})=>({name,sql}))))};
 const items=rows.map((row,index)=>({kind:'row',table:'notes',index,row})),part=await makePart(0,items),verifier=new ContentVerifier(manifest);items.forEach(item=>verifier.add(item));const integrity=new ArchiveVerifier(manifest);integrity.add(part);
 await writeFile(path,[manifest,part,{kind:'closing',partCount:1,contentHash:verifier.digest(),archiveHash:integrity.digest()}].map(record=>JSON.stringify(record)).join('\n')+'\n');
}
test('archive diff validates native archives and identifies a write made during a move',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'rer-archive-diff-'));
 try{const before=join(directory,'before.rer'),after=join(directory,'after.rer');await archive(before,[{id:'one',body:'before'}]);await archive(after,[{id:'one',body:'after'},{id:'two',body:'new'}]);
 const {stdout}=await run(process.execPath,[cli,'archive','diff',before,after]);const result=JSON.parse(stdout);assert.equal(result.equal,false);assert.deepEqual(result.tables[0].changed,['["one"]']);assert.deepEqual(result.tables[0].added,['["two"]']);
 await writeFile(after,'{"kind":"manifest"}\n');await assert.rejects(run(process.execPath,[cli,'archive','diff',before,after]));
 }finally{await rm(directory,{recursive:true,force:true});}
});
