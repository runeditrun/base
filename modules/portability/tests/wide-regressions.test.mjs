import { test } from 'node:test';
import assert from 'node:assert/strict';
import { database,bundle,stage,rows } from './regression-helpers.mjs';

for(const width of [98,99,100])test(width+'-column D1 tables export, restore and export within D1 limits',async t=>{
  const ddl=['CREATE TABLE wide(id INTEGER PRIMARY KEY,'+Array.from({length:width-1},(_,i)=>'c'+i+' TEXT').join(',')+')'];
  const policy={product:'fixture',partBytes:16384},source=await database(t,ddl,policy),target=await database(t,ddl,policy);
  const values=[1,...Array.from({length:width-1},(_,i)=>'value '+i)];
  await source.db.prepare('INSERT INTO wide VALUES('+values.map(()=>'?').join(',')+')').bind(...values).run();
  const before=await bundle(source.service);assert.equal(before.manifest.tables[0].columns.length,width);
  const id=await stage(target.service,before);await target.service.imports.finalize(id,{contentHash:before.closing.contentHash,archiveHash:before.closing.archiveHash});
  const after=await bundle(target.service);assert.deepEqual(rows(after),rows(before));
  assert.equal(after.closing.contentHash,before.closing.contentHash);
  assert.deepEqual((await target.db.prepare('SELECT * FROM wide').all()).results,(await source.db.prepare('SELECT * FROM wide').all()).results);
});

test('a 100-column keyless table retains negative rowids and gaps through restore',async t=>{
  const ddl=['CREATE TABLE wide('+Array.from({length:100},(_,i)=>'c'+i+' TEXT').join(',')+')'],policy={product:'fixture',partBytes:16384};
  const source=await database(t,ddl,policy),target=await database(t,ddl,policy);
  for(const rowid of [-7,2,19])await source.db.prepare('INSERT INTO wide(rowid,c0,c99) VALUES(?,?,?)').bind(rowid,'row '+rowid,'last').run();
  const before=await bundle(source.service),id=await stage(target.service,before);
  await target.service.imports.finalize(id,{contentHash:before.closing.contentHash,archiveHash:before.closing.archiveHash});
  const after=await bundle(target.service);assert.deepEqual(rows(after),rows(before));
  assert.deepEqual((await target.db.prepare('SELECT rowid FROM wide ORDER BY rowid').all()).results,[{rowid:-7},{rowid:2},{rowid:19}]);
  assert.equal(after.closing.contentHash,before.closing.contentHash);
});

test('normalizing every cell of a 100-column table stays within the binding limit',async t=>{
  const ddl=['CREATE TABLE wide(id TEXT PRIMARY KEY,'+Array.from({length:99},(_,i)=>'c'+i+' TEXT').join(',')+')'];
  const policy={product:'fixture',partBytes:16384,exportRow(table,row){for(const key of Object.keys(row))row[key]=row[key].toLowerCase();return row;}};
  const source=await database(t,ddl,policy),target=await database(t,ddl,policy);
  for(const id of ['Z','a'])await source.db.prepare('INSERT INTO wide VALUES('+Array(100).fill('?').join(',')+')').bind(id,...Array(99).fill('VALUE')).run();
  const before=await bundle(source.service),id=await stage(target.service,before);
  await target.service.imports.finalize(id,{archiveHash:before.closing.archiveHash});const after=await bundle(target.service);
  assert.deepEqual(rows(after),rows(before));assert.equal(after.closing.contentHash,before.closing.contentHash);
  assert.deepEqual(rows(before).map(x=>x.row.id),['a','z']);
});

test('wide tables with long column names stay within the D1 SQL statement limit',async t=>{
  // The former row guard measured 99967 and 100066 statement bytes here.
  for(const length of [334,335,550]) {
  const names=Array.from({length:99},(_,i)=>'c'+i+'_'+'x'.repeat(length));
  const ddl=['CREATE TABLE wide(id INTEGER PRIMARY KEY,'+names.map(name=>'"'+name+'" TEXT').join(',')+')'];
  assert.ok(Buffer.byteLength(ddl[0])<100000);
  const policy={product:'fixture',partBytes:256*1024},source=await database(t,ddl,policy),target=await database(t,ddl,policy);
  await source.db.prepare('INSERT INTO wide VALUES('+Array(100).fill('?').join(',')+')').bind(1,...names.map((_,i)=>'value '+i)).run();
  await source.db.prepare('INSERT INTO wide VALUES('+Array(100).fill('?').join(',')+')').bind(2,...names.map((_,i)=>i%2?null:'é'.repeat(60))).run();
  const before=await bundle(source.service),id=await stage(target.service,before);
  await target.service.imports.finalize(id,{archiveHash:before.closing.archiveHash});const after=await bundle(target.service);
  assert.deepEqual(rows(after),rows(before));assert.equal(after.closing.contentHash,before.closing.contentHash);
  t.diagnostic('Long-name export and restore PASS at '+length+' padding characters');
  }
});

test('an encoded projection beyond D1 SQL limits refuses export up front by table name',async t=>{
  const names=Array.from({length:99},(_,i)=>'c'+i+'_'+'x'.repeat(550));
  const ddl=['CREATE TABLE wide(id INTEGER PRIMARY KEY,'+names.map(name=>'"'+name+'" INTEGER').join(',')+')'];
  assert.ok(Buffer.byteLength(ddl[0])<100000);
  await assert.rejects(database(t,ddl,{product:'fixture'}),/transfer_sql_limit:wide/);
});
