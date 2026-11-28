import { launchSummary } from './run-transfers.mjs';
import { readySummary } from './ready-summary.mjs';
import { ownerEntryReady } from './owner-entry-ready.mjs';
import { nativeOwnerEntry } from './native-owner-entry.mjs';
import { prepareLiveModels } from './ai-local.mjs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {rm} from 'node:fs/promises';
import { serverRegistry } from './server-registry.mjs';
import { activityClock } from './server-activity.mjs';
import { runtimeFrontDoor } from './runtime-front-door.mjs';
import {serverResources} from './server-resources.mjs';
import { productionBuild } from './preview-cache.mjs';
import {localSettingKeys} from './settings.mjs';
import { shared } from './shared.mjs';
import { availablePort,selectedOrigin,stateSafety,refuseLegacyProcess } from './local.mjs';
import { tools } from './inspect.mjs';
import { invalid,missing,refuse,RerError,lifecycleError } from './errors.mjs';
import { processInfo } from '../modules/job-queue/processes.mjs';
import { declaredCrons,runScheduled } from './scheduled.mjs';
import { demoGuarded,demoPreflight } from './demo.mjs';
import { readDevKey,requireDevKey,refuseManagedInstallation,resolvePersona,openUrl,personaOpenUrl } from './dev-identity.mjs';
import { announceDoorRoute,claimSavedName,moveCheckout,routeRunning,verifyDoorFor } from './door-mode.mjs';
import { warmDocumentRender } from './render-warmup.mjs';
import { contained } from './project.mjs';
import { origin } from './parse.mjs';

const devStartReceipt = '.rer/local/dev-started';
const ownerOpenReceipt = '.rer/local/open-url';

// A busy default port moved this run; the detached launcher relays the same line.
export function portMoved(out,json,{port,busyPort,url}){
 if(json)out.event('port',{port,busyPort,url});
 else out.human(`Port ${busyPort} is in use, so this run serves on ${url}. The checkout keeps port ${busyPort}; ~/.local/bin/rer setup --port ${port} moves it.`);
}

// Dev opens through the local identity exchange. Preview serves production output.
export async function ready(out,url,dev,json=false,siteUrl,demo,root,ownerOpenUrl){
 if(json){out.event('ready',{url,...(dev?{signedInAs:dev.signedInAs??null,openUrl:dev.openUrl}:{}),...(ownerOpenUrl?{ownerOpenUrl}:{}),...(siteUrl?{siteUrl}:{}),...(demo?{demo}:{})});return;}
 if (root) {
  for (const line of readySummary({ url, ...dev, siteUrl })) out.human(line);
  for (const line of await launchSummary(root)) out.human(line);
  out.human('Details for tools and troubleshooting:');
 } else out.human(`Your app is ready, open it: ${dev?.openUrl ?? url}`);
 out.human(`RER_READY ${url}`);
 if(dev){
  if(dev.signedInAs)out.human(`RER_SIGNED_IN ${dev.signedInAs}`);
  else if(dev.ownerLeft)out.human('No active owner remains in this app. Use ~/.local/bin/rer dev --as PERSONA with an active operator, or ~/.local/bin/rer reset --yes and ~/.local/bin/rer setup for a new owner.');
  out.human(`RER_OPEN ${dev.openUrl}`);
  if (!root && !dev.native) out.human("Open that link on this computer. Its fragment holds this checkout's dev key, which the page keeps only as a cookie; never share the link.");
 }
 if(ownerOpenUrl){out.human(`RER_OWNER_OPEN ${ownerOpenUrl}`);out.human('Native owner entry: open on this computer once within 15 minutes. The link is not saved.');}
 if(siteUrl){if(!root)out.human(`Site: ${siteUrl}`);out.human(`RER_SITE ${siteUrl}`);}
 if(demo){out.human(`RER_DEMO_ENDS_ON_STOP ${demo.state}`);out.human(`This demo runs on its own data in that folder, which is deleted when it stops: ~/.local/bin/rer demo --stop, Ctrl-C, or at its end (${demo.ends.slice(11,16)}). Public reads and checks run for real. This checkout's own data is untouched.`);}
}
export async function managedServer(project,options,out,{clock={}}={}){
 const registry=await serverRegistry(project.root),controller=new AbortController();
 // A demo registers as its own mode: `rer dev --stop` never stops it by accident.
 const mode=options.demo?'demo':options.verb;
 let store,operation,proxy,activity,app,termination,reason,cleanupPromise,finished,selected,cleaned,site,demo,demoEnd,ownerEntry,forwarding=false;
 const scheduling=new AbortController();
 let activityWrites=Promise.resolve(),pendingActivity,activityWriting=false,infrastructureFailure;
 function recordActivity(fields){
  pendingActivity=fields;if(activityWriting)return;activityWriting=true;
  activityWrites=(async()=>{while(pendingActivity){const latest=pendingActivity;pendingActivity=undefined;await registry.updateActivity(latest);}})().catch(error=>{infrastructureFailure=error;void stop('activity bookkeeping failed');}).finally(()=>{activityWriting=false;if(pendingActivity)recordActivity(pendingActivity);});
 }
 const stopped=new Promise(resolve=>{finished=resolve;});
 const cleanupDone=new Promise(resolve=>{cleaned=resolve;});
 const cleanup=()=>cleanupPromise??=(async()=>{scheduling.abort();clearTimeout(demoEnd);activity?.close();await site?.close();await ownerEntry?.close();await store?.closeCommands();if(demo)await rm(demo.state,{recursive:true,force:true});await proxy?.close();await operation?.release();})();
 const stop=async why=>{reason??=why;controller.abort();finished();await cleanupDone;return {};};
 const handlers=new Map(['SIGINT','SIGTERM'].map(name=>[name,()=>{termination=name;void stop(name);} ]));
 for(const [name,handler]of handlers)process.on(name,handler);
 try{
  if(options.stop){await registry.stop(mode,options);return {};}
  controller.signal.throwIfAborted();
  if(options.door||options.direct)await moveCheckout(project,options,out,registry);
  const devIdentity=project.adapter.devIdentity;
  if(options.as!==undefined&&!(devIdentity&&options.verb==='dev'))throw invalid('--as needs a seed that declares devIdentity.');
  let devKey=devIdentity?await readDevKey(project.root):null;
  let current=await registry.existing(mode,options);
  if(!current){
   const reservation=await registry.reserve(mode,options);
   current=reservation.existing;
  }
  if(current){
   // Resolve a competing reservation through the same explicit-option check.
   current=await registry.existing(mode,options);
   const running=await registry.waitReady(current,controller.signal);
   await registry.existing(mode,options);
   if(options.verb==='dev' && (running.models??'fake')!==(options.models??'fake'))throw refuse('Stop the running dev server before changing --models mode.');
   if(options.modelsService)throw refuse('Stop the running dev server before saving live-dev credentials.');
   // A door-mode server is probed on its own proxy, never through the door.
   await claimSavedName(project,running.url);
   await routeRunning(running);
   const {appFetch}=await shared('app-fetch.mjs');
   const response=await appFetch(running.url+'/health',{headers:{'x-rer-probe':running.probe},signal:AbortSignal.timeout(5000)});
   if(!response.ok || (await response.json()).status!=='ok')throw refuse('Registered application failed health verification. Stop it before retrying.');
   if(devIdentity)devKey=await requireDevKey(project.root);
   // A key is sent (or printed) for a door origin only once the door proves it is ours.
   if(devIdentity)await verifyDoorFor(running.url);
   const ownerOpenUrl=await checkedNativeEntry(project.root,()=>registry.ownerEntry(running).then(value=>value.ownerOpenUrl),controller.signal,undefined,running.startupLog);
   const dev=devIdentity&&options.verb==='dev'&&await devReady(project.root,running.url,devKey,options,controller.signal,undefined,running.startupLog);
   await emitReady(out,options,project.root,running.url,dev,running.siteUrl,running.demo,ownerOpenUrl);return {reused:true};
  }
  await registry.serve(async action=>{
   if(action==='status')return {...activity?.snapshot(),forwarding,url:selected?.url,probe:proxy?.probe,siteUrl:site?.url,demo,startupLog:store?.logPath};
   if(action==='owner-entry')return ownerEntry?{ownerOpenUrl:ownerEntry.issue()}:{};
   if(action==='stop')return stop('explicit stop');
   throw Error('Unknown management operation');
  });
  await stateSafety(project);
  const {localOperation}=await shared('local/operation.mjs');
  try{operation=await localOperation(project.root);}catch(error){throw refuse(error.message);}
  const ownership=await refuseLegacyProcess(project,{verb:options.verb,operation,isolated:options.demo});
  if(ownership?.lockProof)out.progress('Local process inspection did not answer; continuing with the exclusive checkout launch lock.\n');
  const {recoverInterrupted}=await shared('local/recovery.mjs');await recoverInterrupted(project.root,operation);
  const {loadInstallerSeed}=await shared('setup-manifest.mjs');
  const seed=project.adapter.setup?await loadInstallerSeed(project.root,project.adapter):undefined;project.setupManifest=seed?.manifest;
  const keys=localSettingKeys(project);
  selected=await selectedOrigin(project,options);
  if(!selected.door){
   // Without --port, a busy port moves this run only; the saved origin stays.
   const port=await availablePort(selected.host,selected.port,{root:project.root,saved:!selected.explicitPort&&selected.savedOrigin!==undefined,verb:options.verb,move:!selected.explicitPort});
   if(port!==selected.port){
    const url=origin(selected.host,port);
    portMoved(out,options.json,{port,busyPort:selected.port,url});
    selected={...selected,port,url};
   }
  }
  if(!selected.vars[keys.email])throw missing(`Local prerequisite ${keys.email}: found unset; expected set; run ~/.local/bin/rer setup.`);
  if(devIdentity&&!devKey)devKey=await requireDevKey(project.root);
  if(devIdentity&&['dev','preview'].includes(options.verb))refuseManagedInstallation(selected.vars,process.env);
  if(options.demo)demo=await demoPreflight(project,selected.vars,options.idleTimeout);
  const prerequisites=async()=>{
   if(demo||!project.adapter.localPrerequisites)return;
   const result=await project.adapter.localPrerequisites({root:project.root,vars:selected.vars,email:selected.vars[keys.email],demo:false});
   if(result===true)return;
   // Older adapters can still return false; named failures carry only safe values.
   const {field,found,expected}=result||{field:'localPrerequisites',found:'false',expected:'true'};
   throw missing(`Local prerequisite ${field}: found ${found}; expected ${expected}; run ~/.local/bin/rer setup.`);
  };
  if(options.verb!=='dev')await prerequisites();
  await registry.update({url:selected.url,host:selected.host,port:selected.port,models:options.models??'fake'});
  const {privateDirectory}=await shared('private-files.mjs');
  if(!demo)await privateDirectory(project.root,['.wrangler','state']);
  const directory=await privateDirectory(project.root,['.seed','installer',...(process.env.RER_ONBOARDING_PROCESS_OWNER?[`commands-${process.pid}`]:[])]);
  const {createCommands}=await shared('commands.mjs');const state={logs:[]};
  store=await createCommands(directory,state,{terminal:text=>out.progress(text),onWaiting:options.json?details=>out.event('waiting',details):undefined,custodyToken:registry.custodyToken(),
   retryLocalMigrations:options.verb==='dev',onMigrationRetry:options.json?message=>out.event('migration-retry',{message}):undefined,
   queue:{verb:options.verb,originalCI:process.env.CI==='true'}});
  store.state=state;store.step=async label=>store.report(label);store.phase=async phase=>{state.phase=phase;};store.setCommandSignal(controller.signal);
  store.setupManifest=seed?.manifest;if(devKey)store.addSecrets([devKey]);
  await tools(project.root,store,controller.signal);
  activity=activityClock({...clock,seconds:options.idleTimeout,onIdle:()=>void stop('idle timeout'),onChange:recordActivity});
  if(demo)demoEnd=setTimeout(()=>void stop('demo ended'),Math.min(Date.parse(demo.ends)-Date.now(),2**31-1));
  const crons=project.adapter.scheduled!==false?await declaredCrons(project.root,project.adapter).catch(error=>{throw refuse(`The declared scheduled triggers cannot run locally: ${error.message}`);}):[];
  if(devIdentity&&(options.verb==='preview'||demo))ownerEntry=nativeOwnerEntry({origin:selected.url,state:demo?.state??join(project.root,'.wrangler','state'),store,demo:!!demo,devKey});
  proxy=await runtimeFrontDoor({host:selected.host,port:selected.port,activity,door:selected.door,devKey:devKey??undefined,origin:selected.url,ownerEntry:(req,res)=>ownerEntry?.handle(req,res)});const internal=proxy.runtimePort;
  if(selected.door)await announceDoorRoute(selected,proxy,registry);
  const modelsLive = options.verb==='dev' ? await prepareLiveModels(project.root,options,store,controller.signal) : undefined;
  const adapterOptions={modelsLive,demo,selectedOrigin:selected.url,operationToken:operation.token,privateSettings:project.adapter.settings,runtimePort:internal,setRuntimePort:port=>proxy.setRuntimePort(port),devKey:devKey??undefined,devLogin:false,scheduled:crons.length>0,beforeStart:options.verb==='dev'?prerequisites:undefined};
  const input={[keys.email]:selected.vars[keys.email]};
  if(options.verb==='preview')await productionBuild(project,()=>store.run('Building fixed production output',process.execPath,[fileURLToPath(new URL('../bin/rer.mjs',import.meta.url)),'build','--cwd',project.root,'--json'],{cwd:project.root,phase:'build',signal:controller.signal,env:{...process.env,RER_LOCAL_OPERATION:operation.token},afterCommand:()=>recoverInterrupted(project.root,operation)}),text=>store.report(text));
  // A saved owner link also proves a successful dev start by an older CLI.
  const firstDevStart=mode==='dev'&&!await hasDevStartReceipt(project.root,devIdentity);
  const onLoadWaiting=firstDevStart?details=>{
   if(options.json)out.event('waiting',details);
   else out.progress(details.message+'\n');
  }:undefined;
  await serverResources(project.root,{signal:controller.signal,onLoadWaiting});
  controller.signal.throwIfAborted();
  await project.adapter.run(project.root,input,store,async child=>{
   app=child;
   child.once('exit',code=>{if(!reason){reason='unexpected application exit';void cleanup().then(()=>finished({code:code||1}));}});
   const identity=await processInfo(child.pid);
   if(!identity)throw Error('Runtime exited before custody registration.');
   await registry.update({runtimeProcess:{pid:identity.pid,start:identity.start}});
  },controller.signal,{...adapterOptions,verb:options.verb,dev:project.adapter.dev,preview:project.adapter.preview});
  // The runtime can receive public requests now. Keep announcement/registry
  // readiness false until the browser has verified that same public door.
  forwarding=true;
  // Dev loads modules on demand: render one document now, so the owner's first signed-in page after setup does not pay for the whole graph.
  if(options.verb==='dev')await warmDocumentRender(selected.url,proxy.probe,controller.signal,store);
  // A key is sent (or printed) for a door origin only once the door proves it is ours.
  if(devKey)await verifyDoorFor(selected.url);
  if(demo)await demoGuarded(selected.url,demo.state,controller.signal);
  // Demo's dev-key exchange is authorized only after a native entry exists.
  // Verify that entry first, then leave a fresh single-use link for the owner.
  const ownerOpenUrl=await checkedNativeEntry(project.root,()=>ownerEntry?.issue(),controller.signal,store);
  const dev=devIdentity&&options.verb==='dev'&&await devReady(project.root,selected.url,devKey,options,controller.signal,store);
  if(options.verb==='dev'&&project.adapter.site){
   const {devSite}=await import('./site.mjs');
   try {
    site=await devSite(project,store,controller.signal,{host:selected.host,port:proxy.port});
    await registry.update({siteUrl:site.url});
   } catch(error) {
    if(error.code!=='site_private_data')throw error;
    const message=`Run site preview refused: ${error.message} The app is running; fix the site and run ~/.local/bin/rer build --site before publishing it.`;
    if(options.json)out.event('warning',{code:error.code,message});else out.progress(`Warning: ${message}\n`);
   }
  }
  controller.signal.throwIfAborted();
  if(firstDevStart&&!(dev?.openUrl&&options.as===undefined)){
   // Persona starts and seeds without devIdentity do not save an owner link.
   const {writePrivateFile}=await shared('private-files.mjs');
   await writePrivateFile(join(await privateDirectory(project.root,['.rer','local']),'dev-started'),'ready\n');
  }
  activity.ready();await emitReady(out,options,project.root,selected.url,dev,site?.url,demo,ownerOpenUrl);
  if(crons.length){
   out.progress(`Running ${crons.length===1?'the scheduled trigger':'the scheduled triggers'} locally: ${crons.join(' | ')}\n`);
   void runScheduled({crons,url:`http://127.0.0.1:${proxy.runtimePort}`,path:options.verb==='preview'?'/cdn-cgi/local/scheduled':undefined,signal:scheduling.signal,report:run=>reportScheduled(out,options,run)});
  }
  const result=await stopped;
  if(termination)throw new RerError('cancelled',`Stopped by ${termination} after owned children were stopped.`,termination==='SIGINT'?130:143);
  if(infrastructureFailure)throw new RerError('server_bookkeeping_failed','Server bookkeeping failed; owned serving was stopped.',1);
  if(result?.code)throw new RerError('app_exited','The application stopped unexpectedly.',result.code);
  out.progress(`Server stopped: ${reason}.\n`);return {};
 }catch(error){if(termination)throw new RerError('cancelled',`Stopped by ${termination} after owned children were stopped.`,termination==='SIGINT'?130:143);if(['idle timeout','explicit stop','demo ended'].includes(reason))return {};throw await lifecycleError(error,store);}finally{await cleanup();cleaned();while(activityWriting)await activityWrites;await registry.close();for(const [name,handler]of handlers)process.off(name,handler);}
}
function reportScheduled(out,options,run){
 const error=options.verb==='preview'&&run.status===404 ? 'The preview target does not expose /cdn-cgi/local/scheduled. Forward the adapter context scheduled flag to previewTarget, or set RER_RUNTIME_TRIGGERS=1 in a custom target using the shared production runtime. For another runtime, expose that internal trigger endpoint or declare scheduled:false.' : run.error;
 const at=new Date().toISOString().replace(/\.\d+Z$/,'Z'),outcome=run.skipped?`skipped (${error})`:run.ok?`ok ${run.ms}ms`:`failed (${run.status?`HTTP ${run.status}`:error}) ${run.ms}ms`;
 if(options.json)out.event('scheduled',{at,cron:run.cron,ok:run.ok,skipped:Boolean(run.skipped),status:run.status,ms:run.ms,...(error?{error}:{})});else out.human(`RER_SCHEDULED ${at} "${run.cron}" ${outcome}${error&&run.status?` — ${error}`:''}`);
}
async function hasDevStartReceipt(root,devIdentity){
 const paths=devIdentity?[devStartReceipt,ownerOpenReceipt]:[devStartReceipt];
 for(const path of paths){
  try{await contained(root,path,{privateFile:true});return true;}
  catch(error){if(error.code!=='missing_input')throw error;}
 }
 return false;
}
// dev also keeps its RER_OPEN link in owner-only .rer/local/open-url (0600),
// which reset removes with the rest of .rer/local, for a person or agent that
// did not keep the terminal output.
async function emitReady(out,options,root,url,dev,siteUrl,demo,ownerOpenUrl){
 if(options.verb==='dev'&&options.as===undefined&&dev?.openUrl){
  const {privateDirectory,writePrivateFile}=await shared('private-files.mjs');
  await writePrivateFile(join(await privateDirectory(root,['.rer','local']),'open-url'),dev.openUrl+'\n');
 }
 await ready(out,url,dev||(ownerOpenUrl?{openUrl:ownerOpenUrl,native:true}:undefined),options.json,siteUrl,demo,options.verb === 'dev' && !options.demo ? root : undefined,ownerOpenUrl);
}
async function devReady(root,url,key,options,signal,store,startupLog){
 const as=options.as??'owner',persona=await resolvePersona(url,key,as,signal);
 // The owner persona names the owner the session will actually have (the
 // remaining owner once the setup owner has left), or none when none is left.
 const scoped=options.as!==undefined;
 const link=scoped?await personaOpenUrl(url,key,persona):openUrl(url,key,{path:'/__dev/key',as:persona.as});
 await ownerEntryReady(root,link,signal,store,{persona:scoped,startupLog});
 return {identity:true,signedInAs:persona.email??null,ownerLeft:as==='owner'&&!persona.email,openUrl:scoped?await personaOpenUrl(url,key,persona):link};
}
async function checkedNativeEntry(root,issue,signal,store,startupLog){
 const link=await issue();
 if(!link)return;
 await ownerEntryReady(root,link,signal,store,{startupLog});
 // The probe redeemed its single-use grant. Announce a fresh grant through
 // that same checked public entry, leaving its redemption to the owner.
 return issue();
}
