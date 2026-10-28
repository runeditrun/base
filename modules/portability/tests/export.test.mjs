import { runCases } from './cases.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPortability,readArchive,excludedTable } from '../index.mjs';
import { migrate } from '../../container/migrations.mjs';
import { runtime,seed,archive,collect,rows } from './helpers.mjs';
import { fixturePolicy } from './fixture-policy.mjs';
test("export snapshot lifecycle preserves consistent data through retries and abort", async t => {
  const foldedCases = [];
foldedCases.push(['snapshot stays consistent while writes land between create and advance', async t=>{
  const f=await runtime(t);await seed(f);const s=await f.connect(),id=await s.exports.create();
  await f.db.batch(["INSERT INTO heap VALUES('late')","INSERT INTO triggered VALUES('late')"].map(sql=>f.db.prepare(sql)));
  let status;do{status=await s.exports.advance(id,{maxParts:100});}while(status.phase==='building');
  const records=await collect(readArchive(await s.exports.download(id))),flat=records.filter(x=>x.kind==='part').flatMap(x=>x.items);
  assert.equal(flat.filter(x=>x.table==='heap').length,3);assert.equal(flat.filter(x=>x.table==='triggered').length,1);assert.equal(flat.filter(x=>x.table==='audit').length,1);
}]);
foldedCases.push(['lost advance acknowledgement cannot duplicate or replay a part', async t=>{
  const f=await runtime(t);await seed(f);const s=await f.connect(),id=await s.exports.create(),first=await s.exports.advance(id,{expectedPart:0});
  const retry=await s.exports.advance(id,{expectedPart:0});assert.deepEqual(retry,first);
  const parts=(await f.db.prepare('SELECT idx FROM rer_portability_parts WHERE job=?').bind(id).all()).results;assert.deepEqual(parts,[{idx:0}]);
}]);
foldedCases.push(['export abort drops every snapshot and part', async t=>{
  const f=await runtime(t);await seed(f);const s=await f.connect(),id=await s.exports.create();await s.exports.advance(id);await s.exports.abort(id);
  assert.equal((await f.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name GLOB 'rer_portability_snap_*'").first()).n,0);
  for(const table of ['parts','segments'])assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM rer_portability_'+table).first()).n,0);
}]);
foldedCases.push(['export is refused while an import applies', async t=>{
  const f=await runtime(t);await f.db.prepare("INSERT INTO rer_portability_state VALUES(1,'identity',0,'import',1)").run();await assert.rejects((await f.connect()).exports.create(),/import_applying/);
}]);
  await runCases(t, foldedCases);
});
test("export refuses changed, missing and unreferenced objects", async t => {
  const foldedCases = [];
await runCases(t, Array.from(['changes','disappears'], (action, rowIndex) => [`${t.name}: action row ${rowIndex + 1}`, async t => {
foldedCases.push(['export fails when an object '+action, async t=>{
  const f=await runtime(t);await seed(f);const s=await f.connect(),id=await s.exports.create();
  if(action==='changes')await f.bucket.put('large',new Uint8Array(18000).fill(7));else await f.bucket.delete('large');
  await assert.rejects(async()=>{for(;;)if((await s.exports.advance(id,{maxParts:100})).phase==='complete')break;},/object_changed/);
}]);
}]));
await runCases(t, Array.from(['missing','unreferenced'], (action, rowIndex) => [`${t.name}: action row ${rowIndex + 1}`, async t => {
foldedCases.push(['object references refuse '+action+' objects', async t=>{
  const f=await runtime(t);await seed(f);if(action==='missing')await f.bucket.delete('small');else await f.bucket.put('other','unreferenced');
  await assert.rejects((await f.connect()).exports.create(),/object_references/);
}]);
}]));
  await runCases(t, foldedCases);
});

test("export inventory admits declared data and refuses unsafe exclusions", async t => {
  const foldedCases = [];
foldedCases.push(['unlisted virtual tables fail by name; listed derived FTS tables are excluded', async t=>{
  const f=await runtime(t,{policy:{product:'fixture'}});await f.db.prepare('CREATE VIRTUAL TABLE search USING fts5(text)').run();
  await assert.rejects(f.connect(),/virtual_table:search/);
  const s=await createPortability({db:f.db,policy:{product:'fixture',derivedTables:['search']}});const a=await archive(s);
  assert.ok(a.manifest.excludedTables.includes('search'));assert.ok(!a.manifest.tables.some(x=>x.name.startsWith('search')));
}]);
foldedCases.push(['foreign keys into excluded tables fail by table name', async t=>{
  const f=await runtime(t);await f.db.prepare('CREATE TABLE dependent(id TEXT,parent TEXT REFERENCES private_notes(id))').run();await assert.rejects(f.connect(),/excluded_foreign_key:dependent:private_notes/);
}]);
foldedCases.push(['invalid policies fail at construction, including NOT NULL secrets', async t=>{
  const f=await runtime(t);await runCases(t, Array.from([{product:''},{product:'x',partBytes:1},{...fixturePolicy,secretColumns:{effects:['delivery']}}], (policy, rowIndex) => [`${t.name}: policy row ${rowIndex + 1}`, async t => {
await assert.rejects(createPortability({db:f.db,buckets:{FILES:f.bucket},policy}),/invalid_/);
}]));
}]);
foldedCases.push(['Base auth, module bookkeeping and development outbox are excluded by default', async t=>{
  const f=await runtime(t);await seed(f);await f.db.prepare('CREATE TABLE rer_mail_development_outbox(message TEXT)').run();await f.db.prepare('CREATE TABLE rer_ai_development_outbox(record TEXT)').run();await f.db.prepare('CREATE TABLE oc_claims(id TEXT)').run();
  const a=await archive(await f.connect());assert.ok(a.manifest.excludedTables.includes('oa_sessions'));assert.ok(a.manifest.excludedTables.includes('oc_claims'));assert.ok(a.manifest.excludedTables.includes('rer_mail_development_outbox'));assert.ok(a.manifest.excludedTables.includes('rer_ai_development_outbox'));assert.ok(!a.manifest.tables.some(t=>t.name==='rer_ai_development_outbox'));
  assert.ok(!a.manifest.tables.some(t=>t.name.startsWith('rer_portability_')));
  const included=await createPortability({db:f.db,buckets:{FILES:f.bucket},policy:{...fixturePolicy,includeTables:['oa_sessions']}});const b=await archive(included);assert.equal(rows(b).find(x=>x.table==='oa_sessions').row.id,'excluded-session');
  // A seed's own table inventory skips exactly what archives skip, including the
  // deploy controller's migration ledger.
  await migrate(f.db,[]);
  await runCases(t, Array.from([fixturePolicy,{...fixturePolicy,includeTables:['oa_sessions']}], (policy, rowIndex) => [`${t.name}: policy row ${rowIndex + 1}`, async t => {
    const c=await archive(await createPortability({db:f.db,buckets:{FILES:f.bucket},policy}));
    assert.ok(c.manifest.excludedTables.includes('_rer_deploy_migrations'));
    assert.ok(c.manifest.excludedTables.every(name=>excludedTable(name,policy)));
    assert.ok(c.manifest.tables.every(({name})=>!excludedTable(name,policy)));
}]));
}]);
  await runCases(t, foldedCases);
});

test("export transformations normalize once and refuse non-idempotent hooks", async t => {
  const foldedCases = [];
foldedCases.push(['normalisation disables tokens and parks sends idempotently', async t=>{
  const f=await runtime(t);await seed(f);const a=await archive(await f.connect()),row=rows(a).find(x=>x.table==='effects').row;
  assert.deepEqual(row,{id:'send',enabled:0,delivery:'review'});assert.deepEqual(fixturePolicy.exportRow('effects',structuredClone(row)),row);
}]);
foldedCases.push(['non-idempotent export transformations are refused', async t=>{
  const f=await runtime(t,{policy:{...fixturePolicy,exportRow(table,row){if(table==='effects')row.enabled++;return row;}}});await seed(f);const s=await f.connect(),id=await s.exports.create();
  await assert.rejects(s.exports.advance(id,{maxParts:100}),/export_row_not_idempotent/);
}]);
  await runCases(t, foldedCases);
});




test('INTEGER affinity export refuses values beyond safe precision',async t=>{
  const f=await runtime(t);await f.db.prepare('INSERT INTO empty_table VALUES(9007199254740993)').run();await assert.rejects(archive(await f.connect()),/unsafe_integer:empty_table:id/);
});
