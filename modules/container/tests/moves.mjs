import {docker,control,wait,assert} from './common.mjs';
import {writeFile} from 'node:fs/promises';
export async function moveRoundTrip({seed,name,image,workerImage,settingsFile,proofDirectory,archiveDirectory,app,page}){
 const original=await control(name,{operation:'export',file:'source.rer'});
 const before=page?await(await page.call('/')).text():null;
 const archive=archiveDirectory+'/'+seed+'-container.rer';await docker('cp',name+':/data/archives/source.rer',archive);
 const volumes=[];
 async function start(tag,volume){await docker('run','-d','--name',name,'--memory','1024m','--cpus','1','--pids-limit','128','-p',`127.0.0.1:${new URL(app.origin).port}:${new URL(app.origin).port}`,'-v',volume+':/data','-v',proofDirectory+':/proof:ro','-v',settingsFile+':/private/settings.json:ro','-e','PROOF_TICKS=false','--entrypoint','sh',tag,'-c','exec flock -n --no-fork /data/host.lock node /proof/host.mjs');await wait(async()=> (await app.call('/health')).ok,'empty target ready',{timeout:60000});await wait(async()=> (await control(name,{operation:'storage-check'})).all_ok,'native transfer service ready',{timeout:60000});await docker('exec',name,'mkdir','-p','/data/archives');}
 try{
  for(const [index,tag]of [workerImage,image].entries()){
   await docker('stop','-t','10',name);await docker('rm',name);
   const volume='rer-move-'+seed+'-'+index+'-'+Date.now();volumes.push(volume);await docker('volume','create',volume);await start(tag,volume);
   await docker('cp',archive,name+':/data/archives/incoming.rer');const restored=await control(name,{operation:'import',file:'incoming.rer'});assert.equal(restored.contentHash,original.contentHash);
   assert.equal((await app.call(seed==='lamp'?'/api/app/components':'/api/work')).status,401,'old session is excluded from the move');
   const exported=await control(name,{operation:'export',file:'after.rer'});assert.equal(exported.contentHash,original.contentHash,'cross-platform content hash');
   if(page){assert.equal((await page.call('/api/public/status')).status,200);assert.equal(await(await page.call('/')).text(),before,'public R2 bytes survive move');}
   else {assert.equal((await app.call('/api/public/feed')).status,200);}
   await docker('cp',name+':/data/archives/after.rer',archiveDirectory+'/'+seed+'-move-'+index+'.rer');
  }
  return{containerToWorkers:true,workersToContainer:true,contentHash:original.contentHash,publicRead:true,sessionsExcluded:true};
 }finally{await writeFile(archiveDirectory+'/'+seed+'-move-runtime.log',await docker('logs',name).catch(()=>''));await docker('stop','-t','10',name).catch(()=>{});await docker('rm',name).catch(()=>{});for(const volume of volumes)await docker('volume','rm',volume);}
}
