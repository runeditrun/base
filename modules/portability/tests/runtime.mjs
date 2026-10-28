import { after } from 'node:test';
import { mkdtemp,rm,readFile,readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { Miniflare,convertV4MiniflareOptions } from '../../container/adapters/d1-workerd.mjs';
import { createPortability } from '../index.mjs';
import { fixturePolicy } from './fixture-policy.mjs';
import { captureD1Baseline } from '../../../tests/support/d1-baseline.mjs';
import { runtimeLease } from '../../../tests/support/runtime-lease.mjs';
const root=new URL('../../../',import.meta.url).pathname;
const wrangler=(await readdir(join(root,'node_modules/.pnpm'))).find(x=>x.startsWith('wrangler@4.129.1_'));
const require=createRequire(join(root,'node_modules/.pnpm',wrangler,'node_modules/wrangler/package.json'));
export const { build }=require('esbuild');
const schema=await readFile(new URL('../schema/portability.sql',import.meta.url),'utf8');
export const fixtureSQL=[
  'CREATE TABLE self_ref(id TEXT PRIMARY KEY,parent TEXT REFERENCES self_ref(id))',
  'CREATE TABLE cycle_a(id TEXT PRIMARY KEY,b TEXT REFERENCES cycle_b(id))',
  'CREATE TABLE cycle_b(id TEXT PRIMARY KEY,a TEXT REFERENCES cycle_a(id))',
  'CREATE TABLE compound(a TEXT,b INTEGER,value TEXT,PRIMARY KEY(a,b))',
  'CREATE TABLE heap(value TEXT)',
  'CREATE TABLE empty_table(id INTEGER PRIMARY KEY)',
  'CREATE TABLE files(key TEXT PRIMARY KEY)',
  'CREATE TABLE blobs(id INTEGER PRIMARY KEY,data BLOB)',
  'CREATE TABLE effects(id TEXT PRIMARY KEY,enabled INTEGER NOT NULL,delivery TEXT NOT NULL,credential TEXT)',
  'CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT)',
  'CREATE TABLE audit(message TEXT)',
  'CREATE TABLE triggered(id TEXT PRIMARY KEY)',
  'CREATE TABLE private_notes(id TEXT PRIMARY KEY)',
  'CREATE TABLE oa_sessions(id TEXT PRIMARY KEY)',
  "CREATE TRIGGER triggered_insert AFTER INSERT ON triggered BEGIN INSERT INTO audit VALUES('inserted'); END",
];

async function initializeRuntime({worker,bindings={}}={}) {
  const directory=await mkdtemp(join(tmpdir(),'portability-'));
  let script='export default {fetch(){return new Response("ok")}}';
  let mf,db,bucket;
  const init=()=>new Miniflare({...convertV4MiniflareOptions({cf:false,modules:true,script,compatibilityDate:'2026-09-01',d1Databases:{DB:'portable-db'},r2Buckets:{FILES:'portable-files'},bindings}),resourcePersistencePath:join(directory,'state')});
  try {
    if(worker)script=(await build({entryPoints:[worker],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'})).outputFiles[0].text;
    mf=init();db=await mf.getD1Database('DB');bucket=await mf.getR2Bucket('FILES');
    await db.batch([...schema.split(';').map(s=>s.trim()).filter(Boolean),...fixtureSQL].map(s=>db.prepare(s)));
    const restore=await captureD1Baseline(db);
    const connect=policy=>createPortability({db,buckets:{FILES:bucket},policy});
    return {
      directory,get db(){return db;},get bucket(){return bucket;},get mf(){return mf;},connect,
      async supportsReset() {
        const {results}=await db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL").all();
        // Virtual-table shadow storage cannot be restored with ordinary DELETE
        // and DROP statements. Finish its case, then dispose that real store.
        return !results.some(row=>/^\s*CREATE\s+VIRTUAL\s+TABLE\b/i.test(row.sql));
      },
      async reset() {
        await restore(db);
        // Every visible R2 object belongs to this case, including transfer parts.
        // Delete before taking the next page so no cursor can skip an old key.
        for (;;) {
          const page=await bucket.list({limit:1000});
          if(!page.objects.length)break;
          await bucket.delete(page.objects.map(object=>object.key));
        }
      },
      // Restart cases retain the same durable stores, without reset/migration.
      async reopen(policy){await mf.dispose();mf=init();db=await mf.getD1Database('DB');bucket=await mf.getR2Bucket('FILES');return connect(policy);},
      async reconfigure(changes){bindings={...bindings,...changes};await mf.dispose();mf=init();db=await mf.getD1Database('DB');bucket=await mf.getR2Bucket('FILES');},
      async dispose(){try{await mf.dispose();}finally{await rm(directory,{recursive:true,force:true});}},
    };
  } catch(error) {
    try{await mf?.dispose();}finally{await rm(directory,{recursive:true,force:true});}
    throw error;
  }
}

const acquire=runtimeLease(),cases=new WeakMap(),pool=[];
after(async()=>{for(const instance of pool)await (await instance).dispose();});
export async function runtime(t,{policy=fixturePolicy,worker,bindings={}}={}) {
  let instance,directory;
  if(worker || Object.keys(bindings).length) {
    // Actual Worker entry/HTTP/CLI tests keep their fresh compiled runtimes.
    instance=await initializeRuntime({worker,bindings});directory=instance.directory;
    t.after(()=>instance.dispose());
  } else {
    if(!cases.has(t)) {
      cases.set(t,acquire().then(release=>{
        const value={next:0};t.after(release);return value;
      }));
    }
    const lease=await cases.get(t),slot=lease.next++;
    instance=await (pool[slot]??=initializeRuntime());
    if(!await instance.supportsReset()) {
      await instance.dispose();
      instance=await (pool[slot]=initializeRuntime());
    }
    await instance.reset();
    directory=await mkdtemp(join(instance.directory,'case-'));
    t.after(()=>rm(directory,{recursive:true,force:true}));
  }
  return {
    directory,get db(){return instance.db;},get bucket(){return instance.bucket;},get mf(){return instance.mf;},
    connect:()=>instance.connect(policy),reopen:()=>instance.reopen(policy),reconfigure:changes=>instance.reconfigure(changes),
  };
}
