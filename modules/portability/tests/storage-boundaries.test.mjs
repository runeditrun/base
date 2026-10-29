import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPortability } from '../index.mjs';
import { runtime,archive,restore } from './helpers.mjs';
import { fixturePolicy } from './fixture-policy.mjs';

function utf8Database(db) {
  const originals=new WeakMap(),encoder=new TextEncoder(),decoder=new TextDecoder();
  return {prepare(sql){const s=db.prepare(sql),wrapped={
    bind(...values){for(const value of values)if(typeof value==='string')assert.ok(decoder.decode(encoder.encode(value))===value,'D1 text bindings must preserve UTF-8');return s.bind(...values);},
    all:(...args)=>s.all(...args),first:(...args)=>s.first(...args),run:(...args)=>s.run(...args),
  };originals.set(wrapped,s);return wrapped;},batch:statements=>db.batch(statements.map(s=>originals.get(s)??s))};
}
test('large Unicode values survive durable segment boundaries and a full round trip',async t=>{
  const policy={...fixturePolicy,partBytes:1024*1024};
  for(const padding of [0,1]) {
    const source=await runtime(t,{policy}),target=await runtime(t,{policy}),value='x'.repeat(padding)+'😀'.repeat(40000);
    await source.db.prepare('INSERT INTO heap VALUES(?)').bind(value).run();
    const service=await createPortability({db:utf8Database(source.db),buckets:{FILES:source.bucket},policy}),first=await archive(service);
    const destination=await target.connect();await restore(destination,first);
    assert.ok((await target.db.prepare('SELECT value FROM heap').first()).value===value);
    assert.equal((await archive(destination)).contentHash,first.contentHash);
  }
});
test('default exclusions cover SQLite identifier case variants',async t=>{
  const source=await runtime(t),names=['OA_TRANSFER_TEST','OC_OWNER_CLAIMS','RER_PORTABILITY_TRANSFER_TEST','RER_MAIL_DEVELOPMENT_OUTBOX'];
  for(const name of names)await source.db.prepare('CREATE TABLE "'+name+'"(id TEXT)').run();
  const bundle=await archive(await source.connect());
  for(const name of names)assert.ok(bundle.manifest.excludedTables.includes(name),'default exclusion must cover '+name);
});
test('foreign keys into excluded parents are refused through SQLite case aliases',async t=>{
  const source=await runtime(t,{policy:{...fixturePolicy,excludeTables:[...fixturePolicy.excludeTables,'ParentTable']}});
  await source.db.prepare('CREATE TABLE "ParentTable"(id TEXT PRIMARY KEY)').run();
  await source.db.prepare('CREATE TABLE mixed_child(id TEXT PRIMARY KEY,parent TEXT REFERENCES parenttable(id))').run();
  await assert.rejects(source.connect(),/excluded_foreign_key:mixed_child:ParentTable/);
});
