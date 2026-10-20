import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { portabilityFixture } from './fixtures/portability.mjs';

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
