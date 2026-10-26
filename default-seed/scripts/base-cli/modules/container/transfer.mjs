import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { D1 } from './adapters/d1.mjs';
import { Objects } from './adapters/objects.mjs';
import { ensurePortabilitySchema } from './portability-schema.mjs';
import { migrate } from './migrations.mjs';
import { createPortability } from '../portability/index.mjs';
import { migrationReplay } from '../portability/migration-history.mjs';
import { requireProductEmpty } from '../portability/legacy-safety.mjs';
import { destinationLedger } from '../portability/ledgers.mjs';
import { exportArchive, importArchive, fileRecords } from '../portability/files.mjs';
let db,platform,worker;
try {
 const spec=JSON.parse(await readFile('/private/transfer.json','utf8')),manifest=JSON.parse(await readFile('/app/container.json','utf8'));
 let unverified=false;
 if(spec.direction==='import' && spec.acknowledgeUnverifiedSchemaObjects===true)for await(const record of fileRecords('/archive/'+spec.file))if(record.kind==='manifest')unverified=record.schemaObjects===undefined;
 const preflight=async database=>{
  if(!unverified)return;
  const names=(await destinationLedger(database)??[]).map(m=>m.name);
  await requireProductEmpty({db:database,policy:spec.policy,migrations:async()=>migrationReplay(manifest.migrations[spec.binding].filter(m=>names.includes(m.name)),spec.policy)});
 };
 const buckets={};
 if(manifest.engine==='node'){
  db=new D1('/data/'+spec.binding+'.sqlite');await preflight(db);await migrate(db,manifest.migrations[spec.binding]);await ensurePortabilitySchema(db,manifest.portabilityMigrations);
  platform=new DatabaseSync('/data/platform.sqlite');
  for(const [name,binding]of Object.entries(spec.buckets))buckets[name]=new Objects(platform,'/data/objects',binding);
 }else{
  const {workerEngine}=await import('./worker-engine.mjs');worker=await workerEngine({root:'/app',data:'/data',manifest,settings:{},applyMigrations:!unverified});db=worker.databases[spec.binding];
  if(unverified){await preflight(db);for(const [binding,plan] of Object.entries(manifest.migrations)){await migrate(worker.databases[binding],plan);await ensurePortabilitySchema(worker.databases[binding],manifest.portabilityMigrations);}}
  for(const [name,binding]of Object.entries(spec.buckets))buckets[name]=worker.objects[binding];
 }
 const service=await createPortability({db,buckets,policy:spec.policy,migrations:async()=>migrationReplay(manifest.migrations[spec.binding],spec.policy)});
 const receipt=await(spec.direction==='export'?exportArchive(service,'/archive/'+spec.file,spec.transient):importArchive(service,'/archive/'+spec.file,spec.transient,spec.journal,undefined,{acknowledgeUnverifiedSchemaObjects:spec.acknowledgeUnverifiedSchemaObjects}));
 console.log(JSON.stringify(receipt));
}catch(cause){console.error('Container transfer refused or failed:',cause.name);process.exitCode=1;}
finally{await worker?.close();await db?.close?.();platform?.close();}
