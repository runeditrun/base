import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, stat, rm, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { portabilityFixture, generatedSQL } from './fixtures/portability.mjs';
import { parseJsonc } from './jsonc.mjs';
import { containerMigrationInventory } from '../modules/container/migration-inventory.mjs';
import { portabilityPlan } from '../modules/container/portability-schema.mjs';
import { migrationStatements } from '../modules/portability/migration-sql.mjs';
import { D1 } from '../modules/container/adapters/d1.mjs';
import { DatabaseSync } from 'node:sqlite';
import { workerEngine } from '../modules/container/worker-engine.mjs';
import { Objects } from '../modules/container/adapters/objects.mjs';
import { makePart } from '../modules/portability/index.mjs';
import { ArchiveVerifier, ContentVerifier } from '../modules/portability/format.mjs';
import { fileRecords } from '../modules/portability/files.mjs';

const policySource=`if(process.argv[1].endsWith('/rer.mjs'))throw new Error('policy executed in CLI');
import { portabilityPolicy } from '../../src/core/platform/portability-policy.mjs';
import { exportRow, importRow, validateStaged } from './restore-policy.mjs';
export default {...portabilityPolicy,buckets:{FILES:{}},secretColumns:{},exportRow,
 importSafety:{computed_entries:{quantity:[0]}},importRow,validateStaged};
export async function createPolicy({db,buckets}) {
 if(!db.prepare || !buckets.FILES?.get)throw new Error('real data bindings required');
 await db.prepare('SELECT COUNT(*) AS n FROM computed_entries').first();
 await buckets.FILES.list({limit:1});
 return {...portabilityPolicy,buckets:{FILES:{}},secretColumns:{computed_entries:['label']},exportRow,
 importSafety:{computed_entries:{quantity:[0]}},importRow,validateStaged};
}
`;
const hooks=`const inactive=new Set([0]);
export const exportRow=(table,row)=>table==='computed_entries'?{...row,quantity:0}:row;
export const importRow=(table,row)=>table==='computed_entries'?{...row,quantity:0}:row;
export const validateStaged=async({read})=>(await read('computed_entries')).every(row=>inactive.has(row.quantity)&&row.label===null&&row.unit_price<=125);
`;
async function setup(t,{engine='node'}={}){
 const seed=await portabilityFixture(t),fixture=join(seed.root,'.rer/container-fixture');
 // Keep the exported public runner, but give this fixture a small seed-owned schema.
 await rm(join(seed.root,'migrations/core'),{recursive:true});
 await mkdir(join(seed.root,'migrations/core'));
 await writeFile(join(seed.root,'migrations/core/0001_entries.sql'),generatedSQL);
 for(const dir of ['app','data'])await mkdir(join(fixture,dir),{recursive:true});
 const config=parseJsonc(await readFile(join(seed.root,'wrangler.jsonc'),'utf8'));
 const require=createRequire(join(seed.root,'package.json')),{unstable_splitSqlQuery:split}=require('wrangler');
 const plan=(await containerMigrationInventory(seed.root,{config,configFile:'wrangler.jsonc'})).filter(m=>m.binding==='DB').map(({binding,...m})=>({...m,statements:migrationStatements(m.sql,split)}));
 const manifest={engine,entry:'dist/server/index.mjs',config:{compatibility_date:config.compatibility_date,compatibility_flags:config.compatibility_flags,d1_databases:config.d1_databases,r2_buckets:config.r2_buckets},migrations:{DB:plan},portabilityMigrations:await portabilityPlan(split)};
 await writeFile(join(fixture,'app/container.json'),JSON.stringify(manifest));
 await mkdir(join(fixture,'app/dist/server'),{recursive:true});await mkdir(join(fixture,'app/dist/client'),{recursive:true});
 await writeFile(join(fixture,'app/dist/server/index.mjs'),"export default {fetch(){return new Response('fixture')}};");
 const bound=async callback=>{const worker=await workerEngine({root:join(fixture,'app'),data:join(fixture,'data'),manifest,settings:{},applyMigrations:false});try{return await callback(worker);}finally{await worker.close();}};

 const local=join(seed.root,'scripts/installer/local.mjs'),original=await readFile(local,'utf8');
 const declare=declaration=>writeFile(local,original.replace('policy: portabilityPolicy',declaration));
 await writeFile(join(seed.root,'scripts/installer/archive-policy.mjs'),policySource);
 await writeFile(join(seed.root,'scripts/installer/restore-policy.mjs'),hooks);
 await declare("policyModule: 'scripts/installer/archive-policy.mjs'");
 const data=async sql=>{if(engine==='workerd')return bound(async worker=>(await worker.databases.DB.prepare(sql).all()).results);const db=new D1(join(fixture,'data/DB.sqlite'));try{return(await db.prepare(sql).all()).results;}finally{await db.close();}};
 const objects=async(callback)=>{if(engine==='workerd')return bound(worker=>callback(worker.objects.FILES));const sqlite=new DatabaseSync(join(fixture,'data/platform.sqlite'));try{return await callback(new Objects(sqlite,join(fixture,'data/objects'),'FILES'));}finally{sqlite.close();}};
 return {...seed,fixture,declare,data,objects,nativeData:seed.data};
}
async function fakeEngine(t){
 const directory=await mkdtemp(join(tmpdir(),'rer-docker-edge-')),oldPath=process.env.PATH;
 await symlink(new URL('./fixtures/container-portability-docker.mjs',import.meta.url),join(directory,'docker'));
 process.env.PATH=directory+':'+oldPath;
 t.after(async()=>{process.env.PATH=oldPath;await rm(directory,{recursive:true,force:true});});
}

for(const engine of ['node','workerd'])test('public '+engine+' container policy modules round trip and cross restore with native archives', {timeout:600_000}, async t=>{
 await fakeEngine(t);
 const source=await setup(t,{engine}),container=await setup(t,{engine}),native=await setup(t),nativeSource=await setup(t),fromNative=await setup(t,{engine}),refused=await setup(t,{engine});
 const exp=(seed,file,platform='container')=>seed.run(['export','--platform',platform,'--output','exports/'+file]);
 const restore=async(source,file,target,platform='container')=>{
  await copyFile(join(source.root,'exports',file),join(target.root,'exports',file));
  return target.run(['import','--platform',platform,'--input','exports/'+file,'--yes']);
 };
 await source.declare('policy: {...portabilityPolicy,buckets:{FILES:{}}}');
 await exp(source,'empty.rer');
 await source.declare("policyModule: new URL('./archive-policy.mjs', import.meta.url)");
 await source.data("INSERT INTO computed_entries(id,quantity,unit_price,label) VALUES('retained',3,125,'private value')");
 await source.objects(async bucket=>{await bucket.put('policy-proof','retained bytes');});
 const exported=(await exp(source,'source.rer')).at(-1);
 assert.equal(exported.objects,1);
 const archived=[];for await(const record of fileRecords(join(source.root,'exports/source.rer')))archived.push(record);
 const row=archived.flatMap(r=>r.items??[]).find(item=>item.table==='computed_entries').row;
 assert.equal(row.quantity,0);assert.equal(Object.hasOwn(row,'label'),false);
 assert.doesNotMatch(await readFile(join(source.root,'exports/source.rer'),'utf8'),/private value|policyModule|policy\.mjs/);
 const restored=(await restore(source,'source.rer',container)).at(-1);
 assert.equal(restored.contentHash,exported.contentHash);
 await restore(source,'source.rer',native,'workers');
 const query='SELECT * FROM computed_entries ORDER BY id',expected=await container.data(query);
 assert.deepEqual(expected.map(row=>({...row})),(await native.nativeData(query))[0].results);
 assert.equal(await container.objects(async bucket=>(await bucket.get('policy-proof')).text()),'retained bytes');
 await exp(native,'native.rer','workers');
 await restore(native,'native.rer',nativeSource,'workers');
 assert.deepEqual((await nativeSource.nativeData(query))[0].results,expected);
 await restore(native,'native.rer',fromNative);
 assert.equal(await fromNative.objects(async bucket=>(await bucket.get('policy-proof')).text()),'retained bytes');
 assert.deepEqual(await fromNative.data(query),expected);
 const nativeArchive=[];for await(const record of fileRecords(join(native.root,'exports/native.rer')))nativeArchive.push(record);
 assert.deepEqual(nativeArchive.flatMap(r=>r.items??[]).filter(i=>i.table==='computed_entries'),archived.flatMap(r=>r.items??[]).filter(i=>i.table==='computed_entries'));
 // A fully integrity-valid archive can still violate the seed's staged policy.
 row.unit_price=126;
 const content=new ContentVerifier(archived[0]),archive=new ArchiveVerifier(archived[0]);
 for(let i=1;i<archived.length-1;i++){
  archived[i]=await makePart(archived[i].index,archived[i].items);
  archive.add(archived[i]);for(const item of archived[i].items)content.add(item);
 }
 Object.assign(archived.at(-1),{contentHash:content.digest(),archiveHash:archive.digest()});
 await writeFile(join(refused.root,'exports/forbidden.rer'),archived.map(JSON.stringify).join('\n')+'\n',{mode:0o600});
 for await(const record of fileRecords(join(refused.root,'exports/forbidden.rer'))){}
 const failure=await refused.run(['import','--platform','container','--input','exports/forbidden.rer','--yes'],4);
 assert.match(failure.find(e=>e.event==='error').message,/staged_validation/);
 assert.deepEqual(await refused.data('SELECT * FROM computed_entries'),[]);
 assert.equal(await refused.objects(async bucket=>(await bucket.list()).objects.length),0);
});

test('public container policy refusals precede migrations and preserve native codes', {timeout:600_000},async t=>{
 await fakeEngine(t);
 const target=await setup(t),source=await setup(t);
 await source.run(['export','--platform','container','--output','exports/preflight.rer']);
 await copyFile(join(source.root,'exports/preflight.rer'),join(target.root,'exports/preflight.rer'));
 for(const [declaration,reason]of [
  ["policyModule: '../outside.mjs'",'invalid_policy_module'],
  ["policyModule: 'escaped-policy.mjs'",'invalid_policy_module'],
  ["policy: portabilityPolicy, policyModule: 'scripts/installer/archive-policy.mjs'",'ambiguous_policy'],
  ["policy: {...portabilityPolicy,validateStaged:()=>false}",'policy_module_required'],
  ["policyModule: 'scripts/installer/invalid-policy.mjs'",'invalid_policy_module'],
 ]){
  await writeFile(join(target.root,'../outside.mjs'),'export default {product:"outside"};');
  await symlink('../outside.mjs',join(target.root,'escaped-policy.mjs')).catch(e=>{if(e.code!=='EEXIST')throw e;});
  await writeFile(join(target.root,'scripts/installer/invalid-policy.mjs'),'export default {product:"invalid",validateStaged:true};');
  await target.declare(declaration);
  for(const args of [
   ['export','--platform','container','--output','exports/refused.rer'],
   ['import','--platform','container','--input','exports/preflight.rer','--yes'],
  ]){
   const result=await target.run(args,4);
   assert.match(result.find(e=>e.event==='error').message,new RegExp(reason));
  }
  await assert.rejects(stat(join(target.fixture,'data/DB.sqlite')),{code:'ENOENT'});
  await assert.rejects(stat(join(target.root,'exports/refused.rer')),{code:'ENOENT'});
 }
 // The default is valid, but the factory's type is not: still preflight-only.
 await writeFile(join(target.root,'scripts/installer/invalid-policy.mjs'),'export default {product:"invalid"}; export const createPolicy=true;');
 const result=await target.run(['export','--platform','container','--output','exports/refused.rer'],4);
 assert.match(result.find(e=>e.event==='error').message,/invalid_policy_module/);
 await assert.rejects(stat(join(target.fixture,'data/DB.sqlite')),{code:'ENOENT'});
 // Native's factory is called after product migrations, with real bindings;
 // its returned policy must also validate before a transfer can start.
 await writeFile(join(target.root,'scripts/installer/invalid-policy.mjs'),'export default {product:"invalid"}; export function createPolicy(){return {product:"invalid",validateStaged:true}}');
 const invalidFactory=await target.run(['export','--platform','container','--output','exports/refused.rer'],4);
 assert.match(invalidFactory.find(e=>e.event==='error').message,/invalid_policy_module/);
 assert.deepEqual(await target.data('SELECT * FROM computed_entries'),[]);
});
