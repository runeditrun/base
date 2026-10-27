import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, readFile, readdir, writeFile, stat, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { portabilityFixture } from './fixtures/portability.mjs';
import { managedEntries, managedZip } from './fixtures/managed-data.mjs';
import { managedDataLimits } from './managed-data-zip.mjs';
import { archiveRecords, remakeArchive } from './fixtures/archive-records.mjs';

// An installation RER Platform migrated: its runner records every delivered file, under the
// deployment's prefix, in rer_migrations instead of Wrangler's d1_migrations.
async function managedSource(t) {
 const source=await portabilityFixture(t);
 await source.run(['export','--output','exports/empty.rer']);
 await source.data("INSERT INTO computed_entries(id,quantity,unit_price,label) VALUES('synthetic-base-1',3,125,'synthetic-base-2')");
 const directory=join(source.root,'migrations/core');
 const rows=await Promise.all((await readdir(directory)).filter(name=>name.endsWith('.sql')).sort().map(async name=>`('delivered-${name}','${createHash('sha256').update(await readFile(join(directory,name))).digest('hex')}')`));
 await source.data(`CREATE TABLE rer_migrations (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
 INSERT INTO rer_migrations(name,sha256) VALUES ${rows.join(',')}; DROP TABLE d1_migrations;`);
 return {source,directory};
}

test('a Managed installation leaves for native: its Platform-ledger export maps by migration identity, never as product tables',{timeout:15*60_000},async t=>{
 const {source}=await managedSource(t),target=await portabilityFixture(t);
 await source.run(['export','--output','exports/managed.rer']);
 const records=archiveRecords(await readFile(join(source.root,'exports/managed.rer'),'utf8'));
 assert.equal(records[0].migrationLedger.origin,'rer_migrations');
 assert.ok(records[0].migrations.every(name=>!name.startsWith('delivered-')),'entries are named by the checkout files that have their hashes');
 assert.ok(!records[0].tables.some(table=>table.name==='rer_migrations'));
 await copyFile(join(source.root,'exports/managed.rer'),join(target.root,'exports/managed.rer'));
 const restored=(await target.run(['import','--input','exports/managed.rer','--yes'])).at(-1);
 assert.deepEqual((await target.data('SELECT id,total FROM computed_entries'))[0].results,[{id:'synthetic-base-1',total:375}]);
 assert.deepEqual((await target.data("SELECT name FROM sqlite_master WHERE name='rer_migrations'"))[0].results,[],'no Platform ledger or product table is created');
 assert.equal((await target.data('SELECT count(*) AS n FROM d1_migrations'))[0].results[0].n,records[0].migrations.length);
 const again=(await target.run(['export','--output','exports/again.rer'])).at(-1);
 assert.equal(again.contentHash,restored.contentHash,'the native re-export carries the same data');
 const zipTarget=await portabilityFixture(t);
 const entries=await managedEntries(source),zip=managedZip(entries),input=join(zipTarget.root,'exports/managed.zip');
 const wrongKind=entries.map(([name,value])=>[name,name==='manifest.json'?JSON.stringify({...JSON.parse(value),kind:'synthetic-base-1'}):value]);
 const wrongVersion=entries.map(([name,value])=>[name,name==='manifest.json'?JSON.stringify({...JSON.parse(value),schema:2}):value]);
 const malformed=entries.map(([name,value])=>[name,name==='manifest.json'?'{':value]);
 const damaged=Buffer.from(zip);damaged[50]^=1;
 const compressed=Buffer.from(zip);compressed.writeUInt16LE(8,8);
 const central=compressed.readUInt32LE(compressed.length-6);compressed.writeUInt16LE(8,central+10);
 for(const [name,bytes,reason] of [
  ['wrong-kind',managedZip(wrongKind),'wrong_kind'],
  ['wrong-version',managedZip(wrongVersion),'unsupported_version'],
  ['malformed',managedZip(malformed),'invalid_manifest'],
  ['missing',managedZip(entries.filter(([name])=>name!=='data/d1/DB.sql')),'missing_member'],
  ['truncated',zip.subarray(0,zip.length-10),'truncated'],
  ['traversal',managedZip([...entries,['../synthetic-base-1','synthetic-base-1']]),'unsafe_path'],
  ['duplicate',managedZip([...entries,entries[0]]),'duplicate_member'],
  ['checksum',damaged,'checksum'],
  ['compressed',compressed,'unsupported_compression'],
 ]) {
  await writeFile(input,bytes,{mode:0o600});
  const refusal=await zipTarget.text(['import','--input','exports/managed.zip','--yes','--non-interactive','--no-queue'],4);
  assert.match(refusal.stderr,new RegExp('managed_data_'+reason),name);
  await assert.rejects(stat(join(zipTarget.root,'.wrangler/state')),{code:'ENOENT'},name+': target untouched');
 }
 await writeFile(input,zip,{mode:0o600});await truncate(input,managedDataLimits.archiveBytes+1);
 assert.match((await zipTarget.text(['import','--input','exports/managed.zip','--yes'],4)).stderr,/managed_data_oversized/);
 await assert.rejects(stat(join(zipTarget.root,'.wrangler/state')),{code:'ENOENT'});
 await writeFile(input,zip,{mode:0o600});
 assert.match((await zipTarget.text(['import','--input','exports/managed.zip'],4)).stderr,/explicit --yes/);
 await assert.rejects(stat(join(zipTarget.root,'.wrangler/state')),{code:'ENOENT'});
 const imported=(await zipTarget.run(['import','--input','exports/managed.zip','--yes','--non-interactive','--no-queue'])).at(-1);
 assert.equal(imported.ok,true);
 assert.deepEqual((await zipTarget.data('SELECT id,total FROM computed_entries'))[0].results,[{id:'synthetic-base-1',total:375}]);
 assert.deepEqual((await zipTarget.data("SELECT name FROM sqlite_master WHERE name='rer_migrations'"))[0].results,[]);
 assert.equal((await zipTarget.data('SELECT count(*) AS n FROM d1_migrations'))[0].results[0].n,records[0].migrations.length);
 const occupied=await zipTarget.text(['import','--input','exports/managed.zip','--yes'],4);
 assert.match(occupied.stderr,/target_not_empty/);
 assert.deepEqual((await zipTarget.data('SELECT id,total FROM computed_entries'))[0].results,[{id:'synthetic-base-1',total:375}]);

});

test('a Platform history that is not this checkout\'s refuses with its migration named and the fix',{timeout:15*60_000},async t=>{
 const {source,directory}=await managedSource(t),target=await portabilityFixture(t);
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
});
