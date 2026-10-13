import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson } from '../index.mjs';
import { database,bundle,stage,rows } from './regression-helpers.mjs';

test('normalized attachment keys must resolve before an export completes',async t=>{
  const policy={product:'fixture',buckets:{FILES:{objectReferences:{table:'files',keyColumn:'key'}}},
    exportRow(table,row){if(table==='files')row.key=row.key.toLowerCase();return row;}};
  const source=await database(t,['CREATE TABLE files(key TEXT PRIMARY KEY)'],policy);
  await source.db.prepare("INSERT INTO files VALUES('UPPER')").run();await source.bucket.put('UPPER',Uint8Array.of(1));
  await assert.rejects(bundle(source.service),/object_references:FILES/);
  assert.equal((await source.db.prepare('SELECT key FROM files').first()).key,'UPPER');
});

test('idempotent primary-key normalization preserves canonical row bytes and contentHash',async t=>{
  const ddl=['CREATE TABLE mapped(id TEXT PRIMARY KEY,value TEXT)'],policy={product:'fixture',partBytes:1024,
    exportRow(table,row){row.id=row.id.toLowerCase();return row;}};
  const source=await database(t,ddl,policy),target=await database(t,ddl,policy);
  await source.db.prepare("INSERT INTO mapped VALUES('Z','first'),('a','second')").run();
  const before=await bundle(source.service),id=await stage(target.service,before);
  await target.service.imports.finalize(id,{contentHash:before.closing.contentHash,archiveHash:before.closing.archiveHash});
  const after=await bundle(target.service);
  assert.equal(after.closing.contentHash,before.closing.contentHash);
  assert.equal(canonicalJson(rows(after)),canonicalJson(rows(before)));
  assert.deepEqual(rows(before).map(i=>i.row.id),['a','z']);
});

test('attachment reference columns cannot be omitted as secrets',async t=>{
  await assert.rejects(database(t,['CREATE TABLE files(id TEXT PRIMARY KEY,key TEXT)'],{
    product:'fixture',secretColumns:{files:['key']},buckets:{FILES:{objectReferences:{table:'files',keyColumn:'key'}}},
  }),/reference_column_excluded/);
});
