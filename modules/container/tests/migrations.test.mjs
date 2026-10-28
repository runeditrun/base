import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from '../adapters/d1-workerd.mjs';
import { ensurePortabilitySchema } from '../portability-schema.mjs';
import { migrate } from '../migrations.mjs';
const plan = (name, statements) => ({name,statements,sql:statements.join(';'),sha256:createHash('sha256').update(statements.join(';')).digest('hex')});
test('migration claims survive failed application and forbid changed or uncertain replay',async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response()}}',d1Databases:['DB']}));
 try {
  const db=await mf.getD1Database('DB'),first=plan('0001_app.sql',['CREATE TABLE notes(id INTEGER PRIMARY KEY, value TEXT)']);
  await migrate(db,[first]);await db.prepare("INSERT INTO notes VALUES(1,'retained')").run();
  const second=plan('0002_app.sql',['ALTER TABLE notes ADD COLUMN updated INTEGER']);await migrate(db,[first,second]);
  assert.equal((await db.prepare('SELECT value FROM notes').first()).value,'retained');
  await assert.rejects(migrate(db,[plan(first.name,['CREATE TABLE changed(id INTEGER)']),second]),/changed-or-uncertain/);
  const failed=plan('0003_app.sql',['CREATE TABLE rolled_back(id INTEGER)','INSERT INTO missing_table VALUES(1)']);
  await assert.rejects(migrate(db,[first,second,failed]));
  assert.equal(await db.prepare("SELECT name FROM sqlite_master WHERE name='rolled_back'").first(),null);
  await assert.rejects(migrate(db,[first,second,failed]),/changed-or-uncertain/);
  const metadata=plan('0001_portability.sql',['CREATE TABLE rer_portability_state(id INTEGER)']);await migrate(db,[metadata],{ledger:'_rer_portability_migrations'});await db.prepare("UPDATE _rer_portability_migrations SET state='applying'").run();await assert.rejects(ensurePortabilitySchema(db,[metadata]),/changed-or-uncertain/);
 }finally{await mf.dispose();}
});
