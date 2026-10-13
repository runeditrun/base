import {readFile,writeFile,mkdir,cp} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {buildContainer} from '../build.mjs';
import {checkBoundary} from '../boundary.mjs';
import {moveRoundTrip} from './moves.mjs';
import {assert,client,docker,control,wait,delay} from './common.mjs';
import {defaultJourney} from './journey-default.mjs';
import {lampJourney} from './journey-lamp.mjs';
import {uptimeJourney} from './journey-uptime.mjs';
const [seed,source,results]=process.argv.slice(2);
if(!['default-seed','lamp','uptime'].includes(seed)||!source||!results)throw Error('Usage: conformance.mjs default-seed|lamp|uptime SOURCE RESULTS');
const root=resolve(source),directory=resolve(results);await mkdir(directory,{recursive:true});
const privateDirectory=join(directory,'private');await mkdir(privateDirectory,{recursive:true,mode:0o700});
const key=()=>randomBytes(32).toString('hex'),port={ 'default-seed':15510,lamp:15511,uptime:15512 }[seed],origin='http://127.0.0.1:'+port;
const settings={seed,port,bindings:{OWNER_EMAIL:'owner@example.test',SESSION_SECRET:key(),SETUP_TOKEN:key(),RER_DEV_KEY:key(),AUTH_ORIGIN:origin,AUTH_LOCAL:'true',MAIL_PROVIDER:'development',MAIL_FROM:'sender@example.test',AUTH_EMAIL_LIMIT:'1000',AUTH_IP_LIMIT:'1000',...(seed==='lamp'?{LAMP_PAGE_HOST:'localhost',LAMP_APP_HOST:'127.0.0.1',MAIL_PROVIDER:'resend',MAIL_FROM_ADDRESS:'sender@example.test',MAIL_PROVIDER_API_KEY:key(),LAMP_BOOTSTRAP_SECRET:key(),SUBSCRIBER_TOKEN_SECRET:key(),WEBHOOK_SIGNING_SECRET:key()}:{}),...(seed==='uptime'?{UPTIME_ORIGIN:origin,UPTIME_LOCAL_REVIEW:'true',UPTIME_RUNNER_KEY:key(),UPTIME_SYNTHETIC_PORT:'15513',SENDGRID_API_KEY:key(),UPTIME_CONTROL_ORIGIN:origin}: {})}};
const settingsFile=join(privateDirectory,seed+'.json');await writeFile(settingsFile,JSON.stringify(settings),{mode:0o600});
async function command(bin,args,log){const file=await import('node:fs').then(fs=>fs.createWriteStream(log));const child=spawn(bin,args,{cwd:root,env:process.env,stdio:['ignore','pipe','pipe']});child.stdout.pipe(file);child.stderr.pipe(file);try{await new Promise((done,fail)=>{child.once('error',fail);child.once('close',code=>code===0?done():fail(Error(bin+' exited '+code)));});}finally{file.end();if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');}}
const report={seed,source:root,driverNode:process.version,platforms:[]};
try{
 for(const platform of (process.env.CONFORMANCE_PLATFORMS?.split(',')??['workers','container'])){
  const engine=platform==='workers'||seed==='uptime'?'workerd':'node',name='rer-conformance-'+seed,volume=name+'-'+platform+'-'+Date.now(),image=name+':'+platform;
  const cacheContract=seed==='lamp'?'lamp-retained-v1':undefined,runner=seed==='uptime'?{entry:'runners/src/private-runner.mjs',files:['runners/src','src/domain','src/base','scripts/local-ports.mjs']}:undefined;
  const memoryMiB=engine==='workerd'&&seed==='lamp'?1024:512;const result={platform,engine,memoryMiB,checks:{},image};report.platforms.push(result);
  await checkBoundary(root,{engine,cacheContract});result.checks.importBoundary=true;
  const built=await buildContainer(root,{engine,cacheContract,runner,output:join(root,'.rer/container/'+platform)});
  await command('docker',['build','--tag',image,built.output],join(directory,seed+'-'+platform+'-image.log'));
  const digest=await docker('image','inspect','--format','{{.Id}}',image);result.imageDigest=digest;
  const setup=async(tag=image,ticks=true)=>docker('run','-d','--name',name,'--memory',memoryMiB+'m','--memory-swap',memoryMiB+'m','--cpus','1','--pids-limit','128','-p',`127.0.0.1:${port}:${port}`,'-v',volume+':/data','-v',import.meta.dirname+':/proof:ro','-v',settingsFile+':/private/settings.json:ro','-e','RER_IMAGE_DIGEST='+await docker('image','inspect','--format','{{.Id}}',tag),'-e','PROOF_TICKS='+ticks,'--entrypoint','sh',tag,'-c','exec flock -n --no-fork /data/host.lock node /proof/host.mjs');
  let flow;
  const app=client(origin),page=seed==='lamp'?client('http://localhost:'+port):null;
  try{
   await docker('volume','create',volume);await setup();await wait(async()=> (await app.call('/health')).ok,'native listener ready',{timeout:60000});
   result.health=await(await app.call('/health')).json();assert.equal(result.health.platform,'container');assert.equal(result.health.deployment.versionId,digest);result.checks.health=true;
   await app.call('/health',{headers:{'cf-connecting-ip':'192.0.2.9','x-forwarded-host':'attacker.invalid','x-forwarded-proto':'https','x-forwarded-for':'192.0.2.10','x-rer-original-url':'https://attacker.invalid/'}});
   const facts=await control(name,{operation:'facts'});assert.equal(new URL(facts.url).origin,origin);assert.notEqual(facts.client,'192.0.2.9');assert.notEqual(facts.client,'192.0.2.10');result.checks.untrustedIngress=true;
   flow=seed==='default-seed'?await defaultJourney(app,settings,name):seed==='lamp'?await lampJourney(app,page,settings,name):await uptimeJourney(app,settings,name);
   result.journey=flow.journey;result.checks.nativeJourney=true;result.initialMemoryPeakMiB=Number(await docker('exec',name,'cat','/sys/fs/cgroup/memory.peak'))/1024/1024;
   const state=await flow.persistence();
   if(platform==='container'){
    const conflict=await docker('run','--rm','-v',volume+':/data','--env','PORT=0',image).then(()=>false,()=>true);assert.ok(conflict,'second live volume holder refused');result.checks.hostLock=true;
    await docker('stop','-t','10',name);await docker('rm',name);if(seed==='lamp'){settings.bindings.EFFECTS_PAUSED='1';await writeFile(settingsFile,JSON.stringify(settings),{mode:0o600});}await setup(image,false);await wait(async()=> (await app.call('/health')).ok,'paused dispatcher ready',{timeout:60000});
    const pending=await flow.pending();if(seed==='lamp'){await control(name,{operation:'tick'});await control(name,{operation:'tick'});assert.equal((await control(name,{operation:'mails'})).length,0,'paused effects held');const response=await app.call('/api/app/deliveries');const {deliveries}=await response.json();assert.ok(deliveries.some(row=>row.outcome==='queued'&&!row.providerAcceptedAt));result.checks.effectsPaused=true;delete settings.bindings.EFFECTS_PAUSED;await writeFile(settingsFile,JSON.stringify(settings),{mode:0o600});}await docker('kill','--signal=KILL',name);await docker('start',name);await wait(async()=> (await app.call('/health')).ok,'SIGKILL recovery ready',{timeout:60000});
    await wait(async()=>{const recovered=await flow.recovered(pending);result.crash=recovered;return recovered.pending_effects_completed||recovered.pending_effects_completed_on_runner_poll;},'committed effects recovered',{timeout:90000});
    const integrity=await control(name,{operation:'storage-check'});assert.ok(integrity.all_ok);result.checks.sigkillRecovery=true;
    // A real migration is added by the next release; old rows remain usable.
    const {createHash}=await import('node:crypto'),manifestPath=join(built.output,'app/container.json'),next=JSON.parse(await readFile(manifestPath,'utf8'));
    const sql='CREATE TABLE container_upgrade_evidence(id INTEGER PRIMARY KEY, applied INTEGER NOT NULL);';
    next.migrations.DB.push({name:'9999_container_upgrade.sql',sql,sha256:createHash('sha256').update(sql).digest('hex'),statements:['CREATE TABLE container_upgrade_evidence(id INTEGER PRIMARY KEY, applied INTEGER NOT NULL)']});
    await writeFile(manifestPath,JSON.stringify(next));
    if(engine==='workerd'){const packagePath=join(built.output,'runtime/package.json'),pkg=JSON.parse(await readFile(packagePath,'utf8'));pkg.dependencies.miniflare='5.20260908.0-alpha';await writeFile(packagePath,JSON.stringify(pkg));}
    await writeFile(join(built.output,'Dockerfile.next'),await readFile(join(built.output,'Dockerfile'),'utf8'));
    await command('docker',['build','--file',join(built.output,'Dockerfile.next'),'--tag',image+'-next',built.output],join(directory,seed+'-upgrade-image.log'));
    await docker('stop','-t','10',name);await docker('rm',name);await setup(image+'-next');await wait(async()=> (await app.call('/health')).ok,'same-volume upgrade ready',{timeout:60000});const upgraded=await flow.persistence();for(const [key,value]of Object.entries(state))assert.ok(key==='r2_objects'?upgraded[key]>=value:upgraded[key]===value);assert.ok((await control(name,{operation:'storage-check'})).all_ok);assert.ok(Array.isArray((await control(name,{operation:'sql',sql:'SELECT applied FROM container_upgrade_evidence'})).results));result.checks.sameVolumeUpgrade=true;
   }
   const ip=JSON.parse(await docker('inspect',name))[0].NetworkSettings.Networks.bridge.IPAddress;
   const probes=[];for(const url of ['http://127.0.0.1:8082/','http://localhost:8082/',`http://${ip}:8082/`,'http://[::1]:8082/','http://[::ffff:127.0.0.1]:8082/','http://169.254.169.254/latest/meta-data/']){const before=(await control(name,{operation:'canary'})).hits;const probe=await control(name,{operation:'probe',url});const after=(await control(name,{operation:'canary'})).hits;assert.equal(probe.reached,false);assert.equal(after,before);probes.push({url,...probe});}
   const positive=await control(name,{operation:'probe',url:'https://example.com/'});assert.equal(positive.status,200,JSON.stringify(positive));result.egress={probes,positive};result.checks.egress=true;
   result.memoryEvents=await docker('exec',name,'cat','/sys/fs/cgroup/memory.events');
   if(seed==='lamp'){result.workload=await flow.measure();assert.ok(result.workload.completed);result.checks.workload=true;}
   if(platform==='container'&&seed!=='uptime'){const workers=join(root,'.rer/container/workers'),path=join(workers,'app/container.json'),manifest=JSON.parse(await readFile(path,'utf8'));manifest.migrations.DB=built.manifest.migrations.DB.concat(JSON.parse(await readFile(join(built.output,'app/container.json'),'utf8')).migrations.DB.at(-1));await writeFile(path,JSON.stringify(manifest));await command('docker',['build','--tag','rer-conformance-'+seed+':workers-next',workers],join(directory,seed+'-move-worker-image.log'));result.move=await moveRoundTrip({seed,name,image:image+'-next',workerImage:'rer-conformance-'+seed+':workers-next',settingsFile,proofDirectory:import.meta.dirname,archiveDirectory:privateDirectory,app,page});result.checks.archiveRoundTrip=true;}
   result.passed=true;
  }finally{await flow?.cleanup?.();await writeFile(join(directory,seed+'-'+platform+'-runtime.log'),await docker('logs',name).catch(()=>''));await docker('stop','-t','10',name).catch(()=>{});await docker('rm',name).catch(()=>{});await docker('volume','rm',volume);}
 }
 report.passed=true;console.log('CONFORMANCE_PASS '+seed);
}catch(cause){report.failure={message:cause.message,stack:cause.stack};process.exitCode=1;console.error('CONFORMANCE_FAIL '+seed+': '+cause.message);}
finally{await writeFile(join(directory,seed+'-conformance.json'),JSON.stringify(report,null,2)+'\n');}
