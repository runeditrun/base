import { runCases } from './cases.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { database,bundle,stage } from './regression-helpers.mjs';
import { createPortability } from '../index.mjs';

test("restore replacement preserves every excluded foreign-key dependent", async t => {
  const foldedCases = [];
for(const action of ['CASCADE','SET NULL','SET DEFAULT'])foldedCases.push(['replacement refuses excluded destination dependents with '+action, async t=>{
  const ddl=['CREATE TABLE tenants(id TEXT PRIMARY KEY,name TEXT)',
    `CREATE TABLE oa_sessions(id TEXT PRIMARY KEY,tenant TEXT REFERENCES tenants(id) ON DELETE ${action})`];
  const policy={product:'fixture',replaceableTables:['tenants']};
  const source=await database(t,ddl,policy),target=await database(t,ddl,policy);
  await source.db.prepare("INSERT INTO tenants VALUES('t','restored')").run();
  await target.db.prepare("INSERT INTO tenants VALUES('t','bootstrap')").run();
  await target.db.prepare("INSERT INTO oa_sessions VALUES('destination-session','t')").run();
  const archive=await bundle(source.service),id=await stage(target.service,archive);
  await assert.rejects(target.service.imports.finalize(id,{archiveHash:archive.closing.archiveHash}),/excluded_destination_dependents:oa_sessions:tenants/);
  assert.deepEqual((await target.db.prepare('SELECT * FROM oa_sessions').all()).results,[{id:'destination-session',tenant:'t'}]);
  assert.equal((await target.db.prepare('SELECT name FROM tenants').first()).name,'bootstrap');
  assert.equal((await target.service.imports.status(id)).phase,'staging');
}]);
foldedCases.push(['excluded dependents added during staged validation are protected by the commit guard', async t=>{
  const ddl=['CREATE TABLE tenants(id TEXT PRIMARY KEY,name TEXT)',
    'CREATE TABLE oa_sessions(id TEXT PRIMARY KEY,tenant TEXT REFERENCES tenants(id) ON DELETE CASCADE)'];
  const policy={product:'fixture',replaceableTables:['tenants']},source=await database(t,ddl,policy),target=await database(t,ddl,policy);
  await source.db.prepare("INSERT INTO tenants VALUES('t','restored')").run();
  await target.db.prepare("INSERT INTO tenants VALUES('t','bootstrap')").run();
  const service=await createPortability({db:target.db,policy:{...policy,validateStaged:async()=>{
    await target.db.prepare("INSERT INTO oa_sessions VALUES('late-session','t')").run();return true;
  }}});
  const archive=await bundle(source.service),id=await stage(service,archive);
  await assert.rejects(service.imports.finalize(id,{archiveHash:archive.closing.archiveHash}),/CHECK constraint/);
  assert.deepEqual((await target.db.prepare('SELECT * FROM oa_sessions').all()).results,[{id:'late-session',tenant:'t'}]);
  assert.equal((await target.db.prepare('SELECT name FROM tenants').first()).name,'bootstrap');
  assert.equal((await service.imports.status(id)).phase,'staging');
}]);
foldedCases.push(['replacement still succeeds when excluded FK dependents are empty', async t=>{
  const ddl=['CREATE TABLE tenants(id TEXT PRIMARY KEY,name TEXT)',
    'CREATE TABLE oa_sessions(id TEXT PRIMARY KEY,tenant TEXT REFERENCES tenants(id) ON DELETE CASCADE)'];
  const policy={product:'fixture',replaceableTables:['tenants']},source=await database(t,ddl,policy),target=await database(t,ddl,policy);
  await source.db.prepare("INSERT INTO tenants VALUES('t','restored')").run();await target.db.prepare("INSERT INTO tenants VALUES('t','bootstrap')").run();
  const archive=await bundle(source.service),id=await stage(target.service,archive);
  assert.equal((await target.service.imports.finalize(id,{archiveHash:archive.closing.archiveHash})).phase,'complete');
  assert.equal((await target.db.prepare('SELECT name FROM tenants').first()).name,'restored');
}]);
foldedCases.push(['transitive cascades cannot remove excluded auth rows through replaceable children', async t=>{
  const ddl=['CREATE TABLE tenants(id TEXT PRIMARY KEY)',
    'CREATE TABLE links(id TEXT PRIMARY KEY,tenant TEXT REFERENCES tenants(id) ON DELETE CASCADE)',
    'CREATE TABLE oa_sessions(id TEXT PRIMARY KEY,link TEXT REFERENCES links(id) ON DELETE CASCADE)'];
  const policy={product:'fixture',replaceableTables:['tenants','links']},source=await database(t,ddl,policy),target=await database(t,ddl,policy);
  for(const f of [source,target])await f.db.batch(["INSERT INTO tenants VALUES('t')","INSERT INTO links VALUES('l','t')"].map(sql=>f.db.prepare(sql)));
  await target.db.prepare("INSERT INTO oa_sessions VALUES('session','l')").run();
  const archive=await bundle(source.service),id=await stage(target.service,archive);
  await assert.rejects(target.service.imports.finalize(id,{archiveHash:archive.closing.archiveHash}),/excluded_destination_dependents:oa_sessions:links/);
  assert.deepEqual((await target.db.prepare('SELECT * FROM oa_sessions').all()).results,[{id:'session',link:'l'}]);
}]);
foldedCases.push(['compatible NO ACTION auth dependents survive replacing their parent', async t=>{
  const ddl=['CREATE TABLE tenants(id TEXT PRIMARY KEY,name TEXT)',
    'CREATE TABLE oa_sessions(id TEXT PRIMARY KEY,tenant TEXT REFERENCES tenants(id) ON DELETE NO ACTION)'];
  const policy={product:'fixture',replaceableTables:['tenants']},source=await database(t,ddl,policy),target=await database(t,ddl,policy);
  await source.db.prepare("INSERT INTO tenants VALUES('t','restored')").run();await target.db.prepare("INSERT INTO tenants VALUES('t','bootstrap')").run();
  await target.db.prepare("INSERT INTO oa_sessions VALUES('session','t')").run();
  const archive=await bundle(source.service),id=await stage(target.service,archive);
  assert.equal((await target.service.imports.finalize(id,{archiveHash:archive.closing.archiveHash})).phase,'complete');
  assert.deepEqual((await target.db.prepare('SELECT * FROM oa_sessions').all()).results,[{id:'session',tenant:'t'}]);
  assert.equal((await target.db.prepare('SELECT name FROM tenants').first()).name,'restored');
}]);
  await runCases(t, foldedCases);
});
