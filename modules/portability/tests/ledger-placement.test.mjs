import { runCases } from './cases.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { database, bundle } from './regression-helpers.mjs';
import { createPortability, canonicalJson, sha256 } from '../index.mjs';
import { importArchive } from '../files.mjs';
import { makePart, ContentVerifier, ArchiveVerifier } from '../format.mjs';
import { migrationReplay } from '../migration-history.mjs';

// A destination installed by RER Platform: its runner applies files in plan
// order and records each in rer_migrations. 1270 is a new core file that the
// plan orders before older ones, and 1280 updates a table the archive holds no
// rows of, as in a seed whose retained archive predates both.
const policy={product:'platform-ledger'};
const plan=[
  ['0001_items.sql','CREATE TABLE items(id TEXT PRIMARY KEY,value TEXT)'],
  ['1270_roles.sql','CREATE TABLE roles(id TEXT PRIMARY KEY,role TEXT)'],
  ['0900_jobs.sql','CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,state TEXT)'],
  ['0950_policies.sql','CREATE TABLE policies(id TEXT PRIMARY KEY,rule TEXT)'],
  ['1280_policy_rules.sql',"UPDATE policies SET rule='comment-deletion' WHERE rule='launch'"],
].map(([name,sql])=>({name,sql,sha256:createHash('sha256').update(sql).digest('hex')}));
const archived=['0001_items.sql','0900_jobs.sql','0950_policies.sql'];
const platformLedger='CREATE TABLE rer_migrations (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)';
const nativeLedger='CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)';
const replay=files=>async()=>migrationReplay(files.map(({name,sql,sha256,aliases})=>({name,statements:[sql],sha256,aliases})),policy);

async function platformDestination(t,{native=false,prefix='',files=plan}={}) {
  const target=await database(t,[native?nativeLedger:platformLedger],policy);
  for(const m of files)await target.db.batch([target.db.prepare(m.sql),native?target.db.prepare('INSERT INTO d1_migrations(name) VALUES(?)').bind(m.name):target.db.prepare('INSERT INTO rer_migrations(name,sha256) VALUES(?,?)').bind(prefix+m.name,m.sha256)]);
  return {...target,service:await createPortability({db:target.db,buckets:{FILES:target.bucket},policy,migrations:replay(files)})};
}
const ledgerRows=async db=>(await db.prepare('SELECT rowid,* FROM rer_migrations ORDER BY rowid').all()).results;

// An archive from before rer_migrations became bookkeeping: the source's own
// ledger travels as a table, and the manifest records no migrations.
async function retainedArchive(t,{policies=[],ledger=archived.map(name=>plan.find(m=>m.name===name)),native=false,prefix=''}={}) {
  const source=await database(t,plan.filter(m=>archived.includes(m.name)).map(m=>m.sql),policy);
  await source.db.prepare("INSERT INTO items VALUES('item-1','Asha Chen')").run();
  await source.db.prepare("INSERT INTO jobs VALUES('job-1','queued')").run();
  for(const id of policies)await source.db.prepare("INSERT INTO policies VALUES(?,'launch')").bind(id).run();
  const {manifest,parts}=await bundle(source.service);
  assert.equal(manifest.migrations,undefined);
  const table={name:native?'d1_migrations':'rer_migrations',sql:native?nativeLedger:platformLedger,columns:native?[{name:'id',type:'INTEGER',notnull:0,pk:1},{name:'name',type:'TEXT',notnull:0,pk:0},{name:'applied_at',type:'TEXT',notnull:1,pk:0}]:[{name:'name',type:'TEXT',notnull:0,pk:1},{name:'sha256',type:'TEXT',notnull:1,pk:0},{name:'applied_at',type:'TEXT',notnull:1,pk:0}],dependencies:[],count:ledger.length,rowidAlias:null};
  const tables=[...manifest.tables,table].sort((a,b)=>a.name<b.name?-1:1);
  const old={...manifest,tables,schema:await sha256(canonicalJson(tables.map(({name,sql})=>({name,sql}))))};
  const rows=[...parts.flatMap(p=>p.items),...ledger.map((m,index)=>({kind:'row',table:table.name,index,row:{name:prefix+m.name,...(native?{id:index+1}:{sha256:m.sha256}),applied_at:'2026-10-01 09:00:00'}}))];
  rows.sort((a,b)=>tables.findIndex(x=>x.name===a.table)-tables.findIndex(x=>x.name===b.table) || a.index-b.index);
  const part=await makePart(0,rows);old.partCount=1;
  const content=new ContentVerifier(old),integrity=new ArchiveVerifier(old);
  for(const item of part.items)content.add(item);integrity.add(part);
  const closing={kind:'closing',partCount:1,contentHash:content.digest(),archiveHash:integrity.digest()};
  const directory=await mkdtemp(join(tmpdir(),'ledger-archive-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const path=join(directory,'retained.rer');
  await writeFile(path,[old,part,closing].map(canonicalJson).join('\n')+'\n');
  return {path,source};
}
const all=async(db,sql)=>(await db.prepare(sql).all()).results;

test("restore locates archived migration history and refuses ambiguous or conflicting evidence", async t => {
  const foldedCases = [];
foldedCases.push(['an old archive carrying its Platform ledger restores into a Platform-installed destination whose history orders a new migration mid-way', async t=>{
  const target=await platformDestination(t),before=await ledgerRows(target.db);
  const {path,source}=await retainedArchive(t);
  const receipt=await importArchive(target.service,path,[]);
  assert.deepEqual(receipt.bridged.migrations,['1270_roles.sql','1280_policy_rules.sql']);
  assert.deepEqual(receipt.bridged.tables,['roles']);
  assert.deepEqual(receipt.skippedTables,['rer_migrations']);
  for(const table of ['items','jobs','policies'])assert.deepEqual(await all(target.db,`SELECT * FROM ${table} ORDER BY id`),await all(source.db,`SELECT * FROM ${table} ORDER BY id`));
  assert.deepEqual(await all(target.db,'SELECT * FROM roles'),[]);
  assert.deepEqual(await ledgerRows(target.db),before);
}]);
foldedCases.push(['an archived ledger whose hash differs from the applied migration refuses, naming it, and leaves the destination untouched', async t=>{
  const target=await platformDestination(t),before=await ledgerRows(target.db);
  const ledger=archived.map(name=>plan.find(m=>m.name===name)).map(m=>m.name==='0900_jobs.sql'?{...m,sha256:createHash('sha256').update(m.sql+'\n-- edited').digest('hex')}:m);
  const {path}=await retainedArchive(t,{ledger});
  await assert.rejects(importArchive(target.service,path,[]),error=>error.code==='migration_ledger:unknown:0900_jobs.sql');
  assert.deepEqual(await all(target.db,'SELECT * FROM items'),[]);
  assert.deepEqual(await all(target.db,'SELECT id FROM rer_portability_jobs'),[]);
  assert.deepEqual(await ledgerRows(target.db),before);
}]);
foldedCases.push(['a later UPDATE refuses when the archive holds rows of its table', async t=>{
  const target=await platformDestination(t),before=await ledgerRows(target.db);
  const {path}=await retainedArchive(t,{policies:['policy-1']});
  await assert.rejects(importArchive(target.service,path,[]),error=>error.code==='schema_mismatch:migration_data:1280_policy_rules.sql');
  assert.deepEqual(await all(target.db,'SELECT * FROM policies'),[]);
  assert.deepEqual(await ledgerRows(target.db),before);
}]);
foldedCases.push(['Platform-prefixed and native ledgers place the same files in either direction, including native to native', async t=>{
  for(const sourceNative of [false,true])for(const targetNative of [false,true])await runCases(t, [[`${sourceNative?'native':'Platform'} to ${targetNative?'native':'Platform'}`, async t=>{
    const target=await platformDestination(t,{native:targetNative,prefix:targetNative?'':'core-'});
    const ledgerTable=targetNative?'d1_migrations':'rer_migrations';
    const before=await all(target.db,`SELECT * FROM ${ledgerTable} ORDER BY rowid`);
    const {path,source}=await retainedArchive(t,{native:sourceNative,prefix:sourceNative?'':'core-'});
    const receipt=await importArchive(target.service,path,[]);
    assert.deepEqual(receipt.bridged.migrations,['1270_roles.sql','1280_policy_rules.sql']);
    for(const table of ['items','jobs','policies'])assert.deepEqual(await all(target.db,`SELECT * FROM ${table} ORDER BY id`),await all(source.db,`SELECT * FROM ${table} ORDER BY id`));
    assert.deepEqual(await all(target.db,`SELECT * FROM ${ledgerTable} ORDER BY rowid`),before);
  }]]);
}]);
foldedCases.push(['ambiguous file hashes, conflicting names and the first unknown hashless entry refuse without staging rows', async t=>{
  for(const kind of ['ambiguous','conflict','unknown'])await runCases(t, [[kind, async t=>{
    const jobs=plan.find(m=>m.name==='0900_jobs.sql');
    const files=kind==='ambiguous'?[...plan,{...jobs,name:'1290_jobs_copy.sql'}]:plan;
    const target=await platformDestination(t,{native:true,files});
    const ledger=archived.map(name=>plan.find(m=>m.name===name)).map(m=>m===jobs?{...m,name:kind==='conflict'?'1270_roles.sql':kind==='unknown'?'missing-first.sql':m.name}:m);
    if(kind==='unknown')ledger.push({...jobs,name:'missing-second.sql'});
    const {path}=await retainedArchive(t,{ledger,native:kind==='unknown'});
    const name=kind==='conflict'?'1270_roles.sql':kind==='unknown'?'missing-first.sql':jobs.name;
    await assert.rejects(importArchive(target.service,path,[]),error=>error.code===`migration_ledger:${kind}:${name}`);
    assert.deepEqual(await all(target.db,'SELECT * FROM items'),[]);
    assert.deepEqual(await all(target.db,'SELECT id FROM rer_portability_jobs'),[]);
  }]]);
}]);
foldedCases.push(['name-only archives use declared deployment names and refuse an ambiguous alias before staging', async t=>{
  for(const ambiguous of [false,true])await runCases(t, [[ambiguous?'ambiguous':'declared', async t=>{
    const files=plan.map(m=>({...m,aliases:['delivered-'+m.name]}));
    if(ambiguous)files[1].aliases.push('delivered-'+files[0].name);
    const target=await platformDestination(t,{native:true,files});
    const {path,source}=await retainedArchive(t,{native:true,prefix:'delivered-'});
    if(ambiguous) {
      await assert.rejects(importArchive(target.service,path,[]),error=>error.code==='migration_ledger:ambiguous:delivered-0001_items.sql');
      assert.deepEqual(await all(target.db,'SELECT id FROM rer_portability_jobs'),[]);
    } else {
      await importArchive(target.service,path,[]);
      assert.deepEqual(await all(target.db,'SELECT * FROM items'),await all(source.db,'SELECT * FROM items'));
    }
  }]]);
}]);
  await runCases(t, foldedCases);
});
