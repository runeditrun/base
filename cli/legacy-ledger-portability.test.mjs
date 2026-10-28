import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { portabilityFixture } from './fixtures/portability.mjs';

test('local archives preserve bytes with legacy bookkeeping and refuse competing histories', {timeout:10*60_000}, async t=>{
 const source=await portabilityFixture(t),target=await portabilityFixture(t);
 for(const fixture of [source,target]) {
  await writeFile(join(fixture.root,'migrations/core/0998_support_attachments.sql'),'CREATE TABLE support_attachments(id TEXT PRIMARY KEY,body BLOB NOT NULL,note TEXT);');
  await fixture.run(['export','--output','exports/empty.rer']);
 }
 const directory=join(source.root,'migrations/core');
 const entries=await Promise.all((await readdir(directory)).filter(name=>name.endsWith('.sql')).sort().map(async name=>({name,sha256:createHash('sha256').update(await readFile(join(directory,name))).digest('hex')})));
 const legacy=`CREATE TABLE _rer_deploy_migrations(name TEXT PRIMARY KEY,sha256 TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('applying','applied')));
 INSERT INTO _rer_deploy_migrations VALUES ${entries.map(({name,sha256})=>`('${name}','${sha256}','applied')`).join(',')};`;
 for(const fixture of [source,target]) {
  await fixture.data(legacy);
  // Historical Wrangler bookkeeping need not cover the complete deploy history.
  await fixture.data('DELETE FROM d1_migrations WHERE id>(SELECT min(id) FROM d1_migrations)');
 }
 await source.data(`INSERT INTO computed_entries(id,quantity,unit_price,label) VALUES('invoice-1042',3,125,'Café support — paid');
 INSERT INTO support_attachments VALUES('ticket-27',X'0001ff807f00c3a90a',NULL);`);
 const rows=async fixture=>(await fixture.data('SELECT id,quantity,unit_price,label,total FROM computed_entries ORDER BY id; SELECT id,hex(body) AS bytes,note FROM support_attachments ORDER BY id')).map(result=>result.results);
 const expected=await rows(source);
 const histories=async fixture=>(await fixture.data('SELECT * FROM _rer_deploy_migrations ORDER BY name; SELECT * FROM d1_migrations ORDER BY id')).map(result=>result.results);
 const before=await histories(source),destinationBefore=await histories(target);
 await source.text(['export','--output','exports/support.rer']);
 assert.deepEqual(await histories(source),before,'export skips Wrangler and preserves both ledgers');
 await copyFile(join(source.root,'exports/support.rer'),join(target.root,'exports/support.rer'));
 await target.text(['import','--input','exports/support.rer','--yes']);
 assert.deepEqual(await rows(target),expected,'Unicode text, binary bytes, NULL and generated values restore exactly');
 assert.deepEqual(await histories(target),destinationBefore,'import also preserves the legacy owner and stale bookkeeping');
 const restored=(await target.run(['export','--output','exports/restored.rer'])).at(-1);
 const original=(await source.run(['export','--output','exports/original.rer'])).at(-1);
 assert.equal(restored.contentHash,original.contentHash);
 t.diagnostic('legacy pair: rer export exit 0; rer import into empty legacy-pair destination exit 0; text/BLOB/NULL bytes and re-export content hash match');

 // A second hashed native history must agree, even when the legacy one wins
 // selection. Exercise both commands before either can apply migrations.
 const track=`ALTER TABLE d1_migrations ADD COLUMN sha256 TEXT; ALTER TABLE d1_migrations ADD COLUMN state TEXT;
 DELETE FROM d1_migrations;
 INSERT INTO d1_migrations(name,sha256,state) SELECT name,sha256,state FROM _rer_deploy_migrations ORDER BY name;`;
 await source.data(track);
 await source.text(['export','--output','exports/matching.rer']);
 await target.data(track);
 await target.data('DELETE FROM computed_entries; DELETE FROM support_attachments;');
 for(const fixture of [source,target])await fixture.data("UPDATE d1_migrations SET sha256='"+'0'.repeat(64)+"' WHERE id=(SELECT min(id) FROM d1_migrations)");
 const sourceBefore=await histories(source),targetBefore=await histories(target);
 const refused=await source.text(['export','--output','exports/ambiguous.rer'],4);
 const importRefused=await target.text(['import','--input','exports/support.rer','--yes'],4);
 assert.match(refused.stderr,/migration_ledger:multiple/);
 assert.match(importRefused.stderr,/migration_ledger:multiple/);
 assert.deepEqual(await histories(source),sourceBefore);
 assert.deepEqual(await histories(target),targetBefore);
 assert.deepEqual(await rows(source),expected);
 assert.deepEqual(await rows(target),[[],[]]);
 t.diagnostic('disagreeing hashed native pair: export exit 4 and import exit 4, migration_ledger:multiple; histories and product rows preserved');

 await source.data("UPDATE _rer_deploy_migrations SET state='applying' WHERE name=(SELECT min(name) FROM _rer_deploy_migrations)");
 assert.match((await source.text(['export','--output','exports/partial.rer'],4)).stderr,/migration_ledger:uncertain/);
 await source.data("UPDATE _rer_deploy_migrations SET state='applied'; DROP TABLE d1_migrations; CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY,name TEXT,applied_at TEXT); DELETE FROM _rer_deploy_migrations WHERE name='0999_computed_entries.sql';");
 assert.match((await source.text(['export','--output','exports/pending.rer'],4)).stderr,/migration_ledger:unapplied.*0999_computed_entries\.sql/);
 t.diagnostic('legacy incomplete claim and pending checkout file: exit 4 with migration_ledger:uncertain and migration_ledger:unapplied');

 // The same transfer with Platform history alone keeps its supported behavior.
 const platform=`DROP TABLE _rer_deploy_migrations; DROP TABLE d1_migrations;
 CREATE TABLE rer_migrations(name TEXT PRIMARY KEY,sha256 TEXT NOT NULL,applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
 INSERT INTO rer_migrations(name,sha256) VALUES ${entries.map(({name,sha256})=>`('${name}','${sha256}')`).join(',')};`;
 for(const fixture of [source,target])await fixture.data(platform);
 await source.text(['export','--output','exports/platform.rer']);
 await copyFile(join(source.root,'exports/platform.rer'),join(target.root,'exports/platform.rer'));
 await target.text(['import','--input','exports/platform.rer','--yes']);
 assert.deepEqual(await rows(target),expected);
 for(const fixture of [source,target])assert.deepEqual((await fixture.data("SELECT name FROM sqlite_master WHERE name='d1_migrations'"))[0].results,[]);
 t.diagnostic('rer_migrations only: export exit 0 and import exit 0; exact restored values, no Wrangler ledger created');
});
