import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, copyFile, readFile, readdir, writeFile, stat, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { portabilityFixture } from './fixtures/portability.mjs';
import { managedEntries, managedZip, managedTriggerSQL, managedPolicyModule } from './fixtures/managed-data.mjs';
import { splitStatements } from '../modules/portability/sql-text.mjs';
import { managedDataLimits } from './managed-data-zip.mjs';
import { archiveRecords, remakeArchive } from './fixtures/archive-records.mjs';

async function managedFixture(t) {
 const fixture=await portabilityFixture(t);
 await appendFile(join(fixture.root,'migrations/core/0999_computed_entries.sql'),managedTriggerSQL);
 const local=join(fixture.root,'scripts/installer/local.mjs');
 await writeFile(local,(await readFile(local,'utf8')).replace('policy: portabilityPolicy',"policyModule: 'scripts/installer/managed-policy.mjs'"));
 await writeFile(join(fixture.root,'scripts/installer/managed-policy.mjs'),managedPolicyModule);
 return fixture;
}

// An installation RER Platform migrated: its runner records every delivered file, under the
// deployment's prefix, in rer_migrations instead of Wrangler's d1_migrations.
async function managedSource(t) {
 const source=await managedFixture(t);
 await source.run(['export','--output','exports/empty.rer']);
 await source.data("INSERT INTO computed_entries(id,quantity,unit_price,label) VALUES('synthetic-base-1',3,125,'synthetic-base-2'); INSERT INTO synthetic_facts VALUES('synthetic-base-10','synthetic-base-11'); INSERT INTO synthetic_excluded_present VALUES('synthetic-base-12'); INSERT INTO synthetic_excluded_retired VALUES('synthetic-base-13')");
 const directory=join(source.root,'migrations/core');
 const rows=await Promise.all((await readdir(directory)).filter(name=>name.endsWith('.sql')).sort().map(async name=>`('delivered-${name}','${createHash('sha256').update(await readFile(join(directory,name))).digest('hex')}')`));
 await source.data(`CREATE TABLE rer_migrations (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
 INSERT INTO rer_migrations(name,sha256) VALUES ${rows.join(',')}; DROP TABLE d1_migrations;`);
 return {source,directory};
}

test('a Managed installation leaves for native: its Platform-ledger export maps by migration identity, never as product tables',{timeout:15*60_000},async t=>{
 const parsed=splitStatements(managedTriggerSQL.replace("label='synthetic-base-6'","label=CASE WHEN quantity>0 THEN 'synthetic-base-6' ELSE 'synthetic-base-7' END"));
 assert.ok(parsed[0].includes('END WHERE id=NEW.id;\nEND'));
 const {source}=await managedSource(t),target=await managedFixture(t);
 await source.run(['export','--output','exports/managed.rer']);
 const records=archiveRecords(await readFile(join(source.root,'exports/managed.rer'),'utf8'));
 assert.equal(records[0].migrationLedger.origin,'rer_migrations');
 assert.ok(records[0].migrations.every(name=>!name.startsWith('delivered-')),'entries are named by the checkout files that have their hashes');
 assert.ok(!records[0].tables.some(table=>table.name==='rer_migrations'));
 for(const name of ['synthetic_excluded_present_id','synthetic_facts_legacy'])assert.ok(records[0].schemaObjects.some(object=>object.name===name),'excluded-table schema object remains in the archive: '+name);
 await copyFile(join(source.root,'exports/managed.rer'),join(target.root,'exports/managed.rer'));
 const restored=(await target.run(['import','--input','exports/managed.rer','--yes'])).at(-1);
 assert.deepEqual((await target.data('SELECT id,total FROM computed_entries'))[0].results,[{id:'synthetic-base-1',total:375}]);
 assert.deepEqual((await target.data("SELECT name FROM sqlite_master WHERE name='rer_migrations'"))[0].results,[],'no Platform ledger or product table is created');
 assert.equal((await target.data('SELECT count(*) AS n FROM d1_migrations'))[0].results[0].n,records[0].migrations.length);
 const again=(await target.run(['export','--output','exports/again.rer'])).at(-1);
 assert.equal(again.contentHash,restored.contentHash,'the native re-export carries the same data');
 const zipTarget=await managedFixture(t);
 await writeFile(join(zipTarget.root,'migrations/core/1000_retire_synthetic.sql'),'DROP TRIGGER synthetic_facts_legacy; DROP TABLE synthetic_excluded_retired;');
 const entries=await managedEntries(source),zip=managedZip(entries),input=join(zipTarget.root,'exports/managed.zip');
 const wrongKind=entries.map(([name,value])=>[name,name==='manifest.json'?JSON.stringify({...JSON.parse(value),kind:'synthetic-base-1'}):value]);
 const wrongVersion=entries.map(([name,value])=>[name,name==='manifest.json'?JSON.stringify({...JSON.parse(value),schema:2}):value]);
 const malformed=entries.map(([name,value])=>[name,name==='manifest.json'?'{':value]);
 const damaged=Buffer.from(zip);damaged[50]^=1;
 const compressed=Buffer.from(zip);compressed.writeUInt16LE(8,8);
 const central=compressed.readUInt32LE(compressed.length-6);compressed.writeUInt16LE(8,central+10);
 const ratio=Buffer.from(zip);ratio.writeUInt32LE(1,central+20);ratio.writeUInt32LE(managedDataLimits.entryBytes+1,central+24);
 const withSQL = (suffix, rewrite = sql => sql) => {
  const changed=entries.map(([name,value])=>{
   if(name!=='data/d1/DB.sql')return [name,value];
   const original=value.toString(),changed=rewrite(original)+suffix;
   assert.notEqual(changed,original,'synthetic refusal must change the source SQL');
   return [name,Buffer.from(changed)];
  });
  const sql=changed.find(([name])=>name==='data/d1/DB.sql')[1];
  for(const entry of changed)if(entry[0]==='manifest.json'||entry[0]==='data/d1/DB.json') {
   const metadata=JSON.parse(entry[1]),database=entry[0]==='manifest.json'?metadata.databases[0]:metadata;
   database.dumpBytes=sql.length;database.dumpSha256=createHash('sha256').update(sql).digest('hex');entry[1]=JSON.stringify(metadata);
  }
  return managedZip(changed);
 };
 const schemaCases=[];
 for(const stem of ['acf_unknown_', 'synthetic_cf_', 'synthetic%_', 'sqliteX_']) {
  schemaCases.push(
   [stem+'index',withSQL(`\nCREATE INDEX "${stem}index" ON computed_entries(label);`),'schema_object_unknown'],
   [stem+'trigger',withSQL(`\nCREATE TRIGGER "${stem}trigger" AFTER INSERT ON computed_entries BEGIN SELECT 1; END;`),'schema_object_unknown'],
   [stem+'table',withSQL(`\nCREATE TABLE "${stem}table"(id TEXT);`),'schema_table_missing'],
   [stem+'view',withSQL(`\nCREATE VIEW "${stem}view" AS SELECT id FROM computed_entries;`),'schema_object_unknown'],
  );
 }
 schemaCases.push(
  ['excluded-index',withSQL('\nCREATE INDEX synthetic_excluded_index ON synthetic_excluded_present(id);'),'schema_object_unknown'],
  ['excluded-trigger',withSQL('\nCREATE TRIGGER synthetic_excluded_trigger AFTER INSERT ON synthetic_excluded_present BEGIN SELECT 1; END;'),'schema_object_unknown'],
  ['replacement-index',withSQL('',sql=>sql.replace(/^CREATE INDEX computed_entries_total ON computed_entries\(total\);$/m,'CREATE INDEX computed_entries_total ON computed_entries(label);')),'schema_object_unaccounted_replacement'],
  ['missing-native-index',withSQL('',sql=>sql.replace(/^CREATE INDEX computed_entries_total ON computed_entries\(total\);$/m,'')),'schema_incompatible'],
  ['replacement-table',withSQL('',sql=>sql.replace(/^(\s*quantity )INTEGER( NOT NULL)/m,'$1TEXT$2')),'schema_incompatible'],
 );
 const refusalCases=[
  ['wrong-kind',managedZip(wrongKind),'wrong_kind'],
  ['wrong-version',managedZip(wrongVersion),'unsupported_version'],
  ['malformed',managedZip(malformed),'invalid_manifest'],
  ['missing-manifest',managedZip(entries.filter(([name])=>name!=='manifest.json')),'missing_member'],
  ['missing',managedZip(entries.filter(([name])=>name!=='data/d1/DB.sql')),'missing_member'],
  ['truncated',zip.subarray(0,zip.length-10),'truncated'],
  ['traversal',managedZip([...entries,['../synthetic-base-1','synthetic-base-1']]),'unsafe_path'],
  ['absolute',managedZip([...entries,['/synthetic-base-1','synthetic-base-1']]),'unsafe_path'],
  ['duplicate',managedZip([...entries,entries[0]]),'duplicate_member'],
  ['checksum',damaged,'checksum'],
  ['compressed',compressed,'unsupported_compression'],
  ['zip-bomb-ratio',ratio,'oversized'],
  ['non-insert',withSQL('\nSELECT 1;'),'sql_refused'],
  ['unknown-object',withSQL('\nCREATE TRIGGER synthetic_facts_unknown AFTER INSERT ON synthetic_facts BEGIN SELECT 1; END;'),'schema_object_unknown'],
  ['missing-table',withSQL('\nCREATE TABLE synthetic_portable(id TEXT);'),'schema_table_missing'],
  ['missing-excluded-table',withSQL('\nCREATE TABLE synthetic_excluded_unknown(id TEXT);'),'schema_table_missing'],
  ['retired-excluded-wrong-schema',withSQL('',sql=>sql.replace(/^CREATE TABLE synthetic_excluded_retired \(id TEXT PRIMARY KEY\);$/m, 'CREATE TABLE synthetic_excluded_retired (id BLOB PRIMARY KEY);')),'schema_table_missing'],
  ...schemaCases,
 ];
 for(const [name,bytes,reason] of refusalCases) {
  await writeFile(input,bytes,{mode:0o600});
  t.diagnostic('Refusal case: '+name);
  const refusal=await zipTarget.text(['import','--input','exports/managed.zip','--yes','--non-interactive','--no-queue'],4).catch(error=>{error.message=name+': '+error.message;throw error;});
  assert.match(refusal.stderr,new RegExp('managed_data_'+reason),name);
  await assert.rejects(stat(join(zipTarget.root,'.wrangler/state')),{code:'ENOENT'},name+': target untouched');
 }
 await writeFile(input,zip,{mode:0o600});await truncate(input,managedDataLimits.archiveBytes+1);
 assert.match((await zipTarget.text(['import','--input','exports/managed.zip','--yes'],4)).stderr,/managed_data_oversized/);
 await assert.rejects(stat(join(zipTarget.root,'.wrangler/state')),{code:'ENOENT'});
 await writeFile(input,zip,{mode:0o600});
 assert.match((await zipTarget.text(['import','--input','exports/managed.zip'],4)).stderr,/explicit --yes/);
 await assert.rejects(stat(join(zipTarget.root,'.wrangler/state')),{code:'ENOENT'});
 // Materialize the empty native destination so the unknown excluded table
 // refusal also proves its existing migration history remains byte-identical.
 await zipTarget.run(['export','--output','exports/empty.rer']);
 const databaseBytes=async()=>{
  const directory=join(zipTarget.root,'.wrangler/state');
  const files=(await readdir(directory,{recursive:true})).filter(name=>/\.sqlite(?:-wal|-shm)?$/.test(name)).sort();
  return Promise.all(files.map(async name=>[name,createHash('sha256').update(await readFile(join(directory,name))).digest('hex')]));
 };
 const beforeRefusals=await databaseBytes();
 assert.ok(beforeRefusals.length>0);
 for(const [name,bytes,reason] of refusalCases.filter(([, , reason])=>reason.startsWith('schema_'))) {
  await writeFile(input,bytes,{mode:0o600});
  const refused=await zipTarget.text(['import','--input','exports/managed.zip','--yes','--non-interactive','--no-queue'],4);
  assert.match(refused.stderr,new RegExp('managed_data_'+reason),name);
  assert.deepEqual(await databaseBytes(),beforeRefusals,name+': existing database and sidecars retain their hashes');
 }
 // D1 reserves the literal prefix: explicit source DDL using it is denied
 // by its authorizer. Its own internal table exists in every staging sandbox
 // and must stay exempt from source accounting through the public ZIP door.
 const internals=(await source.data("SELECT name FROM sqlite_master WHERE sql IS NOT NULL AND substr(lower(name),1,4)='_cf_' ORDER BY name"))[0].results;
 assert.ok(internals.length>0,'the actual source contains literal internal names');
 await writeFile(input,zip,{mode:0o600});
 const imported=(await zipTarget.run(['import','--input','exports/managed.zip','--yes','--non-interactive','--no-queue'])).at(-1);
 assert.equal(imported.ok,true);
 const nameHash=names=>createHash('sha256').update(JSON.stringify(names.sort())).digest('hex');
 assert.ok(imported.managedSchema.accounted.some(group=>group.type==='table' && group.disposition==='retired' && group.migration==='1000_retire_synthetic.sql' && group.count===1 && group.namesSha256===nameHash(['synthetic_excluded_retired'])));
 const presentExclusions=records[0].excludedTables.filter(name=>!name.startsWith('sqlite_') && !name.startsWith('_cf_') && !['rer_migrations','synthetic_excluded_retired'].includes(name));
 assert.ok(imported.managedSchema.accounted.some(group=>group.type==='table' && group.disposition==='excluded-by-policy' && group.count===presentExclusions.length && group.namesSha256===nameHash(presentExclusions)));
 assert.deepEqual((await zipTarget.data('SELECT * FROM synthetic_excluded_present'))[0].results,[],'present excluded table rows are not restored');
 assert.deepEqual((await zipTarget.data("SELECT name FROM sqlite_master WHERE name='synthetic_excluded_retired'"))[0].results,[],'retired table is never recreated');
 assert.ok(imported.managedSchema.accounted.some(group=>group.type==='trigger' && group.disposition==='retired' && group.migration==='1000_retire_synthetic.sql' && group.count===1));
 assert.ok(!JSON.stringify(imported.managedSchema).includes('synthetic_facts_legacy'));
 assert.deepEqual((await zipTarget.data("SELECT name FROM sqlite_master WHERE sql IS NOT NULL AND substr(lower(name),1,4)='_cf_' ORDER BY name"))[0].results,internals,'only native engine internals remain');
 t.diagnostic('Literal internal prefix exempt through public ZIP import: '+internals.map(row=>row.name).join(', '));
 t.diagnostic('Managed schema inventory: '+JSON.stringify(imported.managedSchema.inventory));
 t.diagnostic('Managed schema accounting: '+JSON.stringify(imported.managedSchema.accounted));
 t.diagnostic('Refusal matrix: '+refusalCases.length+' ZIP cases on absent destination; '+refusalCases.filter(([, , reason])=>reason.startsWith('schema_')).length+' schema cases on initialized destination; literal internal objects exempt; oversized file, confirmation and occupied destination also checked');
 const facts='SELECT * FROM synthetic_facts ORDER BY id';
 assert.deepEqual((await zipTarget.data(facts))[0].results,(await source.data(facts))[0].results,'database-bound payloads preserve policy-excluded facts');
 assert.ok(!records[0].tables.some(table=>table.name==='synthetic_facts'));
 assert.equal(records[0].payloads.length,1);
 assert.deepEqual((await zipTarget.data('SELECT id,total FROM computed_entries'))[0].results,[{id:'synthetic-base-1',total:375}]);
 const schema="SELECT type,sql FROM sqlite_master WHERE tbl_name='computed_entries' AND type IN ('trigger','index') AND sql IS NOT NULL ORDER BY name";
 assert.deepEqual((await zipTarget.data(schema))[0].results,(await source.data(schema))[0].results);
 assert.deepEqual((await zipTarget.data('SELECT id FROM computed_entries_view'))[0].results,[{id:'synthetic-base-1'}]);
 assert.deepEqual((await zipTarget.data("SELECT name FROM sqlite_master WHERE name='rer_migrations'"))[0].results,[]);
 assert.equal((await zipTarget.data('SELECT count(*) AS n FROM d1_migrations'))[0].results[0].n,records[0].migrations.length+1);
 const beforeOccupied=await databaseBytes();
 const occupied=await zipTarget.text(['import','--input','exports/managed.zip','--yes'],4);
 assert.match(occupied.stderr,/target_not_empty/);
 const afterOccupied=await databaseBytes();
 assert.ok(afterOccupied.length===beforeOccupied.length && afterOccupied.every(([name,bytes],i)=>name===beforeOccupied[i][0] && bytes===beforeOccupied[i][1]),'occupied refusal leaves database bytes unchanged');
 assert.deepEqual((await zipTarget.data('SELECT id,total FROM computed_entries'))[0].results,[{id:'synthetic-base-1',total:375}]);
 await zipTarget.data("UPDATE computed_entries SET quantity=4 WHERE id='synthetic-base-1'");
 assert.deepEqual((await zipTarget.data('SELECT id,label,total FROM computed_entries ORDER BY id'))[0].results,[
  {id:'synthetic-base-1',label:'synthetic-base-6',total:500},
  {id:'synthetic-base-1-synthetic-base-3',label:"synthetic-base-4';synthetic-base-5",total:2},
 ]);

});

test('a Platform history that is not this checkout\'s refuses with its migration named and the fix',{timeout:15*60_000},async t=>{
 const {source,directory}=await managedSource(t),target=await managedFixture(t);
 await source.run(['export','--output','exports/managed.rer']);
 const records=archiveRecords(await readFile(join(source.root,'exports/managed.rer'),'utf8'));
 records[0].migrationLedger.entries[1].sha256='0'.repeat(64);
 await writeFile(join(target.root,'exports/changed.rer'),(await remakeArchive(records)).map(JSON.stringify).join('\n')+'\n',{mode:0o600});
 const changed=await target.text(['import','--input','exports/changed.rer','--yes'],4);
 assert.match(changed.stderr,/migration_ledger:unknown:.*checkout version that exported it/);
 assert.deepEqual((await target.data('SELECT * FROM computed_entries'))[0].results,[]);
 await writeFile(join(directory,'1000_pending.sql'),'CREATE TABLE pending_items(id TEXT PRIMARY KEY);');
 const unapplied=await source.text(['export','--output','exports/pending.rer'],4);
 assert.match(unapplied.stderr,/migration_ledger:unapplied.*1000_pending\.sql.*Platform/);
 // An adopting adapter keeps its own legacy JSON reader alongside ZIP intake.
 // Exercise selection through the public command, with no database mutation.
 await appendFile(join(target.root,'scripts/installer/local.mjs'),`
commandAdapter.portability.import = async ({ path }) => {
 const { readFile } = await import('node:fs/promises');
 const value = JSON.parse(await readFile(path,'utf8'));
 if (value.kind !== 'synthetic-base-14') throw new Error('synthetic legacy format');
 return { legacyJSON: value.kind };
};
`);
 await writeFile(join(target.root,'exports/legacy.json'),JSON.stringify({kind:'synthetic-base-14'}),{mode:0o600});
 assert.equal((await target.run(['import','--input','exports/legacy.json','--yes'])).at(-1).legacyJSON,'synthetic-base-14');
 t.diagnostic('Legacy JSON reader: public rer import exit=0');
});
