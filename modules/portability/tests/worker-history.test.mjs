import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {Miniflare,convertV4MiniflareOptions} from '../../container/adapters/d1-workerd.mjs';
import {build} from '../../../default-seed/node_modules/vite/dist/node/index.js';
import {legacyMigrationEvidence,generateMigrationEvidence} from '../../../cli/portability-evidence.mjs';
import {createPortability,makePart,canonicalJson,sha256} from '../index.mjs';
import {rawSchemaIdentityOf} from '../schema-legacy.mjs';
import {schemaIdentityOf} from '../schema-identity.mjs';
import {restorableManifest} from '../bookkeeping.mjs';
import {ContentVerifier,ArchiveVerifier} from '../format.mjs';
import {workerMigrations} from '../worker-history.mjs';
import {httpFailure} from '../http-errors.mjs';
import {migrationSeeded} from '../restore-safety.mjs';
import {captureD1Baseline} from '../../../tests/support/d1-baseline.mjs';
import {bundle} from './regression-helpers.mjs';

test('declared Worker evidence restores a carried legacy ledger through the shared library validator',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'worker-evidence-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 await mkdir(join(directory,'declared'));
 await writeFile(join(directory,'wrangler.jsonc'),'{"d1_databases":[{"binding":"DB","migrations_dir":"declared"}]}');
 const files=[
  {name:'0001_records.sql',sql:"CREATE TABLE z_parents(id TEXT PRIMARY KEY);CREATE TABLE a_children(id TEXT PRIMARY KEY,parent TEXT REFERENCES z_parents(id));CREATE INDEX children_parent ON a_children(parent);CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);CREATE INDEX settings_key ON settings(key);CREATE TABLE oa_operators(id TEXT PRIMARY KEY);INSERT INTO oa_operators VALUES('source-owner');INSERT INTO settings VALUES('mode','fresh');"},
  {name:'0002_state.sql',sql:"ALTER TABLE a_children ADD COLUMN state TEXT NOT NULL DEFAULT 'retained';"},
 ];
 for(const f of files){f.sha256=await sha256(f.sql);await writeFile(join(directory,'declared',f.name),f.sql);}
 const evidence=await generateMigrationEvidence(directory);
 assert.deepEqual(await generateMigrationEvidence(directory),evidence,'same checkout generates identical evidence');
 const built=await build({root:directory,configFile:false,logLevel:'silent',plugins:[legacyMigrationEvidence()],build:{write:false,minify:false,ssr:resolve(import.meta.dirname,'evidence-worker.mjs')}});
 const script=built.output.find(o=>o.type==='chunk').code;
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script,compatibilityDate:'2026-09-08',d1Databases:{DB:'evidence'}}));
 t.after(()=>mf.dispose());const db=await mf.getD1Database('DB');
 const schema=await readFile(new URL('../schema/portability.sql',import.meta.url),'utf8');
 const {splitStatements}=await import('../sql-text.mjs');
 await db.batch([...splitStatements(schema),...splitStatements(files[0].sql),
  'CREATE TABLE rer_migrations(name TEXT PRIMARY KEY,sha256 TEXT NOT NULL,applied_at TEXT NOT NULL)',
  "INSERT INTO z_parents VALUES('parent')","INSERT INTO a_children VALUES('child','parent')"].map(s=>db.prepare(s)));
 await db.prepare('INSERT INTO rer_migrations VALUES(?,?,?)').bind(files[0].name,files[0].sha256,'2026-10-01').run();
 const policy={product:'synthetic-evidence',excludeTables:['settings']};
 const source=await createPortability({db,policy}),original=await bundle(source);
 const manifest=structuredClone(original.manifest);delete manifest.schemaObjects;delete manifest.migrations;delete manifest.migrationLedger;
 const ledger={name:'rer_migrations',sql:'CREATE TABLE rer_migrations(name TEXT PRIMARY KEY,sha256 TEXT NOT NULL,applied_at TEXT NOT NULL)',columns:[{name:'name',type:'TEXT',notnull:0,pk:1},{name:'sha256',type:'TEXT',notnull:1,pk:0},{name:'applied_at',type:'TEXT',notnull:1,pk:0}],dependencies:[],rowidAlias:null,count:1};
 manifest.tables.push(ledger);manifest.tables.sort((a,b)=>a.name.localeCompare(b.name));manifest.schema=await rawSchemaIdentityOf(manifest.tables);
 const items=original.parts.flatMap(p=>p.items);items.push({kind:'row',table:'rer_migrations',index:0,row:await db.prepare('SELECT * FROM rer_migrations').first()});items.sort((a,b)=>a.table.localeCompare(b.table));
 const seal=async(m,data)=>{const part=await makePart(0,data);m.partCount=1;const c=new ContentVerifier(m),a=new ArchiveVerifier(m);part.items.forEach(i=>c.add(i));a.add(part);return {manifest:m,part,closing:{contentHash:c.digest(),archiveHash:a.digest()}};};
 const valid=await seal(manifest,items);
 const nativeInput={...manifest,schemaObjects:original.manifest.schemaObjects};
 const nativeProjection=await restorableManifest(nativeInput);
 assert.equal(nativeProjection.schema,await rawSchemaIdentityOf(nativeProjection.tables),'native format recognition retains the original table-hash representation');
 const compatibility=await restorableManifest(nativeInput,{canonical:true});
 assert.equal((await restorableManifest(manifest)).schema,await schemaIdentityOf(nativeProjection.tables),'older inventory-free projections retain their existing canonical path');
 assert.equal(compatibility.schema,await schemaIdentityOf(compatibility.tables,compatibility.schemaObjects),'Base restore uses complete canonical compatibility independently');
 await db.batch([db.prepare('DELETE FROM a_children'),db.prepare('DELETE FROM z_parents'),db.prepare(files[1].sql),db.prepare('INSERT INTO rer_migrations VALUES(?,?,?)').bind(files[1].name,files[1].sha256,'2026-10-02'),db.prepare('DELETE FROM rer_portability_jobs')]);
 const restore=await captureD1Baseline(db);
 const snapshot=async()=>canonicalJson((await db.batch(['SELECT * FROM a_children','SELECT * FROM z_parents','SELECT * FROM rer_migrations','SELECT * FROM rer_portability_jobs','SELECT * FROM rer_portability_state'].map(s=>db.prepare(s)))).map(r=>r.results));
 const call=(suffix,method,body)=>mf.dispatchFetch('https://evidence.test/api/portability/imports'+suffix,{method,headers:{Origin:'https://evidence.test'},body:JSON.stringify(body)});
 const variants=[
  ['archive checksum',()=>{},()=>{},b=>{b.closing.archiveHash='0'.repeat(64);}],
  ['unknown hash',(_m,data)=>{data.find(i=>i.table==='rer_migrations').row.sha256='0'.repeat(64);}],
  ['conflicting name',(_m,data)=>{data.find(i=>i.table==='rer_migrations').row.name=files[1].name;}],
  ['non-prefix history',(_m,data)=>{Object.assign(data.find(i=>i.table==='rer_migrations').row,{name:files[1].name,sha256:files[1].sha256});}],
  ['archived definition',async m=>{m.tables.find(x=>x.name==='a_children').sql+=' STRICT';m.schema=await rawSchemaIdentityOf(m.tables);}],
  ['live schema',()=>{},()=>db.prepare('DROP INDEX children_parent').run()],
  ['empty history',async(m,data)=>{m.tables.find(x=>x.name==='rer_migrations').count=0;data.splice(data.findIndex(i=>i.table==='rer_migrations'),1);m.schema=await rawSchemaIdentityOf(m.tables);}],
  ['unknown recorded history',m=>{m.migrations=['unknown.sql'];}],
  ['missing durable index',()=>{},()=>db.prepare('DROP INDEX settings_key').run()],
  ['unaccounted excluded index',()=>{},()=>db.prepare('CREATE INDEX settings_value ON settings(value)').run()],
  ['missing history',async(m,data)=>{m.tables=m.tables.filter(x=>x.name!=='rer_migrations');data.splice(data.findIndex(i=>i.table==='rer_migrations'),1);m.schema=await rawSchemaIdentityOf(m.tables);}],
 ];
 const refusals=new Map();
 const expectedCodes=['archive_checksum','migration_ledger:unknown:0001_records.sql','migration_ledger:conflict:0002_state.sql','schema_mismatch:migration_history','schema_mismatch:legacy_schema','schema_mismatch','schema_mismatch:legacy_schema','schema_mismatch:legacy_schema','schema_mismatch','schema_mismatch','schema_mismatch:legacy_schema'];
 for(const [name,change,prepare=()=>{},damage=()=>{}] of variants)for(const door of ['library','Worker']) {
  await restore();await prepare();const m=structuredClone(manifest),data=structuredClone(items);await change(m,data);const archive=await seal(m,data);damage(archive);
  const before=await snapshot();
  if(door==='library') {
   const service=await createPortability({db,policy,migrationRoot:directory});let id;
   await assert.rejects(async()=>{id=await service.imports.create(archive.manifest);await service.imports.uploadPart(id,0,archive.part);await service.imports.finalize(id,archive.closing);},error=>{assert.equal(error.code,expectedCodes[variants.findIndex(v=>v[0]===name)]);refusals.set(name,httpFailure(error));return true;});
   if(id)await service.imports.abort(id);
  }else {
   const created=await call('','POST',{confirmed:true,manifest:archive.manifest});const {id}=await created.clone().json();
   let refused=created;
   if(id){assert.equal((await call('/'+id+'/parts/0','PUT',archive.part)).status,200);refused=await call('/'+id+'/finalize','POST',archive.closing);await call('/'+id+'/abort','POST',{});}
   assert.equal(refused.status,refusals.get(name).status,name);
   assert.deepEqual(await refused.json(),refusals.get(name).body,name);
  }
  assert.equal(await snapshot(),before,door+': '+name+' preserves rows, history, jobs and lock');
 }
 for(const door of ['library','Worker']) {
  await restore();
  if(door==='library'){const s=await createPortability({db,policy,migrationRoot:directory}),id=await s.imports.create(valid.manifest);await s.imports.uploadPart(id,0,valid.part);assert.equal((await s.imports.finalize(id,valid.closing)).phase,'complete');}
  else {const created=await call('','POST',{confirmed:true,manifest:valid.manifest}),{id}=await created.json();assert.equal(created.status,201);assert.equal((await call('/'+id+'/parts/0','PUT',valid.part)).status,200);const done=await call('/'+id+'/finalize','POST',valid.closing);assert.equal(done.status,200,await done.clone().text());}
  assert.deepEqual((await db.prepare('SELECT * FROM a_children').all()).results,[{id:'child',parent:'parent',state:'retained'}]);
  assert.equal((await db.prepare('SELECT count(*) n FROM rer_migrations').first()).n,2);
 }
 await restore();
 // Native Wrangler has no content-hash columns. The reviewed build must bind
 // its exact ordered prefix AND full live schema; the ledger remains native.
 await db.batch([db.prepare('DROP TABLE rer_migrations'),db.prepare('CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)'),
  ...files.map((file,i)=>db.prepare('INSERT INTO d1_migrations(id,name,applied_at) VALUES(?,?,?)').bind(i+1,file.name,'2026-10-02')),
  db.prepare("UPDATE settings SET value='destination-only'"),db.prepare("UPDATE oa_operators SET id='destination-owner'")]);
 const nativeRestore=await captureD1Baseline(db);
 const nativeSnapshot=async()=>canonicalJson((await db.batch(['SELECT * FROM a_children','SELECT * FROM z_parents','SELECT * FROM d1_migrations ORDER BY id','SELECT * FROM settings','SELECT * FROM oa_operators','SELECT * FROM rer_portability_jobs','SELECT * FROM rer_portability_state'].map(s=>db.prepare(s)))).map(r=>r.results));
 const nativeLedger=canonicalJson((await db.prepare('SELECT rowid,* FROM d1_migrations ORDER BY id').all()).results);
 const workerRestore=async archive=>{
  const created=await call('','POST',{confirmed:true,manifest:archive.manifest}),{id}=await created.clone().json();
  if(!id)return created;
  for(const part of archive.parts??[archive.part])assert.equal((await call('/'+id+'/parts/'+part.index,'PUT',part)).status,200);
  const response=await call('/'+id+'/finalize','POST',archive.closing);
  if(!response.ok)await call('/'+id+'/abort','POST',{});
  return response;
 };
 for(const [name,change,prepare=()=>{},damage=()=>{}] of variants) {
  await nativeRestore();await prepare();const m=structuredClone(manifest),data=structuredClone(items);await change(m,data);const archive=await seal(m,data);damage(archive);
  const before=await nativeSnapshot(),response=await workerRestore(archive);
  assert.equal(response.status,refusals.get(name).status,'native '+name);
  assert.deepEqual(await response.json(),refusals.get(name).body,'native '+name);
  assert.equal(await nativeSnapshot(),before,'native '+name+' refuses before product, history, authority or job writes');
 }
 for(const [name,prepare] of [
  ['unknown live name',()=>db.prepare("UPDATE d1_migrations SET name='unknown.sql' WHERE id=1").run()],
  ['non-prefix live names',()=>db.prepare('DELETE FROM d1_migrations WHERE id=1').run()],
  ['empty live history',()=>db.prepare('DELETE FROM d1_migrations').run()],
  ['missing live history',()=>db.prepare('DROP TABLE d1_migrations').run()],
  ['tracked missing hashes',()=>db.batch([db.prepare('ALTER TABLE d1_migrations ADD COLUMN sha256 TEXT'),db.prepare("ALTER TABLE d1_migrations ADD COLUMN state TEXT DEFAULT 'applied'")])],
 ]) {
  await nativeRestore();await prepare();
  const observe=async()=>{const tables=(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' ORDER BY name").all()).results;return canonicalJson(await Promise.all(tables.map(async({name})=>[name,(await db.prepare('SELECT * FROM "'+name+'"').all()).results])));};
  const before=await observe();
  const response=await workerRestore(valid);assert.equal(response.status,409,'native '+name);assert.deepEqual(await response.json(),{error:'schema_mismatch'});
  assert.equal(await observe(),before,'native '+name+' preserves every table and row');
 }
 await nativeRestore();
 const nativeService=await createPortability({db,policy,migrations:()=>workerMigrations(db,policy,evidence)});
 await assert.rejects((async()=>{const s=await createPortability({db,policy,migrationRoot:directory});const id=await s.imports.create(valid.manifest);await s.imports.uploadPart(id,0,valid.part);await s.imports.finalize(id,valid.closing);})(),e=>e.code==='schema_mismatch:legacy_evidence','automatic Node history remains hash-only');
 assert.equal((await workerRestore(valid)).status,200,'native legacy restore');
 assert.deepEqual((await db.prepare('SELECT * FROM a_children').all()).results,[{id:'child',parent:'parent',state:'retained'}]);
 const current=await bundle(nativeService);
 await nativeRestore();assert.equal((await workerRestore(current)).status,200,'ordinary current-format control');
 assert.deepEqual((await db.prepare('SELECT * FROM a_children').all()).results,[{id:'child',parent:'parent',state:'retained'}]);
 assert.equal(canonicalJson((await db.prepare('SELECT rowid,* FROM d1_migrations ORDER BY id').all()).results),nativeLedger,'native ledger bytes preserved');
 assert.deepEqual((await db.prepare('SELECT * FROM oa_operators').all()).results,[{id:'destination-owner'}],'installation authority never copied');
 assert.equal((await db.prepare('SELECT value FROM settings').first()).value,'destination-only');
 await restore();
 const migrations=()=>workerMigrations(db,policy,evidence);
 assert.equal((await migrationSeeded(db,['settings'],migrations)).length,1);
 await db.prepare("UPDATE settings SET value='changed'").run();
 assert.deepEqual(await migrationSeeded(db,['settings'],migrations),[],'seed identity cannot vouch for edited rows');
 await assert.rejects(workerMigrations(db,policy,undefined),e=>e.code==='schema_mismatch:legacy_evidence');
 t.diagnostic('library and built Worker restore the same rows; eleven negative variants preserve hashed and native destination state; native live-history refusals, ledger bytes, authority and current-format control checked; seeded hashes reject edits; absent evidence fails closed');
});
