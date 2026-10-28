import { runCases } from './cases.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runtime,seed,archive,restore } from './helpers.mjs';
import { tombstone } from '../journal.mjs';
import { createPortability } from '../index.mjs';
import { fixturePolicy } from './fixture-policy.mjs';
import { faultDatabase } from './faults.mjs';
async function setup(t) {const source=await runtime(t);await seed(source);const target=await runtime(t);return {source,target,s:await source.connect(),d:await target.connect()};}
test("restore preserves erasure journals and refuses erased rows or stale epochs", async t => {
  const foldedCases = [];
foldedCases.push(['archive journal refuses a tombstoned archived row', async t=>{
  const {source,s,d}=await setup(t);await source.db.batch(await s.erasureStatements('effects',{id:'send'}));const a=await archive(s);await assert.rejects(restore(d,a),/erased_row:effects/);
}]);
foldedCases.push(['destination tombstones survive an import and refuse matching rows', async t=>{
  const {source,target,s,d}=await setup(t);await target.db.batch(await d.erasureStatements('heap',{rowid:999}));
  const previous=(await target.db.prepare('SELECT * FROM rer_portability_journal').all()).results;
  const a=await archive(s);await restore(d,a);assert.deepEqual((await target.db.prepare('SELECT * FROM rer_portability_journal WHERE source=?').bind(previous[0].source).all()).results,previous);
  const fresh=await runtime(t),service=await fresh.connect(),hash=await tombstone(a.manifest.sourceIdentity,'effects',{id:'send'});
  await fresh.db.prepare('INSERT INTO rer_portability_journal VALUES(?,?)').bind(a.manifest.sourceIdentity,hash).run();await assert.rejects(restore(service,a),/erased_row:effects/);
}]);
foldedCases.push(['separately supplied later journal is enforced and merged at commit', async t=>{
  const {s,d,target}=await setup(t),a=await archive(s),hash=await tombstone(a.manifest.sourceIdentity,'effects',{id:'send'});
  await assert.rejects(restore(d,a,{options:{laterJournal:{sourceIdentity:a.manifest.sourceIdentity,epoch:1,journal:[hash]}}}),/erased_row:effects/);
  const jobs=(await target.db.prepare("SELECT id FROM rer_portability_jobs WHERE kind='import'").all()).results;await d.imports.abort(jobs[0].id);
  const unrelated=await tombstone(a.manifest.sourceIdentity,'effects',{id:'gone'});
  await restore(d,a,{options:{laterJournal:{sourceIdentity:a.manifest.sourceIdentity,epoch:2,journal:[unrelated]}}});
  assert.equal((await target.db.prepare('SELECT epoch FROM rer_portability_state').first()).epoch,2);
  assert.equal((await target.db.prepare('SELECT COUNT(*) AS n FROM rer_portability_journal WHERE tombstone=?').bind(unrelated).first()).n,1);
}]);
foldedCases.push(['archives older than the recorded source epoch are refused', async t=>{
  const {s,d,target}=await setup(t),a=await archive(s);await target.db.prepare('INSERT INTO rer_portability_epochs VALUES(?,?)').bind(a.manifest.sourceIdentity,1).run();await assert.rejects(restore(d,a),/erasure_epoch/);
}]);
foldedCases.push(['keyless rowids with gaps restore exactly and are erasure-fenced', async t=>{
  const {s,d,source,target}=await setup(t);await source.db.prepare("INSERT INTO heap(rowid,value) VALUES(42,'gap')").run();
  const a=await archive(s);await restore(d,a);assert.deepEqual((await target.db.prepare('SELECT rowid,value FROM heap ORDER BY rowid').all()).results,(await source.db.prepare('SELECT rowid,value FROM heap ORDER BY rowid').all()).results);
  const fresh=await runtime(t);await source.db.batch(await s.erasureStatements('heap',{rowid:42}));const fenced=await archive(s);await assert.rejects(restore(await fresh.connect(),fenced),/erased_row:heap/);
}]);
  await runCases(t, foldedCases);
});



test('erasure invalidation removes every snapshot, staging copy and stored part',async t=>{
  const {s,d,source,target}=await setup(t),a=await archive(s),id=await d.imports.create(a.manifest);await d.imports.uploadPart(id,0,a.parts[0]);
  for(const [service,f] of [[s,source],[d,target]]) {
    await f.db.batch([...(await service.invalidateTransfersStatements()),...(await service.erasureStatements('effects',{id:'gone'}))]);
    assert.equal((await f.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name GLOB 'rer_portability_snap_*' OR name GLOB 'rer_portability_stage_*'").first()).n,0);
    for(const table of ['jobs','parts','segments'])assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM rer_portability_'+table).first()).n,0);
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM rer_portability_journal').first()).n,1);
  }
});

test('a tombstone added after staging is checked again inside the restore commit',async t=>{
  const {s,target}=await setup(t),a=await archive(s);let injected=false;
  const db=faultDatabase(target.db,async(sql,commit)=>{if(sql.some(s=>s.startsWith('INSERT INTO "audit"'))){injected=true;await target.db.prepare('INSERT INTO rer_portability_journal VALUES(?,?)').bind(a.manifest.sourceIdentity,await tombstone(a.manifest.sourceIdentity,'effects',{id:'send'})).run();}return commit();});
  const d=await createPortability({db,buckets:{FILES:target.bucket},policy:fixturePolicy});await assert.rejects(restore(d,a),/CHECK constraint/);assert.ok(injected);
  assert.equal((await target.db.prepare('SELECT COUNT(*) AS n FROM effects').first()).n,0);assert.equal((await target.bucket.list()).objects.length,0);
});
