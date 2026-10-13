import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { portabilityFixture } from './fixtures/portability.mjs';
import { tombstone } from '../modules/portability/journal.mjs';

// Exported by the unchanged pre-base-72 CLI at a7e9c7a; generation commands and
// results live in evidence/base-79. No version relabelling creates this fixture.
// The fixture predates later additive migrations, so recovery also bridges them.
test('owner acknowledges backup-only v1 recovery into an empty installation and keeps a normally importable backup', {timeout:12*60_000}, async t=>{
 const bytes=await readFile(new URL('./fixtures/legacy-v1.rer',import.meta.url));
 const records=bytes.toString().trim().split('\n').map(JSON.parse),manifest=records[0],closing=records.at(-1);
 const recovery=['import','--input','exports/legacy.rer','--legacy-v1','--yes','--acknowledge-unverified-metadata','--output','exports/recovered.rer'];
 const target=await portabilityFixture(t,{generated:false});
 await writeFile(join(target.root,'exports/legacy.rer'),bytes,{mode:0o600});
 await target.run(['import','--input','exports/legacy.rer','--yes'],4);
 await target.run(recovery.filter(flag=>flag!=='--acknowledge-unverified-metadata'),4);
 await assert.rejects(stat(join(target.root,'.wrangler/state')),{code:'ENOENT'});
 const corrupt=structuredClone(records);corrupt.find(r=>r.kind==='part').sha256='0'.repeat(64);
 await writeFile(join(target.root,'exports/legacy.rer'),corrupt.map(JSON.stringify).join('\n')+'\n',{mode:0o600});
 await target.run(recovery,1);
 await assert.rejects(stat(join(target.root,'.wrangler/state')),{code:'ENOENT'});
 await assert.rejects(stat(join(target.root,'exports/recovered.rer')),{code:'ENOENT'});
 await writeFile(join(target.root,'exports/legacy.rer'),bytes);
 const restored=(await target.run(recovery)).at(-1);
 assert.equal(restored.restoredContentHash,closing.contentHash);
 assert.equal(restored.unverifiedMetadata,true);
 for(const table of manifest.tables) {
  const expected=records.flatMap(r=>r.items??[]).filter(r=>r.table===table.name).map(r=>r.row);
  const actual=(await target.data(`SELECT * FROM "${table.name}"`))[0].results;
  assert.deepEqual(actual,expected,`${table.name}: recovered contents equal the original backup`);
 }
 const applied=(await target.data('SELECT name FROM d1_migrations ORDER BY id'))[0].results.map(r=>r.name);
 assert.ok(restored.bridged.migrations.length && restored.bridged.tables.length);
 assert.deepEqual(restored.bridged.migrations,applied.slice(-restored.bridged.migrations.length),'bridged migrations are the latest ones applied');
 for(const table of restored.bridged.tables)assert.equal((await target.data(`SELECT COUNT(*) AS n FROM "${table}"`))[0].results[0].n,0,`${table} stays empty`);
 const audit=(await target.data('SELECT details FROM rer_portability_recovery_audit'))[0].results.map(r=>JSON.parse(r.details));
 assert.equal(audit.length,1);assert.equal(audit[0].acknowledgedUnverifiedMetadata,true);
 assert.equal(audit[0].sourceIdentity,manifest.sourceIdentity);assert.equal(audit[0].contentHash,closing.contentHash);
 assert.deepEqual(audit[0].bridged,restored.bridged);
 assert.deepEqual((await target.data('SELECT tombstone FROM rer_portability_journal ORDER BY tombstone'))[0].results.map(r=>r.tombstone),manifest.journal);
 const second=await portabilityFixture(t,{generated:false});
 await writeFile(join(second.root,'exports/recovered.rer'),await readFile(join(target.root,'exports/recovered.rer')),{mode:0o600});
 const reimported=(await second.run(['import','--input','exports/recovered.rer','--yes'])).at(-1);
 assert.equal(reimported.contentHash,restored.contentHash);assert.equal(reimported.bridged,undefined);
 const before=(await second.data('SELECT * FROM articles ORDER BY id'))[0].results;
 await writeFile(join(second.root,'exports/legacy.rer'),bytes,{mode:0o600});
 const refused=await second.run([...recovery.slice(0,-1),'exports/refused-recovery.rer'],4);
 assert.match(refused.find(event=>event.event==='error').message,/legacy_target_not_empty/);
 await assert.rejects(stat(join(second.root,'exports/refused-recovery.rer')),{code:'ENOENT'});
 assert.deepEqual((await second.data('SELECT * FROM articles ORDER BY id'))[0].results,before);
 // Excluded identity data also makes an installation non-empty.
 const identity=await portabilityFixture(t,{generated:false});
 await identity.run(['export','--output','exports/empty.rer']);
 await identity.data("INSERT INTO operators VALUES('existing-owner','owner@example.test','2026-10-01')");
 await writeFile(join(identity.root,'exports/legacy.rer'),bytes,{mode:0o600});
 const identityRefused=await identity.run(recovery,4);
 assert.match(identityRefused.find(event=>event.event==='error').message,/legacy_target_not_empty/);
 assert.equal((await identity.data('SELECT COUNT(*) AS n FROM articles'))[0].results[0].n,0);
 assert.equal((await identity.data('SELECT COUNT(*) AS n FROM operators'))[0].results[0].n,1);
 // A carried tombstone must still fence a matching retained row.
 const erased=await portabilityFixture(t,{generated:false}),fenced=structuredClone(records);
 fenced[0].journal.push(await tombstone(manifest.sourceIdentity,'articles',{id:'recovered'}));
 await writeFile(join(erased.root,'exports/legacy.rer'),fenced.map(JSON.stringify).join('\n')+'\n',{mode:0o600});
 // The reviewed erasure fence reports this as a refusal, not a failed transfer.
 const fenceRefused=await erased.run(recovery,4);
 assert.match(fenceRefused.find(event=>event.event==='error').message,/erased_row/);
 assert.equal((await erased.data('SELECT COUNT(*) AS n FROM articles'))[0].results[0].n,0);
 assert.equal((await erased.data('SELECT COUNT(*) AS n FROM rer_portability_recovery_audit'))[0].results[0].n,0);
});
