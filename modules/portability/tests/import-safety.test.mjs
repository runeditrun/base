import { runCases } from './cases.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPortability } from '../index.mjs';
import { exportArchive, importArchive } from '../files.mjs';
import { database, bundle, stage } from './regression-helpers.mjs';

const ddl=[
  "CREATE TABLE automations(id TEXT PRIMARY KEY,title TEXT NOT NULL,status TEXT NOT NULL,token TEXT,display TEXT GENERATED ALWAYS AS (title || ':' || status) VIRTUAL)",
  'CREATE TABLE notes(id TEXT PRIMARY KEY,body TEXT)',
];
const policy={product:'safety-fixture'};
const importSafety={automations:{status:['inactive'],token:[null]}};
const normalize=(table,row)=>{
  assert.equal(table,'automations','undeclared tables never enter the hook');
  return {...row,status:'inactive',token:null};
};
const changes=[
  {table:'automations',column:'status',value:'inactive',rows:3},
  {table:'automations',column:'token',value:null,rows:2},
];
const rows=async db=>(await db.prepare('SELECT * FROM automations ORDER BY id').all()).results;
async function source(t) {
  const s=await database(t,ddl,policy);
  await s.db.prepare("INSERT INTO automations(id,title,status,token) VALUES('a','Morning digest','active','fixture-token-a'),('b','Invoice reminder','active','fixture-token-b'),('c','Approval replay','active',NULL),('d','Paused digest','inactive',NULL)").run();
  await s.db.prepare("INSERT INTO notes VALUES('n','Retained owner note')").run();
  return s;
}
async function archiveFile(t,s) {
  const directory=await mkdtemp(join(tmpdir(),'import-safety-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const path=join(directory,'older-installation.rer');
  await exportArchive(s.service,path,[]);return path;
}

test("restore normalization admits only declared safe changes with durable receipts", async t => {
  const foldedCases = [];
foldedCases.push(['archive import normalizes staged automations, journals actual changes and returns a secret-free receipt', async t=>{
  const s=await source(t),before=await rows(s.db),path=await archiveFile(t,s);
  let validated=false;
  const target=await database(t,ddl,{...policy,importSafety,importRow:normalize,validateStaged:async ({read})=>{
    const staged=await read('automations');
    assert.ok(staged.every(r=>r.status==='inactive' && r.token===null && r.display===r.title+':inactive'));
    validated=true;
  }});
  const receipt=await importArchive(target.service,path,[]);
  assert.equal(validated,true);
  assert.deepEqual(await rows(target.db),before.map(r=>({...r,status:'inactive',token:null,display:r.title+':inactive'})));
  assert.deepEqual(receipt.safetyChanges,changes);
  const job=await target.db.prepare("SELECT id,metadata FROM rer_portability_jobs WHERE kind='import'").first();
  assert.deepEqual(JSON.parse(job.metadata).safetyChanges,changes);
  assert.deepEqual((await target.service.imports.status(job.id)).safetyChanges,changes);
  assert.ok(!JSON.stringify(receipt.safetyChanges).includes('fixture-token'));
  assert.deepEqual(await rows(s.db),before,'the archive source stays intact');
  assert.deepEqual((await target.db.prepare('SELECT * FROM notes').all()).results,[{id:'n',body:'Retained owner note'}]);
  // Ordinary erasure still fences the imported identity after normalization.
  await target.db.batch([target.db.prepare("DELETE FROM automations WHERE id='a'"),...await target.service.erasureStatements('automations',{id:'a'})]);
  const erased=await bundle(target.service),fresh=await database(t,ddl,policy),id=await stage(fresh.service,erased);
  await fresh.service.imports.finalize(id,erased.closing);
  assert.deepEqual((await rows(fresh.db)).map(r=>r.id),['b','c','d']);
}]);
foldedCases.push(['normalization survives a refused validation and a new service without double counting', async t=>{
  const s=await source(t),archive=await bundle(s.service);
  const target=await database(t,ddl,{...policy,importSafety,importRow:normalize,validateStaged:()=>false});
  const id=await stage(target.service,archive);
  await assert.rejects(target.service.imports.finalize(id,archive.closing),/staged_validation/);
  assert.deepEqual(await rows(target.db),[]);
  assert.deepEqual((await target.service.imports.status(id)).safetyChanges,changes);
  const resumed=await createPortability({db:target.db,policy:{...policy,importSafety,importRow:normalize}});
  const status=await resumed.imports.finalize(id,archive.closing);
  assert.deepEqual(status.safetyChanges,changes);
  assert.deepEqual(await resumed.imports.finalize(id,archive.closing),status);
}]);
foldedCases.push(['archive import refuses escalation, undeclared or structural edits, key edits and impure hooks before publishing', async t=>{
  const s=await source(t),path=await archiveFile(t,s),target=await database(t,ddl,policy);
  // Policy validation goes through the same public constructor the importer uses.
  await runCases(t, Array.from([
    {importRow:normalize}, {importSafety}, {importSafety:[],importRow:normalize},
    ...[[],[undefined],[NaN],['inactive','inactive'],[{blob:'!'}]].map(values=>({importSafety:{automations:{status:values}},importRow:normalize})),
    ...['id','display','missing'].map(column=>({importSafety:{automations:{[column]:['inactive']}},importRow:normalize})),
    {importSafety:{missing:{status:['inactive']}},importRow:normalize},
  ], (declaration, rowIndex) => [`${t.name}: declaration row ${rowIndex + 1}`, async t => {
await assert.rejects(createPortability({db:target.db,policy:{...policy,...declaration}}));
}]));
  const mutable={automations:{status:['inactive']}};
  const cases=[
    {column:'status',safe:mutable,map:row=>{mutable.automations.status.push('active');return {...row,status:'active'};}},
    {column:'status',map:row=>({...row,status:row.status==='inactive'?'active':'inactive'})},
    {column:'title',map:row=>({...row,title:'Changed'})},
    {column:'extra',map:row=>({...row,extra:'added'})},
    {column:'token',map:row=>{delete row.token;return row;}},
    {column:'id',map:row=>({...row,id:'changed-key'})},
    {column:'status',safe:{automations:{status:['inactive','paused']}},map:row=>({...row,status:row.status==='inactive'?'paused':'inactive'})},
    {column:'status',safe:{automations:{status:['inactive','paused']}},map:(()=>{let n=0;return row=>({...row,status:++n%2?'inactive':'paused'});})()},
    {column:'automations',map:async row=>row},
  ];
  await runCases(t, Array.from(cases, (example, rowIndex) => [`${t.name}: example row ${rowIndex + 1}`, async t => {
    const service=await createPortability({db:target.db,policy:{...policy,importSafety:example.safe??importSafety,importRow:(_table,row)=>example.map(row)}});
    await assert.rejects(importArchive(service,path,[]),error=>{
      assert.match(error.message,/automations/);assert.ok(error.message.includes(example.column));return true;
    });
    assert.deepEqual(await rows(target.db),[]);
    assert.equal((await target.db.prepare('SELECT import_job FROM rer_portability_state WHERE id=1').first()).import_job,null);
}]));
}]);
foldedCases.push(['a policy without import normalization restores the original activation and token values', async t=>{
  const s=await source(t),path=await archiveFile(t,s),target=await database(t,ddl,policy);
  const receipt=await importArchive(target.service,path,[]);
  assert.deepEqual(await rows(target.db),await rows(s.db));
  assert.equal(receipt.safetyChanges,undefined);
}]);
  await runCases(t, foldedCases);
});
