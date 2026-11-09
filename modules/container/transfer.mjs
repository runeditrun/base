import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { D1 } from './adapters/d1.mjs';
import { Objects } from './adapters/objects.mjs';
import { ensurePortabilitySchema } from './portability-schema.mjs';
import { migrate } from './migrations.mjs';
import { createPortability, PortabilityError } from '../portability/index.mjs';
import { migrationReplay } from '../portability/migration-history.mjs';
import { requireProductEmpty } from '../portability/legacy-safety.mjs';
import { destinationLedger } from '../portability/ledgers.mjs';
import { exportArchive, importArchive, fileRecords } from '../portability/files.mjs';
import { loadPolicy } from '../../cli/portability-policy.mjs';

// The defaults are the existing container mounts. Tests replace only the engine
// boundary's filesystem roots; the transfer, policy and storage adapters are real.
export async function transfer(spec,{root='/app',data='/data',archive='/archive',policyRoot='/private/policy'}={}) {
 let db,platform,worker;
 try {
  // Validate the default export before opening data, just as the native worker
  // does. Neither the module nor its entry point ever comes from the archive.
  let policy=await loadPolicy(policyRoot,spec.policy,spec.policyModule);
  const manifest=JSON.parse(await readFile(join(root,'container.json'),'utf8'));
  let unverified=false;
  if(spec.direction==='import' && spec.acknowledgeUnverifiedSchemaObjects===true)for await(const record of fileRecords(join(archive,spec.file)))if(record.kind==='manifest')unverified=record.schemaObjects===undefined;
  const preflight=async database=>{
   if(!unverified)return;
   const names=(await destinationLedger(database)??[]).map(m=>m.name);
   await requireProductEmpty({db:database,policy,migrations:async()=>migrationReplay(manifest.migrations[spec.binding].filter(m=>names.includes(m.name)),policy)});
  };
  const buckets={};
  if(manifest.engine==='node'){
   db=new D1(join(data,spec.binding+'.sqlite'));
   platform=new DatabaseSync(join(data,'platform.sqlite'));
   for(const [name,binding]of Object.entries(spec.buckets))buckets[name]=new Objects(platform,join(data,'objects'),binding);
  }else{
   const {workerEngine}=await import('./worker-engine.mjs');
   // Open the bindings without automatically applying migrations so the
   // recovery preflight also uses the validated policy.
   worker=await workerEngine({root,data,manifest,settings:{},applyMigrations:false});db=worker.databases[spec.binding];
   for(const [name,binding]of Object.entries(spec.buckets))buckets[name]=worker.objects[binding];
  }
  if(unverified)policy=await loadPolicy(policyRoot,spec.policy,spec.policyModule,{db,buckets});
  await preflight(db);
  for(const [binding,plan]of Object.entries(manifest.migrations)){
   const database=worker?worker.databases[binding]:binding===spec.binding?db:undefined;
   if(database){await migrate(database,plan);await ensurePortabilitySchema(database,manifest.portabilityMigrations);}
  }
  policy=await loadPolicy(policyRoot,spec.policy,spec.policyModule,{db,buckets});
  const service=await createPortability({db,buckets,policy,migrations:async()=>migrationReplay(manifest.migrations[spec.binding],policy)});
  return await(spec.direction==='export'?exportArchive(service,join(archive,spec.file),spec.transient):importArchive(service,join(archive,spec.file),spec.transient,spec.journal,undefined,{acknowledgeUnverifiedSchemaObjects:spec.acknowledgeUnverifiedSchemaObjects}));
 }finally{if(worker)await worker.close();else await db?.close?.();platform?.close();}
}

export function transferFailure(cause){
 const refused=cause instanceof PortabilityError && (cause.status===409 || ['wrong_product','schema_mismatch','staged_validation'].includes(cause.code.split(':')[0]));
 return {ok:false,refused,reason:cause instanceof PortabilityError?cause.code.split(':')[0]:'transfer_failed'};
}
if(process.argv[1]===import.meta.filename){
 try{console.log(JSON.stringify({ok:true,...await transfer(JSON.parse(await readFile('/private/transfer.json','utf8')))}));}
 catch(cause){const failure=transferFailure(cause);console.log(JSON.stringify(failure));process.exitCode=failure.refused?4:1;}
}
