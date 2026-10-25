import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildPackage } from '../scripts/rer-package.mjs';

const execute=promisify(execFile),base=resolve(import.meta.dirname,'..');
const require=createRequire(join(base,'default-seed/package.json'));
const {getPlatformProxy}=require('wrangler');
const wrangler=resolve(require.resolve('wrangler/package.json'),'../bin/wrangler.js');
const first='CREATE TABLE workspace_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);';
const second='CREATE TABLE operators (id TEXT PRIMARY KEY, name TEXT NOT NULL);';
const hash=sql=>createHash('sha256').update(sql).digest('hex');
const platformSQL='CREATE TABLE rer_migrations (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)';

test('a packaged adapter guard precedes real native D1 apply and preserves the owning ledger', {timeout:180_000}, async t=>{
 const directory=await mkdtemp(join(tmpdir(),'native-ledger-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 // Resolve the supported package export from the actual tarball, not internals.
 const packaged=join(directory,'node_modules/@runeditrun/rer');
 await mkdir(packaged,{recursive:true});
 await execute('tar',['-xzf',await buildPackage(base,join(directory,'package')),'--strip-components=1','-C',packaged]);
 const consumer=createRequire(join(directory,'package.json'));
 const {nativeMigrationPreflight}=await import(pathToFileURL(consumer.resolve('@runeditrun/rer/portability-migrations')));
 async function fixture(name) {
  const root=join(directory,name);
  await mkdir(join(root,'migrations'),{recursive:true});
  await writeFile(join(root,'wrangler.jsonc'),JSON.stringify({name:'ledger-journey',compatibility_date:'2026-09-01',d1_databases:[{binding:'DB',database_name:'ledger-journey',database_id:'00000000-0000-0000-0000-000000000001',migrations_dir:'migrations'}]}));
  await writeFile(join(root,'migrations/0001_settings.sql'),first);
  const open=()=>getPlatformProxy({configPath:join(root,'wrangler.jsonc'),persist:{path:join(root,'.wrangler/state/v3')},remoteBindings:false});
  const inspect=async action=>{const proxy=await open();try{return await action(proxy.env.DB);}finally{await proxy.dispose();}};
  const guard=options=>inspect(db=>nativeMigrationPreflight({root,db,...options}));
  const native=()=>execute(process.execPath,[wrangler,'d1','migrations','apply','ledger-journey','--local','--persist-to','.wrangler/state','--config','wrangler.jsonc'],{cwd:root,env:{PATH:process.env.PATH,HOME:directory,CI:'true',WRANGLER_SEND_METRICS:'false'},timeout:30_000});
  const platform=()=>inspect(db=>db.batch([db.prepare(first),db.prepare(platformSQL),db.prepare('INSERT INTO rer_migrations(name,sha256) VALUES(?,?)').bind('delivered-0001_settings.sql',hash(first))]));
  const snapshot=()=>inspect(async db=>({catalogue:(await db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all()).results,ledger:(await db.prepare('SELECT rowid,* FROM rer_migrations ORDER BY rowid').all()).results,rows:(await db.prepare('SELECT * FROM workspace_settings ORDER BY key').all()).results}));
  return {root,inspect,guard,native,platform,snapshot};
 }
 const unsafe=await fixture('unguarded');
 await unsafe.platform();
 await assert.rejects(unsafe.native(),error=>error.code===1 && /table workspace_settings already exists/.test(error.stdout+error.stderr));
 t.diagnostic('unguarded Wrangler apply reproduced duplicate workspace_settings, exit 1');

 const target=await fixture('guarded');
 await target.platform();
 await target.inspect(db=>db.prepare("INSERT INTO workspace_settings VALUES('office_hours','Mon–Fri 09:00–17:00')").run());
 const original=await target.snapshot();
 const apply=async()=>{const result=await target.guard();if(result.nativeApply)await target.native();return result;};
 assert.deepEqual(await apply(),{nativeApply:false});
 assert.deepEqual(await target.snapshot(),original,'guarded apply leaves product data, schema SQL, row order and ledger bytes intact');
 t.diagnostic('supported package entry skipped native apply; Platform history and product data preserved');

 // Every refusal is before native apply and leaves the real database untouched.
 async function refused(code) {
  const before=await target.snapshot();
  await assert.rejects(apply(),error=>error.code===code && error.status===409);
  assert.deepEqual(await target.snapshot(),before);
 }
 await writeFile(join(target.root,'migrations/0002_operators.sql'),second);
 await refused('migration_ledger:unapplied');
 await rm(join(target.root,'migrations/0002_operators.sql'));
 await writeFile(join(target.root,'migrations/0002_duplicate.sql'),first);
 await refused('migration_ledger:ambiguous');
 await rm(join(target.root,'migrations/0002_duplicate.sql'));
 await target.inspect(db=>db.prepare('UPDATE rer_migrations SET sha256=?').bind(hash(second)).run());
 await refused('migration_ledger:unknown');
 await target.inspect(db=>db.prepare('UPDATE rer_migrations SET sha256=?').bind(hash(first)).run());
 await target.inspect(db=>db.prepare('INSERT INTO rer_migrations(name,sha256) VALUES(?,?)').bind('same-file.sql',hash(first)).run());
 await refused('migration_ledger:ambiguous');
 await target.inspect(db=>db.prepare("DELETE FROM rer_migrations WHERE name='same-file.sql'").run());
 await writeFile(join(target.root,'migrations/delivered-0001_settings.sql'),second);
 await refused('migration_ledger:conflict');
 await rm(join(target.root,'migrations/delivered-0001_settings.sql'));
 await target.inspect(db=>db.prepare("UPDATE rer_migrations SET name=name || '#1-2'").run());
 await refused('migration_ledger:uncertain');
 await target.inspect(db=>db.prepare("UPDATE rer_migrations SET name='delivered-0001_settings.sql',sha256='invalid'").run());
 await refused('migration_ledger:incompatible');
 await target.inspect(db=>db.prepare('UPDATE rer_migrations SET sha256=?').bind(hash(first)).run());
 for(const table of ['d1_migrations','_rer_deploy_migrations']) {
  await target.inspect(db=>db.prepare(`CREATE TABLE ${table}(name TEXT)`).run());
  await refused('migration_ledger:multiple');
  await target.inspect(db=>db.prepare(`DROP TABLE ${table}`).run());
 }
 await target.inspect(db=>db.prepare('ALTER TABLE rer_migrations ADD COLUMN extra TEXT').run());
 await refused('migration_ledger:incompatible');
 t.diagnostic('pending, ambiguous, unknown, conflicting, partial, invalid and both mixed histories refused without database changes');

 const fresh=await fixture('native');
 assert.deepEqual(await fresh.guard(),{nativeApply:true});
 await fresh.native();
 await writeFile(join(fresh.root,'migrations/0002_operators.sql'),second);
 assert.deepEqual(await fresh.guard(),{nativeApply:true},'ordinary Wrangler pending files remain eligible');
 await fresh.native();
 assert.deepEqual(await fresh.inspect(async db=>(await db.prepare('SELECT name FROM d1_migrations ORDER BY id').all()).results),[{name:'0001_settings.sql'},{name:'0002_operators.sql'}]);
 await fresh.inspect(db=>db.batch([db.prepare('ALTER TABLE d1_migrations ADD COLUMN sha256 TEXT'),db.prepare('ALTER TABLE d1_migrations ADD COLUMN state TEXT'),db.prepare("UPDATE d1_migrations SET state='applying'")]));
 await assert.rejects(fresh.guard(),error=>error.code==='migration_ledger:uncertain');
 await fresh.inspect(db=>db.prepare("UPDATE d1_migrations SET state='applied'").run());
 await assert.rejects(fresh.guard(),error=>error.code==='migration_ledger:incompatible');
 t.diagnostic('fresh native setup and subsequent pending native migration both applied; uncertain tracked history refused');
 const legacy=await fixture('legacy');
 await legacy.inspect(db=>db.prepare('CREATE TABLE _rer_deploy_migrations(name TEXT,sha256 TEXT,state TEXT)').run());
 await assert.rejects(legacy.guard(),error=>error.code==='migration_ledger:runner');
});
