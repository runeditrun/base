import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { portabilityFixture } from './fixtures/portability.mjs';
import { archiveRecords, remakeArchive } from './fixtures/archive-records.mjs';

// An installation RER Platform migrated: its runner records every delivered file, under the
// deployment's prefix, in rer_migrations instead of Wrangler's d1_migrations.
async function managedSource(t) {
 const source=await portabilityFixture(t);
 await source.run(['export','--output','exports/empty.rer']);
 await source.data("INSERT INTO computed_entries(id,quantity,unit_price,label) VALUES('retained',3,125,'Saved invoice')");
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
 assert.deepEqual((await target.data('SELECT id,total FROM computed_entries'))[0].results,[{id:'retained',total:375}]);
 assert.deepEqual((await target.data("SELECT name FROM sqlite_master WHERE name='rer_migrations'"))[0].results,[],'no Platform ledger or product table is created');
 assert.equal((await target.data('SELECT count(*) AS n FROM d1_migrations'))[0].results[0].n,records[0].migrations.length);
 const again=(await target.run(['export','--output','exports/again.rer'])).at(-1);
 assert.equal(again.contentHash,restored.contentHash,'the native re-export carries the same data');
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
