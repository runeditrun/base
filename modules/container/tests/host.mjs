// Test-only paid-edge fixture and private diagnostics, mounted into the real image.
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {startHost} from '/runtime/modules/container/host.mjs';
import {publicFetch} from '/runtime/modules/container/adapters/egress.mjs';
import {storageCheck} from './storage-check.mjs';
import {createPortability} from '/runtime/modules/portability/index.mjs';
import {exportArchive,importArchive} from '/runtime/modules/portability/files.mjs';
const settings=JSON.parse(await readFile('/private/settings.json','utf8')),mails=[];
const edge=async(request,next)=>{
 if(request.url==='https://api.resend.com/emails'){mails.push(await request.json());return Response.json({id:crypto.randomUUID()});}
 if(request.url==='https://api.sendgrid.com/v3/mail/send'){mails.push(await request.json());return new Response(null,{status:202,headers:{'x-message-id':crypto.randomUUID()}});}
 return next(request);
};
const host=await startHost({settings:{...settings.bindings,...(process.env.RER_IMAGE_DIGEST?{RER_IMAGE_DIGEST:process.env.RER_IMAGE_DIGEST}:{})},port:settings.port,edge,automaticTicks:process.env.PROOF_TICKS!=='false',runnerEnabled:false});
let facts,hits=0;
const original=host.engine.fetch;host.engine.fetch=request=>{facts={url:request.url,client:request.headers.get('cf-connecting-ip')};return original(request);};
const canary=createServer((request,response)=>{hits++;response.end('reachable-private-canary');});await new Promise(resolve=>canary.listen(8082,'0.0.0.0',resolve));
let synthetic;
if(settings.seed==='uptime'){
 const port=Number(settings.bindings.UPTIME_SYNTHETIC_PORT);
 await mkdir('/data/runner',{recursive:true});

 // This fixture is only the network edge; the real packaged runner performs the request.
 const source=await readFile('/proof/synthetic.mjs','utf8');
 await writeFile('/app/runner/runners/src/synthetic.mjs',source);
 const {spawn}=await import('node:child_process');
 synthetic=spawn(process.execPath,['/app/runner/runners/src/synthetic.mjs'],{env:{...process.env,UPTIME_SYNTHETIC_PORT:String(port),UPTIME_GRANT_FILE:'/data/runner/grant.json'},stdio:'ignore'});
}
async function runner(){
 const {runRunner}=await import(pathToFileURL('/app/runner/'+host.manifest.runner.entry));
 const transport={async send(wire){const {NodePinnedTransport}=await import('/app/runner/src/base/modules/integrations/core/node-transport.ts');if(wire.url!=='https://api.sendgrid.com/v3/mail/send')return new NodePinnedTransport().send(wire);mails.push(JSON.parse(wire.body));return{status:202,headers:{'x-message-id':crypto.randomUUID()},body:''};}};
 await runRunner({origin:'http://127.0.0.1:'+settings.port,key:settings.bindings.UPTIME_RUNNER_KEY,grantPath:'/data/runner/grant.json',localReview:true,once:true,transport});return{completed:true};
}
const admin=createServer(async(request,response)=>{
 try{
  let body='';for await(const chunk of request)body+=chunk;const input=JSON.parse(body);let result;
  const db=host.engine.databases.DB;
  if(input.operation==='sql')result=await db.prepare(input.sql).bind(...(input.values??[])).all();
  else if(input.operation==='tick'){await host.engine.scheduled({cron:input.cron??host.manifest.config.triggers?.crons?.[0]??'* * * * *',scheduledTime:input.time??Date.now()});await host.engine.drain();result={delivered:true};}
  else if(input.operation==='mails')result=mails;
  else if(input.operation==='objects')result=await host.engine.objects.SNAPSHOTS.list();
  else if(input.operation==='storage-check')result=await storageCheck();
  else if(input.operation==='facts')result=facts;
  else if(input.operation==='canary')result={hits};
  else if(input.operation==='runner')result=await runner();
  else if(['export','import'].includes(input.operation)){
   if(!/^[a-z0-9-]+\.rer$/.test(input.file))throw Error('Invalid archive file');
   const policy={product:settings.seed,buckets:Object.fromEntries(Object.keys(host.engine.objects).map(name=>[name,{}])),replaceableTables:settings.seed==='lamp'?['public_snapshot_work','snapshot_build_control','reference_counters']:[],excludeTables:[...(settings.seed==='lamp'?[]:['operators']),'sessions','operator_magic_links','ik_%'],requiredConfiguration:settings.seed==='lamp'?['LAMP_BOOTSTRAP_SECRET','SUBSCRIBER_TOKEN_SECRET','WEBHOOK_SIGNING_SECRET']:['OWNER_EMAIL','SESSION_SECRET','SETUP_TOKEN']};
   const service=await createPortability({db,buckets:host.engine.objects,policy});await mkdir('/data/archives',{recursive:true,mode:0o700});
   result=await(input.operation==='export'?exportArchive:importArchive)(service,'/data/archives/'+input.file,[]);
  }
  else if(input.operation==='probe'){try{const forward=host.manifest.engine==='node'?publicFetch:request=>host.engine.mf.getWorker('egress').then(worker=>worker.fetch(request.url,{method:request.method,headers:request.headers}));const r=await forward(new Request(input.url));await r.arrayBuffer();result={reached:true,status:r.status};}catch(cause){result={reached:false,error:cause.message};}}
  else throw Error('Unknown private diagnostic');
  response.setHeader('content-type','application/json');response.end(JSON.stringify(result));
 }catch(cause){response.statusCode=500;response.end(JSON.stringify({error:cause.message}));}
});await new Promise(resolve=>admin.listen(8081,'127.0.0.1',resolve));
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{admin.close();canary.close();synthetic?.kill('SIGTERM');await host.close();process.exit(0);});
console.log('PROOF_READY');
