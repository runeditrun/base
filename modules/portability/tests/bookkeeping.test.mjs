import { runCases } from './cases.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { database,bundle,stage } from './regression-helpers.mjs';
import { createPortability,excludedTable } from '../index.mjs';
import { importArchive } from '../files.mjs';
import { migrate } from '../../container/migrations.mjs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArchiveVerifier } from '../format.mjs';

const policy={product:'ledger-portability'};
const ddl=['CREATE TABLE items(id TEXT PRIMARY KEY,value TEXT)',
  'CREATE TABLE rer_migrations(name TEXT PRIMARY KEY,applied_at TEXT NOT NULL)',
  'CREATE TABLE rer_command_receipts(id TEXT PRIMARY KEY,result TEXT)'];
async function migrated(t) {
  const fixture=await database(t,ddl,policy);
  await migrate(fixture.db,[]);
  await fixture.db.prepare("INSERT INTO rer_migrations VALUES('0001_items.sql','destination-ledger')").run();
  return fixture;
}
test("restore preserves native bookkeeping while refusing omitted platform or occupied data", async t => {
  const foldedCases = [];
foldedCases.push(['migrated export restores into a fresh migrated target and leaves its bookkeeping intact', async t=>{
  const source=await migrated(t),target=await migrated(t);
  await source.db.prepare("INSERT INTO items VALUES('person-1','Asha Chen')").run();
  // Exact bookkeeping names must not swallow seed tables sharing their prefix.
  for(const f of [source,target])await f.db.prepare('CREATE TABLE rer_migrations_notes(note TEXT)').run();
  await source.db.prepare("INSERT INTO rer_migrations_notes VALUES('seed-owned')").run();
  const archive=await bundle(source.service);
  assert.ok(!archive.manifest.tables.some(table=>table.name==='rer_migrations'));
  assert.ok(archive.manifest.excludedTables.includes('rer_migrations'));
  const id=await stage(target.service,archive);
  assert.equal((await target.service.imports.finalize(id,{archiveHash:archive.closing.archiveHash})).phase,'complete');
  assert.deepEqual((await target.db.prepare('SELECT * FROM items').all()).results,[{id:'person-1',value:'Asha Chen'}]);
  assert.equal((await target.db.prepare('SELECT note FROM rer_migrations_notes').first()).note,'seed-owned');
  assert.equal((await target.db.prepare('SELECT applied_at FROM rer_migrations').first()).applied_at,'destination-ledger');
}]);
foldedCases.push(['includeTables cannot reintroduce platform tables, including SQLite case aliases', async t=>{
  const source=await migrated(t);
  await runCases(t, Array.from(['rer_migrations','RER_MIGRATIONS','ik_d1_assertions','IK_D1_ASSERTIONS','d1_migrations','_rer_deploy_migrations','_rer_portability_migrations','rer_portability_jobs','rer_command_receipts','rer_erasure_blobs','rer_erasure_guard','rer_erasure_scope','rer_erasure_rates','rer_demo','rer_dependency_keys','rer_dependency_pending','rer_dependency_codes','rer_mail_development_outbox','rer_ai_development_outbox'], (name, rowIndex) => [`${t.name}: name row ${rowIndex + 1}`, async t => {
    const input={...policy,includeTables:[name]};
    assert.equal(excludedTable(name,input),true);
    await assert.rejects(createPortability({db:source.db,policy:input}),error=>error.code==='platform_table:'+name && error.message.includes('includeTables'));
}]));
}]);
foldedCases.push(['an old schema identity needs complete definitions, then skips platform rows and restores only seed data', async t=>{
  const target=await migrated(t),events=[];
  await target.db.prepare("INSERT INTO rer_command_receipts VALUES('destination-request','keep')").run();
  const fixture=new URL('./fixtures/bookkeeping-v2.jsonl',import.meta.url);
  await assert.rejects(importArchive(target.service,fixture,[]),error=>error.code==='schema_mismatch:legacy_schema');
  // Retain the original table-only checksum and all row/content checks. Bind
  // a complete empty object inventory to exercise the compatible old identity.
  const records=(await readFile(fixture,'utf8')).trim().split('\n').map(JSON.parse);
  records[0].schemaObjects=[];
  const integrity=new ArchiveVerifier(records[0]);records.slice(1,-1).forEach(part=>integrity.add(part));
  records.at(-1).archiveHash=integrity.digest();
  const directory=await mkdtemp(join(tmpdir(),'bookkeeping-archive-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const path=join(directory,'archive.rer');await writeFile(path,records.map(JSON.stringify).join('\n')+'\n',{mode:0o600});
  const result=await importArchive(target.service,path,[],undefined,event=>events.push(event));
  assert.deepEqual(result.skippedTables,['rer_command_receipts','rer_migrations']);
  assert.deepEqual(events.filter(event=>event.phase==='skipped').map(event=>event.tables),[result.skippedTables]);
  assert.deepEqual((await target.db.prepare('SELECT * FROM items').all()).results,[{id:'person-1',value:'Asha Chen'}]);
  assert.deepEqual((await target.db.prepare('SELECT * FROM rer_command_receipts').all()).results,[{id:'destination-request',result:'keep'}]);
  assert.equal((await target.db.prepare('SELECT applied_at FROM rer_migrations').first()).applied_at,'destination-ledger');
}]);
foldedCases.push(['a non-empty seed target still refuses restore with its table name', async t=>{
  const source=await migrated(t),target=await migrated(t);
  await source.db.prepare("INSERT INTO items VALUES('person-1','Asha Chen')").run();
  await target.db.prepare("INSERT INTO items VALUES('person-2','Mateo Ruiz')").run();
  const archive=await bundle(source.service),id=await stage(target.service,archive);
  await assert.rejects(target.service.imports.finalize(id,{archiveHash:archive.closing.archiveHash}),error=>error.code==='target_not_empty:items' && error.status===409);
  assert.deepEqual((await target.db.prepare('SELECT * FROM items').all()).results,[{id:'person-2',value:'Mateo Ruiz'}]);
}]);
  await runCases(t, foldedCases);
});
