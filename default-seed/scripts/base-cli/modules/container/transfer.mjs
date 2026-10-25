import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { D1 } from './adapters/d1.mjs';
import { Objects } from './adapters/objects.mjs';
import { ensurePortabilitySchema } from './portability-schema.mjs';
import { migrate } from './migrations.mjs';
import { createPortability } from '../portability/index.mjs';
import { migrationReplay } from '../portability/migration-history.mjs';
import { exportArchive, importArchive, fileRecords } from '../portability/files.mjs';
import { assertContainerArchiveRestorable } from './archive-policy.mjs';
let db,platform,worker;
try {
 const spec=JSON.parse(await readFile('/private/transfer.json','utf8')),manifest=JSON.parse(await readFile('/app/container.json','utf8'));
 // Refuse before migrations, staging, object writes or destination apply.
 if(spec.direction==='import')for await(const record of fileRecords('/archive/'+spec.file))if(record.kind==='manifest')assertContainerArchiveRestorable(record);
 const buckets={};
 if(manifest.engine==='node'){
  db=new D1('/data/'+spec.binding+'.sqlite');await migrate(db,manifest.migrations[spec.binding]);await ensurePortabilitySchema(db,manifest.portabilityMigrations);
  platform=new DatabaseSync('/data/platform.sqlite');
  for(const [name,binding]of Object.entries(spec.buckets))buckets[name]=new Objects(platform,'/data/objects',binding);
 }else{
  const {workerEngine}=await import('./worker-engine.mjs');worker=await workerEngine({root:'/app',data:'/data',manifest,settings:{}});db=worker.databases[spec.binding];
  for(const [name,binding]of Object.entries(spec.buckets))buckets[name]=worker.objects[binding];
 }
 const service=await createPortability({db,buckets,policy:spec.policy,migrations:async()=>migrationReplay(manifest.migrations[spec.binding],spec.policy)});
 const receipt=await(spec.direction==='export'?exportArchive:importArchive)(service,'/archive/'+spec.file,spec.transient,spec.journal);
 console.log(JSON.stringify(receipt));
}catch(cause){console.error('Container transfer refused or failed:',cause.code==='durable_jobs_restore_validator_required'?cause.message:cause.name);process.exitCode=1;}
finally{await worker?.close();await db?.close?.();platform?.close();}
