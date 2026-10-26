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
async function stage(service,bundle) {const id=await service.imports.create(bundle.manifest,undefined,{acknowledgeUnverifiedSchemaObjects:true});for(const p of bundle.parts)await service.imports.uploadPart(id,p.index,p);return id;}
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
  await assert.rejects(service.imports.create(bundle.manifest,undefined,{acknowledgeUnverifiedSchemaObjects:true}),e=>e.code==='schema_mismatch:uncertain_migrations' && e.status===409);
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
test('wrong products are refused',async t=>{const {bundle,service}=await setup(t);const m={...bundle.manifest,product:'other'};await assert.rejects(service.imports.create(m,undefined,{acknowledgeUnverifiedSchemaObjects:true}),/wrong_product/);});
test('schema mismatches are refused and an explicit earlier schema upgrades rows',async t=>{
  const source=await runtime(t);await seed(source);await source.db.prepare('ALTER TABLE heap ADD COLUMN extra TEXT').run();const bundle=await archive(await source.connect()),target=await runtime(t);
  await assert.rejects((await target.connect()).imports.create(bundle.manifest),/schema_mismatch/);
  const service=await createPortability({db:target.db,buckets:{FILES:target.bucket},policy:{...fixturePolicy,acceptedSchemas:{[bundle.manifest.schema]:{upgradeRow(table,row){if(table==='heap')delete row.extra;return row;}}}}});
  await interruptedLedger(target.db);
  await refusesUncertainImport(await target.connect(),bundle,target);
  await refusesUncertainImport(service,bundle,target);
  await target.db.prepare("UPDATE d1_migrations SET state='applied'").run();
  assert.equal((await restore(service,bundle)).status.phase,'complete');assert.equal((await target.db.prepare('SELECT COUNT(*) AS n FROM heap').first()).n,3);
  await t.test('acknowledged table-only v2 recovery',acknowledgedRecovery);
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
  const {bundle,service,target}=await setup(t),manifest={...bundle.manifest,sourceIdentity:bundle.manifest.sourceIdentity+'-altered'},id=await service.imports.create(manifest,undefined,{acknowledgeUnverifiedSchemaObjects:true});await assert.rejects(service.imports.finalize(id,{archiveHash:bundle.closing.archiveHash}),/parts_missing/);
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

async function acknowledgedRecovery(t) {
  const {database,bundle:exportBundle}=await import('./regression-helpers.mjs');
  const {migrationReplay}=await import('../migration-history.mjs');
  const {importArchive}=await import('../files.mjs');
  const {mkdtemp,writeFile,rm}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');
  const {join}=await import('node:path');
  const {canonicalJson}=await import('../hash.mjs');
  const {schemaIdentityOf}=await import('../schema-identity.mjs');
  const policy={product:'synthetic-base-1',buckets:{FILES:{}}};
  const statements=['CREATE TABLE items(id TEXT PRIMARY KEY,value TEXT)',
    'CREATE INDEX item_value ON items(value)',
    'CREATE VIEW item_view AS SELECT id,value FROM items',
    'CREATE TRIGGER item_guard BEFORE INSERT ON items WHEN NEW.value IS NULL BEGIN SELECT RAISE(ABORT,\'synthetic-base-2\'); END'];
  const plan=[{name:'0001_synthetic.sql',statements}];
  const directory=await mkdtemp(join(tmpdir(),'synthetic-base-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const target=async(t,extra=[],files=plan)=>{
    const f=await database(t,[...statements,'CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY,name TEXT,applied_at TEXT NOT NULL)',"INSERT INTO d1_migrations VALUES(1,'0001_synthetic.sql','synthetic-base-3')",...extra],policy);
    f.service=await createPortability({db:f.db,buckets:{FILES:f.bucket},policy,migrations:async()=>migrationReplay(files,policy)});return f;
  };
  const source=await target(t);
  await source.db.prepare("INSERT INTO items VALUES('synthetic-base-4','synthetic-base-5'),('synthetic-base-6','synthetic-base-7')").run();
  const bytes=new TextEncoder().encode('synthetic-base-8');await source.bucket.put('synthetic-base-9',bytes);
  const original=await exportBundle(source.service);
  const write=async(name,change)=>{
    const records=structuredClone(original.records);if(change)change(records[0]);
    records[0].schema=await schemaIdentityOf(records[0].tables,records[0].schemaObjects);
    for(const part of records.slice(1,-1)) {
      for(const item of part.items)if(item.kind==='row') {
        const pos=original.manifest.tables.findIndex(t=>t.name===item.table),before=original.manifest.tables[pos],after=records[0].tables[pos];
        item.table=after.name;item.row=Object.fromEntries(Object.entries(item.row).map(([key,value])=>[after.columns[before.columns.findIndex(c=>c.name===key)].name,value]));
      }
      Object.assign(part,await makePart(part.index,part.items));
    }
    const integrity=new ArchiveVerifier(records[0]),content=new ContentVerifier(records[0]);
    records.slice(1,-1).forEach(p=>{integrity.add(p);p.items.forEach(item=>content.add(item));});records.at(-1).archiveHash=integrity.digest();records.at(-1).contentHash=content.digest();
    const path=join(directory,name+'.rer');await writeFile(path,records.map(canonicalJson).join('\n')+'\n');return path;
  };
  const old=await write('old',m=>{delete m.schemaObjects;});
  const options={acknowledgeUnverifiedSchemaObjects:true};
  const restoreOld=(f,path=old)=>importArchive(f.service,path,[],undefined,undefined,options);
  const snapshot=async f=>({schema:(await f.db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all()).results,items:(await f.db.prepare('SELECT * FROM items ORDER BY id').all()).results,jobs:(await f.db.prepare('SELECT * FROM rer_portability_jobs').all()).results,objects:(await f.bucket.list()).objects,state:(await f.db.prepare('SELECT * FROM rer_portability_state').all()).results,ledger:(await f.db.prepare('SELECT * FROM d1_migrations ORDER BY id').all()).results});
  await t.test('ordinary refusal writes nothing',async t=>{
    const f=await target(t),before=await snapshot(f);
    await assert.rejects(importArchive(f.service,old,[]),e=>e.code==='schema_mismatch:legacy_schema');
    assert.deepEqual(await snapshot(f),before);console.log('ordinary => schema_mismatch:legacy_schema; rows 0 -> 0; jobs 0 -> 0');
  });
  await t.test('acknowledged rows, bytes, destination structure and durable receipt',async t=>{
    const f=await target(t),before=(await snapshot(f)).schema;
    const upload=f.service.imports.uploadPart;
    f.service.imports.uploadPart=async(...args)=>{
      await assert.rejects(f.service.exports.create(),e=>e.code==='import_applying');
      return upload(...args);
    };
    const result=await restoreOld(f);
    assert.equal((await f.db.prepare('SELECT applying FROM rer_portability_state').first()).applying,0);
    console.log('maintenance => competing export refused during staging; released after completion');
    assert.deepEqual((await snapshot(f)).items,(await snapshot(source)).items);
    assert.deepEqual(new Uint8Array(await (await f.bucket.get('synthetic-base-9')).arrayBuffer()),bytes);
    assert.deepEqual((await snapshot(f)).schema,before);
    assert.equal(result.schemaUnverified.sourceIdentity,original.manifest.sourceIdentity);
    assert.ok(Date.parse(result.schemaUnverified.acknowledgedAt));
    const job=await f.db.prepare("SELECT id FROM rer_portability_jobs WHERE phase='complete'").first();
    assert.deepEqual((await f.service.imports.status(job.id)).schemaUnverified,result.schemaUnverified);
    console.log('acknowledged => rows 0 -> 2; assets 0 -> 1; original bytes match; receipt',JSON.stringify(result.schemaUnverified));
  });
  await t.test('nonempty and incompatible schemas refuse before staging',async t=>{
    for(const kind of ['nonempty','table','column','ledger'])await t.test(kind,async t=>{
      const f=await target(t);
      if(kind==='nonempty')await f.db.prepare("INSERT INTO items VALUES('synthetic-base-10','synthetic-base-11')").run();
      const path=kind==='table'?await write(kind,m=>{delete m.schemaObjects;m.tables[0].name='synthetic-base-12';}):kind==='column'?await write(kind,m=>{delete m.schemaObjects;m.tables[0].columns[1].name='synthetic-base-13';}):kind==='ledger'?await write(kind,m=>{delete m.schemaObjects;m.migrations=['synthetic-base-14'];}):old;
      const before=await snapshot(f),code=kind==='nonempty'?'target_not_empty:items':kind==='table'?'schema_mismatch:table:synthetic-base-12':kind==='column'?'schema_mismatch:column:items:synthetic-base-13':'migration_ledger:unknown:synthetic-base-14';
      await assert.rejects(restoreOld(f,path),e=>e.code===code);assert.deepEqual(await snapshot(f),before);console.log(kind,'=>',code,'; destination unchanged');
    });
  });
  await t.test('unrecorded prefix and later destination columns restore',async t=>{
    const sql="ALTER TABLE items ADD COLUMN later TEXT DEFAULT 'synthetic-base-16'";
    const f=await target(t,[sql,"INSERT INTO d1_migrations VALUES(2,'0002_synthetic.sql','synthetic-base-17')"],[...plan,{name:'0002_synthetic.sql',statements:[sql]}]);
    const path=await write('unrecorded',m=>{delete m.schemaObjects;delete m.migrations;});
    const result=await restoreOld(f,path);
    assert.deepEqual(result.bridged.migrations,['0002_synthetic.sql']);
    assert.deepEqual((await f.db.prepare('SELECT later FROM items').all()).results,[{later:'synthetic-base-16'},{later:'synthetic-base-16'}]);
    console.log('unrecorded prefix => 2 rows restored; later columns use destination defaults');
  });
  await t.test('older name-only ledgers remain bound to the archive',async t=>{
    for(const name of ['rer_migrations','d1_migrations'])await t.test(name,async t=>{
      const f=await target(t),records=structuredClone(original.records),manifest=records[0];delete manifest.schemaObjects;delete manifest.migrations;
      const native=name==='d1_migrations';
      manifest.tables.push({name,sql:native?'CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY,name TEXT,applied_at TEXT NOT NULL)':'CREATE TABLE rer_migrations(name TEXT PRIMARY KEY,applied_at TEXT NOT NULL)',columns:native?[{name:'id',type:'INTEGER',notnull:0,pk:1},{name:'name',type:'TEXT',notnull:0,pk:0},{name:'applied_at',type:'TEXT',notnull:1,pk:0}]:[{name:'name',type:'TEXT',notnull:0,pk:1},{name:'applied_at',type:'TEXT',notnull:1,pk:0}],dependencies:[],rowidAlias:null,count:1});
      manifest.tables.sort((a,b)=>a.name<b.name?-1:1);manifest.schema=await schemaIdentityOf(manifest.tables);manifest.partCount=1;
      const row={name:'0001_synthetic.sql',applied_at:'synthetic-base-15',...(native?{id:1}:{})};
      const items=[...original.parts.flatMap(p=>p.items),{kind:'row',table:name,index:0,row}];
      items.sort((a,b)=>a.kind==='row'&&b.kind==='row'?manifest.tables.findIndex(t=>t.name===a.table)-manifest.tables.findIndex(t=>t.name===b.table)||a.index-b.index:a.kind==='row'?-1:b.kind==='row'?1:0);
      const part=await makePart(0,items),content=new ContentVerifier(manifest),integrity=new ArchiveVerifier(manifest);items.forEach(item=>content.add(item));integrity.add(part);
      const path=join(directory,name+'.rer');await writeFile(path,[manifest,part,{kind:'closing',partCount:1,contentHash:content.digest(),archiveHash:integrity.digest()}].map(canonicalJson).join('\n')+'\n');
      const result=await restoreOld(f,path);assert.deepEqual(result.skippedTables,[name]);assert.equal((await snapshot(f)).items.length,2);console.log(name,'name-only => restored 2 rows; destination ledger retained');
    });
  });
  await t.test('stale epoch still refuses at finalization',async t=>{
    const f=await target(t);await f.db.prepare('INSERT INTO rer_portability_epochs VALUES(?,1)').bind(original.manifest.sourceIdentity).run();
    await assert.rejects(restoreOld(f),e=>e.code==='erasure_epoch');assert.equal((await snapshot(f)).items.length,0);assert.equal((await f.bucket.list()).objects.length,0);console.log('acknowledged => erasure_epoch; rows 0 -> 0; assets 0 -> 0');
  });
  await t.test('current inventory restores without acknowledgment or unverified receipt',async t=>{
    const f=await target(t),path=await write('current');const result=await importArchive(f.service,path,[]);
    assert.equal(result.schemaUnverified,undefined);assert.equal((await snapshot(f)).items.length,2);assert.deepEqual(new Uint8Array(await (await f.bucket.get('synthetic-base-9')).arrayBuffer()),bytes);console.log('current => rows 0 -> 2; assets 0 -> 1; schemaUnverified absent');
  });
}
