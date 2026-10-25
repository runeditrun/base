import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { portabilityFixture } from './fixtures/portability.mjs';
import { archiveRecords, remakeArchive } from './fixtures/archive-records.mjs';

test('public local export/import/export preserves commented migration schemas and recomputes generated columns in a fresh installation',async t=>{
 const source=await portabilityFixture(t),target=await portabilityFixture(t);
 // Export performs the same real migrations as an owner's installed reference.
 await source.run(['export','--output','exports/empty.rer']);
 await source.data(`INSERT INTO computed_entries(id,quantity,unit_price,label) VALUES
  ('third',0,500,NULL),('first',3,125,'café'),('second',-2,75,'return');`);
 const query='SELECT * FROM computed_entries ORDER BY id';
 const before=(await source.data(query))[0].results;
 assert.deepEqual(before.map(row=>[row.total,row.description]),[[375,'café: 375'],[-150,'return: -150'],[0,'unlabelled: 0']]);
 const first=(await source.run(['export','--output','exports/first.rer'])).at(-1);
 const archive=(await readFile(join(source.root,'exports/first.rer'),'utf8')).trim().split('\n').map(JSON.parse);
 const table=archive[0].tables.find(table=>table.name==='computed_entries');
 const liveSQL=(await source.data("SELECT sql FROM sqlite_master WHERE name='computed_entries'"))[0].results[0].sql;
 assert.equal(table.sql,liveSQL,'the archive records the runner-built catalogue text');
 assert.deepEqual(table.columns.filter(column=>column.generated).map(column=>[column.name,column.generated]),[['total','stored'],['description','virtual']]);
 const rows=archive.filter(record=>record.kind==='part').flatMap(part=>part.items).filter(item=>item.table==='computed_entries');
 assert.equal(rows.length,3);
 for(const {row} of rows)assert.deepEqual(Object.keys(row).sort(),['id','label','quantity','unit_price']);
 await copyFile(join(source.root,'exports/first.rer'),join(target.root,'exports/first.rer'));
 const restored=(await target.run(['import','--input','exports/first.rer','--yes'])).at(-1);
 const second=(await target.run(['export','--output','exports/second.rer'])).at(-1);
 assert.equal(restored.contentHash,first.contentHash);assert.equal(second.contentHash,first.contentHash);
 const restoredArchive=(await readFile(join(target.root,'exports/second.rer'),'utf8')).trim().split('\n').map(JSON.parse);
 const semantics=records=>({tables:records[0].tables,excludedColumns:records[0].excludedColumns,objects:records[0].objects,payloads:records[0].payloads,requiredConfiguration:records[0].requiredConfiguration,items:records.filter(record=>record.kind==='part').flatMap(part=>part.items)});
 assert.deepEqual(semantics(restoredArchive),semantics(archive),'schema inventory and archived base cells remain equivalent');
 assert.deepEqual((await target.data(query))[0].results,before,'all visible cells, including computed cells, survive');
 const schema="SELECT type,name,sql FROM sqlite_master WHERE tbl_name='computed_entries' ORDER BY type,name";
 assert.deepEqual((await target.data(schema))[0].results,(await source.data(schema))[0].results,'migrated table SQL and generated-column index are preserved');
 await target.data("UPDATE computed_entries SET quantity=4 WHERE id='first'");
 assert.deepEqual((await target.data("SELECT total,description FROM computed_entries WHERE id='first'"))[0].results,[{total:500,description:'café: 500'}],'SQLite still owns both expressions after restore');
 assert.deepEqual((await target.data('SELECT id FROM computed_entries INDEXED BY computed_entries_total WHERE total=500'))[0].results,[{id:'first'}],'generated-column index remains usable after a base-cell update');
});

test('public import uses Platform file hashes without replaying them, admits declared seeds, and places name-only Platform archives', {timeout:10*60_000}, async t=>{
 const source=await portabilityFixture(t),target=await portabilityFixture(t);
 await source.run(['export','--output','exports/empty.rer']);
 await source.data("INSERT INTO computed_entries(id,quantity,unit_price,label) VALUES('retained',3,125,'Saved invoice')");
 await source.run(['export','--output','exports/saved.rer']);
 await copyFile(join(source.root,'exports/saved.rer'),join(target.root,'exports/saved.rer'));
 await target.run(['export','--output','exports/empty.rer']);
 const directory=join(target.root,'migrations/core');
 const files=await readdir(directory);
 const rows=await Promise.all(files.filter(name=>name.endsWith('.sql')).map(async name=>`('delivered-${name}','${createHash('sha256').update(await readFile(join(directory,name))).digest('hex')}')`));
 await target.data(`CREATE TABLE rer_migrations (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
 INSERT INTO rer_migrations(name,sha256) VALUES ${rows.join(',')}; DROP TABLE d1_migrations;`);
 const ledger=async()=>(await target.data('SELECT * FROM rer_migrations ORDER BY rowid'))[0].results;
 const before=await ledger();
 await target.run(['import','--input','exports/saved.rer','--yes']);
 assert.deepEqual((await target.data('SELECT id,total FROM computed_entries'))[0].results,[{id:'retained',total:375}]);
 assert.deepEqual(await ledger(),before,'the destination keeps its Platform ledger');
 assert.deepEqual((await target.data("SELECT name FROM sqlite_master WHERE name='d1_migrations'"))[0].results,[],'no shadow native ledger');
 await target.data("DELETE FROM computed_entries; INSERT INTO rer_migrations(name,sha256) VALUES('initial-page.sql','"+'0'.repeat(64)+"')");
 const refused=await target.text(['import','--input','exports/saved.rer','--yes'],4);
 assert.match(refused.stderr,/migration_ledger:unknown/);
 assert.deepEqual((await target.data('SELECT * FROM computed_entries'))[0].results,[]);
 const adapter=join(target.root,'scripts/installer/local.mjs');
 await writeFile(adapter,(await readFile(adapter,'utf8')).replace("localPortability({ database: 'default-seed-reference'", "localPortability({ database: 'default-seed-reference', platformMigrations: { prefix: 'delivered-', dataOnly: ['initial-page.sql'] }"));
 // Older Platform exports recorded only the delivered names, without SQL or hashes.
 const records=archiveRecords(await readFile(join(source.root,'exports/saved.rer'),'utf8'));
 records[0].migrations=[...records[0].migrations.map(name=>'delivered-'+name),'initial-page.sql'];
 await writeFile(join(target.root,'exports/names.rer'),(await remakeArchive(records)).map(JSON.stringify).join('\n')+'\n',{mode:0o600});
 await target.run(['import','--input','exports/names.rer','--yes']);
 assert.deepEqual((await target.data('SELECT id,total FROM computed_entries'))[0].results,[{id:'retained',total:375}]);
 await target.data('DELETE FROM computed_entries');
 await writeFile(join(directory,'1000_pending.sql'),'CREATE TABLE pending_items(id TEXT PRIMARY KEY);');
 const pending=await target.text(['import','--input','exports/saved.rer','--yes'],4);
 assert.match(pending.stderr,/migration_ledger:unapplied/);
 assert.deepEqual((await target.data("SELECT name FROM sqlite_master WHERE name='pending_items'"))[0].results,[]);
 await rm(join(directory,'1000_pending.sql'));
});
