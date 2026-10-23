import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPortability,makePart } from '../index.mjs';
import { ContentVerifier,ArchiveVerifier } from '../format.mjs';
import { runtime,seed,archive,restore,rows } from './helpers.mjs';
import { fixturePolicy } from './fixture-policy.mjs';
import { faultDatabase } from './faults.mjs';
import { createLedger } from '../../deploy-kit/migration-ledger.mjs';
async function setup(t,options={}) {
  const source=await runtime(t);await seed(source);const bundle=await archive(await source.connect()),target=await runtime(t,options),service=await target.connect();
  return {source,bundle,target,service};
}
async function stage(service,bundle) {const id=await service.imports.create(bundle.manifest);for(const p of bundle.parts)await service.imports.uploadPart(id,p.index,p);return id;}
async function interruptedLedger(db) {
  await db.batch([db.prepare(createLedger),db.prepare("INSERT INTO d1_migrations(name,sha256,state) VALUES('001_schema.sql',?,'applying')").bind('a'.repeat(64))]);
}
async function refusesUncertainImport(service,bundle,target) {
  const tables=['d1_migrations','rer_portability_state','rer_portability_jobs','rer_portability_parts','rer_portability_segments','rer_portability_guard','rer_portability_owned',...bundle.manifest.tables.map(t=>t.name)];
  const snapshot=async()=> (await target.db.batch([
    target.db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name'),
    ...tables.map(table=>target.db.prepare('SELECT * FROM "'+table+'"')),
  ])).map(result=>result.results);
  const before=await snapshot();
  await assert.rejects(service.imports.create(bundle.manifest),e=>e.code==='schema_mismatch:uncertain_migrations' && e.status===409);
  assert.deepEqual(await snapshot(),before,'refusal preserves schema, ledger, jobs, lock and data');
  assert.equal((await target.bucket.list()).objects.length,0);
}
async function changed(bundle,table,change) {
  const out=structuredClone(bundle);for(let i=0;i<out.parts.length;i++){const p=out.parts[i];for(const x of p.items)if(x.table===table)change(x.row);out.parts[i]=await makePart(p.index,p.items);}
  const verifier=new ContentVerifier(out.manifest);for(const p of out.parts)for(const x of p.items)verifier.add(x);out.contentHash=verifier.digest();const integrity=new ArchiveVerifier(out.manifest);for(const p of out.parts)integrity.add(p);out.closing.archiveHash=integrity.digest();return out;
}
test('import refuses a non-empty destination',async t=>{
  const {bundle,target,service}=await setup(t);await target.db.prepare("INSERT INTO heap VALUES('existing')").run();const id=await stage(service,bundle);await assert.rejects(service.imports.finalize(id,{archiveHash:bundle.closing.archiveHash}),/target_not_empty:heap/);
});
test('import refuses a non-empty bucket without claiming or deleting keys',async t=>{
  const {bundle,target,service}=await setup(t);await target.bucket.put('small','foreign');const id=await stage(service,bundle);
  await assert.rejects(service.imports.finalize(id,{archiveHash:bundle.closing.archiveHash}),/bucket_not_empty/);assert.equal(await (await target.bucket.get('small')).text(),'foreign');
  assert.equal((await target.db.prepare('SELECT COUNT(*) AS n FROM rer_portability_owned').first()).n,0);
});
test('wrong products are refused',async t=>{const {bundle,service}=await setup(t);const m={...bundle.manifest,product:'other'};await assert.rejects(service.imports.create(m),/wrong_product/);});
test('schema mismatches are refused and an explicit earlier schema upgrades rows',async t=>{
  const source=await runtime(t);await seed(source);await source.db.prepare('ALTER TABLE heap ADD COLUMN extra TEXT').run();const bundle=await archive(await source.connect()),target=await runtime(t);
  await assert.rejects((await target.connect()).imports.create(bundle.manifest),/schema_mismatch/);
  const service=await createPortability({db:target.db,buckets:{FILES:target.bucket},policy:{...fixturePolicy,acceptedSchemas:{[bundle.manifest.schema]:{upgradeRow(table,row){if(table==='heap')delete row.extra;return row;}}}}});
  await interruptedLedger(target.db);
  await refusesUncertainImport(await target.connect(),bundle,target);
  await refusesUncertainImport(service,bundle,target);
  await target.db.prepare("UPDATE d1_migrations SET state='applied'").run();
  assert.equal((await restore(service,bundle)).status.phase,'complete');assert.equal((await target.db.prepare('SELECT COUNT(*) AS n FROM heap').first()).n,3);
});
test('table and column inventories cannot omit destination data',async t=>{
  const {bundle,service}=await setup(t),m=structuredClone(bundle.manifest);m.tables[0].columns[0].notnull=1-m.tables[0].columns[0].notnull;
  await assert.rejects(service.imports.create(m),/column_inventory/);
});
test('duplicate uploads are no-ops, different contents return 409',async t=>{
  const {bundle,service,target}=await setup(t),id=await service.imports.create(bundle.manifest),p=bundle.parts[0];const status=await service.imports.uploadPart(id,0,p);
  assert.deepEqual(await service.imports.uploadPart(id,0,p),status);const other=await makePart(0,p.items.map(x=>x.kind==='row'?{...x,row:{...x.row,message:'changed'}}:x));
  await assert.rejects(service.imports.uploadPart(id,0,other),e=>e.code==='part_conflict' && e.status===409);
  assert.equal((await target.db.prepare('SELECT COUNT(*) AS n FROM rer_portability_parts').first()).n,1);
});
test('uploads enforce order, checksums, declared columns, types and NOT NULL',async t=>{
  const {bundle,service}=await setup(t),id=await service.imports.create(bundle.manifest);
  await assert.rejects(service.imports.uploadPart(id,1,bundle.parts[1]),/part_order/);
  await assert.rejects(service.imports.uploadPart(id,0,{...bundle.parts[0],sha256:'0'.repeat(64)}),/part_checksum/);
  const item={kind:'row',table:'effects',index:0,row:{id:'x',enabled:0,delivery:'review'}};
  await assert.rejects(service.imports.uploadPart(id,0,await makePart(0,[{...item,row:{...item.row,unknown:'x'}}])),/row_columns/);
  await assert.rejects(service.imports.uploadPart(id,0,await makePart(0,[{...item,row:{...item.row,delivery:null}}])),/row_not_null/);
  await assert.rejects(service.imports.uploadPart(id,0,await makePart(0,[{...item,row:{...item.row,enabled:'x'}}])),/unsafe_integer/);
});
test('finalize requires all parts and the archive binding before publishing',async t=>{
  const {bundle,service,target}=await setup(t),manifest={...bundle.manifest,sourceIdentity:bundle.manifest.sourceIdentity+'-altered'},id=await service.imports.create(manifest);await assert.rejects(service.imports.finalize(id,{archiveHash:bundle.closing.archiveHash}),/parts_missing/);
  for(const p of bundle.parts)await service.imports.uploadPart(id,p.index,p);
  await assert.rejects(service.imports.finalize(id),/archive_checksum/);
  await assert.rejects(service.imports.finalize(id,{archiveHash:'0'.repeat(64)}),/archive_checksum/);
  await assert.rejects(service.imports.finalize(id,{contentHash:'0'.repeat(64),archiveHash:bundle.closing.archiveHash}),/content_checksum/);
  await assert.rejects(service.imports.finalize(id,{contentHash:bundle.contentHash,archiveHash:bundle.closing.archiveHash}),/archive_checksum/);
  assert.equal((await target.db.prepare('SELECT COUNT(*) AS n FROM effects').first()).n,0);
  assert.equal((await target.bucket.list()).objects.length,0);
  assert.equal((await target.db.prepare('SELECT applying FROM rer_portability_state').first()).applying,0);
});
test('foreign-key failure rolls back rows and triggers, removing every owned object',async t=>{
  const {bundle,target,service}=await setup(t),bad=await changed(bundle,'cycle_a',row=>{row.b='absent';}),id=await stage(service,bad);
  await assert.rejects(service.imports.finalize(id,{archiveHash:bad.closing.archiveHash}),/FOREIGN KEY/);
  for(const table of bad.manifest.tables)assert.equal((await target.db.prepare('SELECT COUNT(*) AS n FROM "'+table.name+'"').first()).n,0,table.name);
  assert.equal((await target.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND name='triggered_insert'").first()).n,1);
  assert.equal((await target.bucket.list()).objects.length,0);assert.equal((await service.imports.status(id)).phase,'staging');
  assert.ok((await target.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name GLOB 'rer_portability_stage_*'").first()).n>0,'rollback keeps staging available until abort');
  await service.imports.abort(id);
  assert.equal((await target.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name GLOB 'rer_portability_stage_*'").first()).n,0);
});
test('fault after R2 writes cleans only owned keys',async t=>{
  const {bundle,target}=await setup(t);let fired=false;
  const db=faultDatabase(target.db,async(sql,commit)=>{if(sql.some(s=>s.startsWith('INSERT INTO "audit"'))){fired=true;await target.bucket.put('foreign','keep');throw new Error('before_commit_fault');}return commit();});
  const s=await createPortability({db,buckets:{FILES:target.bucket},policy:fixturePolicy}),id=await stage(s,bundle);
  await assert.rejects(s.imports.finalize(id,{archiveHash:bundle.closing.archiveHash}),/before_commit_fault/);assert.ok(fired);assert.deepEqual((await target.bucket.list()).objects.map(x=>x.key),['foreign']);
});
test('lost response after D1 commit preserves objects and reports complete',async t=>{
  const {bundle,target}=await setup(t);let fired=false;
  await target.db.prepare('CREATE TABLE rer_portability_stage_unrelated(value TEXT)').run();
  await target.db.prepare("INSERT INTO rer_portability_stage_unrelated VALUES('keep')").run();
  const db=faultDatabase(target.db,async(sql,commit)=>{const result=await commit();if(sql.some(s=>s.startsWith('INSERT INTO "audit"'))){fired=true;throw new Error('lost_response');}return result;});
  const s=await createPortability({db,buckets:{FILES:target.bucket},policy:fixturePolicy}),id=await stage(s,bundle);
  assert.equal((await s.imports.finalize(id,{archiveHash:bundle.closing.archiveHash})).phase,'complete');assert.ok(fired);assert.equal((await s.imports.finalize(id,{archiveHash:bundle.closing.archiveHash})).phase,'complete');
  assert.equal((await target.bucket.list()).objects.length,2);assert.equal((await s.imports.status(id)).phase,'complete');
  assert.deepEqual((await target.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'rer_portability_stage_*'").all()).results,[{name:'rer_portability_stage_unrelated'}]);
  assert.equal((await target.db.prepare('SELECT value FROM rer_portability_stage_unrelated').first()).value,'keep');
});
test('staged product validation can refuse before any R2 write',async t=>{
  const {bundle,target,service}=await setup(t,{policy:{...fixturePolicy,validateStaged:async({read})=>{assert.equal((await read('effects'))[0].enabled,0);return false;}}});
  const id=await stage(service,bundle);await assert.rejects(service.imports.finalize(id,{archiveHash:bundle.closing.archiveHash}),/staged_validation/);assert.equal((await target.bucket.list()).objects.length,0);
});
// Each source policy declares no references, so its archive carries file rows and objects as they are.
test('restore refuses file references outside the declared prefix before any write',async t=>{
  const {objectReferences}=fixturePolicy.buckets.FILES;
  const source=await runtime(t,{policy:{...fixturePolicy,buckets:{FILES:{prefix:'people/'}}}}),target=await runtime(t,{policy:{...fixturePolicy,buckets:{FILES:{prefix:'people/',objectReferences}}}}),service=await target.connect();
  await target.bucket.put('other/kept.bin','unrelated');
  for(const key of ['other/kept.bin','people-other/x','/people/x','','people/../x']) {
    await source.db.batch([source.db.prepare('DELETE FROM files'),source.db.prepare('INSERT INTO files VALUES(?)').bind(key)]);
    // The dot-segment key passes the prefix, so its archive carries an object of that name too.
    if(key.startsWith('people/'))await source.bucket.put(key,'archived');
    const bundle=await archive(await source.connect()),id=await stage(service,bundle);
    await assert.rejects(service.imports.finalize(id,{archiveHash:bundle.closing.archiveHash}),/object_references:FILES/,JSON.stringify(key));
    assert.deepEqual((await target.bucket.list()).objects.map(x=>x.key),['other/kept.bin']);assert.equal(await (await target.bucket.get('other/kept.bin')).text(),'unrelated');
    assert.equal((await target.db.prepare('SELECT COUNT(*) AS n FROM files').first()).n,0);await service.imports.abort(id);
  }
});
test('restore refuses file references that differ from the archived objects',async t=>{
  const source=await runtime(t,{policy:{...fixturePolicy,buckets:{FILES:{}}}}),target=await runtime(t),service=await target.connect();await seed(source);
  const refused=async()=>{
    const bundle=await archive(await source.connect()),id=await stage(service,bundle);
    await assert.rejects(service.imports.finalize(id,{archiveHash:bundle.closing.archiveHash}),/object_references:FILES/);
    assert.equal((await target.bucket.list()).objects.length,0);assert.equal((await target.db.prepare('SELECT COUNT(*) AS n FROM files').first()).n,0);await service.imports.abort(id);
  };
  // A referenced object the archive lacks, then an archived object nothing references.
  await source.bucket.delete('small');await refused();
  await source.bucket.put('small',Uint8Array.of(1,2,3));await source.db.prepare("DELETE FROM files WHERE key='small'").run();await refused();
});
test('replaceable rows, suppressed triggers, NULL secrets and configuration survive restore',async t=>{
  const {bundle,target,service}=await setup(t);await target.db.prepare("INSERT INTO settings VALUES('theme','migration seed')").run();
  // Pooled destinations can retain SQLite internals from earlier cases. Compare
  // this destination's own inventory across restore, cleaning its export first.
  const before=await archive(service);await service.exports.abort(before.id);
  const {status}=await restore(service,bundle);assert.deepEqual(status.requiredConfiguration,['PROVIDER_KEY']);
  assert.deepEqual((await archive(service)).manifest.excludedTables,before.manifest.excludedTables);
  assert.equal((await target.db.prepare('SELECT value FROM settings').first()).value,'blue');assert.equal((await target.db.prepare('SELECT COUNT(*) AS n FROM audit').first()).n,1);
  assert.equal((await target.db.prepare('SELECT credential FROM effects').first()).credential,null);
  await target.db.prepare("INSERT INTO triggered VALUES('after')").run();assert.equal((await target.db.prepare('SELECT COUNT(*) AS n FROM audit').first()).n,2);
});
test('only one import runs and abort releases its durable lock and staging',async t=>{
  const {bundle,target,service}=await setup(t),id=await service.imports.create(bundle.manifest);await service.imports.uploadPart(id,0,bundle.parts[0]);
  await assert.rejects(service.imports.create(bundle.manifest),e=>e.code==='import_running' && e.status===409);
  await service.imports.abort(id);assert.equal((await target.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name GLOB 'rer_portability_stage_*'").first()).n,0);
  assert.equal((await target.db.prepare('SELECT COUNT(*) AS n FROM rer_portability_segments').first()).n,0);assert.ok(await service.imports.create(bundle.manifest));
});
test('direct bindings export, import, export gives equal rows, objects and contentHash',async t=>{
  const {bundle,target,source,service}=await setup(t);await interruptedLedger(target.db);
  await refusesUncertainImport(service,bundle,target);
  const accepted=await createPortability({db:target.db,buckets:{FILES:target.bucket},policy:{...fixturePolicy,acceptedSchemas:{[bundle.manifest.schema]:{upgradeRow:(_table,row)=>row}}}});
  await refusesUncertainImport(accepted,bundle,target);
  await target.db.prepare("UPDATE d1_migrations SET state='applied'").run();
  await restore(service,bundle);const second=await archive(service);
  assert.equal(second.contentHash,bundle.contentHash);assert.deepEqual(rows(second),rows(bundle));
  assert.equal((await target.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name GLOB 'rer_portability_stage_*'").first()).n,0);
  for(const key of ['large','small'])assert.deepEqual(new Uint8Array(await (await target.bucket.get(key)).arrayBuffer()),new Uint8Array(await (await source.bucket.get(key)).arrayBuffer()));
  assert.deepEqual(second.manifest.objects,bundle.manifest.objects);assert.equal(second.manifest.sourceIdentity,bundle.manifest.sourceIdentity);
});
test('an independently corrupted R2 write is refused before D1 commit',async t=>{
  const {bundle,target}=await setup(t),bucket={get:(...args)=>target.bucket.get(...args),list:(...args)=>target.bucket.list(...args),delete:(...args)=>target.bucket.delete(...args),
    put:async(key,bytes,metadata)=>target.bucket.put(key,new Uint8Array(bytes).fill(99),metadata)};
  const s=await createPortability({db:target.db,buckets:{FILES:bucket},policy:fixturePolicy}),id=await stage(s,bundle);
  await assert.rejects(s.imports.finalize(id,{archiveHash:bundle.closing.archiveHash}),/object_write_checksum/);assert.equal((await target.bucket.list()).objects.length,0);
  assert.equal((await target.db.prepare('SELECT COUNT(*) AS n FROM effects').first()).n,0);
});
test('applying ownership resumes after restart and abort deletes only owned keys',async t=>{
  const {bundle,target,service}=await setup(t),id=await stage(service,bundle);
  await target.db.prepare("UPDATE rer_portability_jobs SET phase='applying' WHERE id=?").bind(id).run();await target.db.prepare('UPDATE rer_portability_state SET applying=1 WHERE id=1').run();
  await target.db.prepare('INSERT INTO rer_portability_owned VALUES(?,?,?)').bind(id,'FILES','small').run();await target.bucket.put('small',Uint8Array.of(1,2,3));
  const resumed=await target.reopen();assert.equal((await resumed.imports.status(id)).phase,'applying');assert.equal((await resumed.imports.finalize(id,{archiveHash:bundle.closing.archiveHash})).phase,'complete');
  const f=await runtime(t),s=await f.connect(),other=await stage(s,bundle);await f.db.prepare('INSERT INTO rer_portability_owned VALUES(?,?,?)').bind(other,'FILES','owned').run();await f.bucket.put('owned','operation');await f.bucket.put('foreign','keep');
  await s.imports.abort(other);assert.deepEqual((await f.bucket.list()).objects.map(x=>x.key),['foreign']);
});
