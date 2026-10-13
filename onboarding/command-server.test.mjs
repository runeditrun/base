import {writeTestManifest, manifestContract} from './test-manifest-support.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { startInstaller } from './server.mjs';

const pause=()=>new Promise(resolve=>setTimeout(resolve,5));
async function setup(t,install){
 const root=await mkdtemp(join(tmpdir(),'command-server-'));
 const seed={product:'Command server fixture',model:{fields:{NAME:{valid:()=>true},PRIVATE_CREDENTIAL:{valid:()=>true}},safeKeys:['NAME'],secretScopes:{PRIVATE_CREDENTIAL:['NAME']}},validateInput:value=>value,install};
 await writeTestManifest(root,[{name:'NAME',label:'Name',kind:'text'},{name:'PRIVATE_CREDENTIAL',label:'Private credential',kind:'secret',input:'entered',ownerVisible:true,required:false,when:{field:'NAME',nonEmpty:true}},{name:'NESTED_KEY',label:'Direct credential',kind:'secret',input:'entered',ownerVisible:true,required:false}]);
 const server=await startInstaller(root,{seed:manifestContract(seed),noPrefill:true});
 t.after(async()=>{await server.close();await rm(root,{recursive:true,force:true});});
 const response=await fetch(server.origin),page=await response.text();const cookie=response.headers.get('set-cookie').split(';')[0],token=page.match(/name="installer-token" content="([a-f0-9]+)"/)[1];
 const headers={Origin:server.origin,Cookie:cookie,'X-Installer-Token':token,'Content-Type':'application/json'};
 const call=(path,value,extra={})=>fetch(server.origin+path,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(value)});
 const phase=async value=>{for(let n=0;n<200;n++){if(server.state.phase===value)return;await pause();}assert.fail('phase '+value);};
 return {server,root,token,cookie,call,phase};
}

test('HTTP capture retains cleared vault secrets, nested direct credentials, and session secrets',async t=>{
 let emit=[];
 const client=await setup(t,async(_root,input,store)=>{store.addSecrets('ADAPTER_GENERATED_SECRET');await store.run('Probe',process.execPath,['-e','process.stderr.write(process.env.PROBE_OUTPUT);process.exit(7)'],{env:{...process.env,PROBE_OUTPUT:[...emit,'ADAPTER_GENERATED_SECRET'].join('\n')}});});
 await client.call('/api/draft',{NAME:'First'});
 await client.call('/api/secrets',{revision:client.server.state.lastUpdate.revision,secrets:{PRIVATE_CREDENTIAL:'OLD_VAULT_CREDENTIAL'}});
 await client.call('/api/draft',{NAME:'Second'});
 emit=['OLD_VAULT_CREDENTIAL','TEST_NESTED_DIRECT_CREDENTIAL',client.token,client.cookie.slice('rer_installer='.length),client.server.state.sessionId];
 assert.equal((await client.call('/api/start',{NAME:'Second',NESTED_KEY:'TEST_NESTED_DIRECT_CREDENTIAL'})).status,202);await client.phase('failed');
 const output=JSON.stringify({logs:client.server.state.logs,error:client.server.state.error})+await readFile(join(client.root,'.seed/installer/install.log'),'utf8');
 for(const secret of [...emit,'ADAPTER_GENERATED_SECRET'])assert.ok(!output.includes(secret));assert.match(client.server.state.error,/Probe: exit 7/);
});

test('owner Stop cancels captured running command and supports explicit retry',async t=>{
 let attempts=0;
 const client=await setup(t,async(_root,_input,store)=>{if(++attempts===1)await store.run('Long operation',process.execPath,['-e','setInterval(()=>{},1000)']);else await store.phase('complete');});
 assert.equal((await client.call('/api/start',{})).status,202);
 assert.equal((await client.call('/api/stop',{}, {Origin:'https://attacker.invalid'})).status,403);
 assert.equal((await client.call('/api/stop',{})).status,202);await client.phase('failed');assert.match(client.server.state.error,/cancelled/);
 assert.equal((await client.call('/api/start',{})).status,202);await client.phase('complete');assert.equal(client.server.state.error,undefined);
});

test('Stop terminates the owned command group including its child while retaining final output',async t=>{
 const client=await setup(t,async(_root,_input,store)=>{
  const script=`const {spawn}=require('node:child_process');
   const descendant=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{console.log('DESCENDANT_STOPPED');process.exit(0)});console.log('DESCENDANT_READY');setInterval(()=>{},1000)"],{stdio:['ignore','inherit','inherit']});
   let stopping=false;process.on('SIGTERM',()=>{stopping=true;setTimeout(()=>descendant.kill('SIGTERM'),2000).unref()});
   descendant.on('exit',()=>{if(stopping)process.exit(0)});`;
  await store.run('Command group',process.execPath,['-e',script]);
 });
 assert.equal((await client.call('/api/start',{})).status,202);
 for(let n=0;n<200&&!client.server.state.logs.join('\n').includes('DESCENDANT_READY');n++)await pause();
 assert.match(client.server.state.logs.join('\n'),/DESCENDANT_READY/);
 const start=Date.now();assert.equal((await client.call('/api/stop',{})).status,202);await client.phase('failed');
 assert.ok(Date.now()-start<1500,'descendant needed emergency parent cleanup instead of group termination');
 assert.match(client.server.state.logs.join('\n'),/DESCENDANT_STOPPED/);
});

for(const reason of ['readiness','core failure'])test(`failed ${reason} cleans an exited command group before retry and keeps the log writable`,{skip:process.platform==='win32'},async t=>{
 let attempts=0,child,closed=false,descendant;
 const client=await setup(t,async(_root,_input,store,onApp)=>{
  if(++attempts>1){await store.run('Retry command',process.execPath,['-e',"console.log('RETRY_LOG_OUTPUT')"]);await store.phase('complete');return;}
  const script=`const {spawn}=require('node:child_process');const descendant=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{console.log('FAILED_ATTEMPT_DESCENDANT_STOPPED');process.exit(0)});process.send(process.pid);setInterval(()=>{},1000)"],{stdio:['ignore','inherit','inherit','ipc']});descendant.on('message',pid=>{console.log('DESCENDANT_PID:'+pid);console.log('LEADER_FINAL_OUTPUT');setTimeout(()=>process.exit(40),30)});`;
  child=store.spawn('Failed application',process.execPath,['-e',script]);onApp(child);child.once('close',()=>{closed=true;});
  if(reason==='readiness')await store.waitForReady('Failed application',child,()=>new Promise(()=>{}),{timeoutMs:1000,intervalMs:5});
  else {await once(child,'exit');throw Error('Untrusted core failure');}
 });
 try {
  assert.equal((await client.call('/api/start',{})).status,202);await client.phase('failed');
  assert.equal(closed,true,'failure was exposed before its owned group and pipes closed');
  const logs=client.server.state.logs.join('\n');descendant=Number(logs.match(/DESCENDANT_PID:(\d+)/)?.[1]);assert.ok(descendant);
  assert.match(logs,/FAILED_ATTEMPT_DESCENDANT_STOPPED/);
  for(let n=0;n<100;n++){try{process.kill(descendant,0);}catch(error){assert.equal(error.code,'ESRCH');descendant=undefined;break;}await pause();}
  assert.equal(descendant,undefined,'failed attempt left its descendant alive');
  if(reason==='readiness'){assert.match(client.server.state.error,/exit 40/);assert.match(client.server.state.error,/LEADER_FINAL_OUTPUT/);}
  assert.equal((await client.call('/api/start',{})).status,202);await client.phase('complete');
  const disk=await readFile(join(client.root,'.seed/installer/install.log'),'utf8');assert.match(disk,/LEADER_FINAL_OUTPUT/);assert.match(disk,/FAILED_ATTEMPT_DESCENDANT_STOPPED/);assert.match(disk,/RETRY_LOG_OUTPUT/);
 } finally {if(child&&!closed){try{process.kill(-child.pid,'SIGKILL');}catch{}}}
});

for(const reason of ['readiness exit','core failure','hard deadline','owner stop'])test(`${reason} cleans a group that ignores SIGTERM before permitting retry`,{skip:process.platform==='win32'},async t=>{
 let attempts=0,child,closed=false;
 const client=await setup(t,async(_root,_input,store,onApp)=>{
  if(++attempts>1){await store.run('Retry after escalation',process.execPath,['-e',"console.log('ESCALATION_RETRY_OUTPUT')"]);await store.phase('complete');return;}
  const exits=reason==='readiness exit'||reason==='core failure';
  const script=`const {spawn}=require('node:child_process');process.on('SIGTERM',()=>{});const descendant=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000)"],{stdio:['ignore','inherit','inherit','ipc']});descendant.on('message',()=>{console.log('ESCALATION_GROUP_READY');${exits?'setTimeout(()=>process.exit(40),30)':''}});`;
  child=store.spawn('Uncooperative application',process.execPath,['-e',script]);onApp(child);child.once('close',()=>{closed=true;});
  await once(child.stdout,'data');
  if(reason==='core failure'){await once(child,'exit');throw Error('Core operation failed');}
  await store.waitForReady('Uncooperative application',child,()=>({ready:false,message:'HTTP 503 waiting for startup'}),{timeoutMs:reason==='hard deadline'?25:10000,intervalMs:5});
 });
 try {
  assert.equal((await client.call('/api/start',{})).status,202);
  if(reason==='owner stop'){
   for(let n=0;n<200&&!client.server.state.logs.join('\n').includes('ESCALATION_GROUP_READY');n++)await pause();
   assert.ok(client.server.state.logs.join('\n').includes('ESCALATION_GROUP_READY'));
   assert.equal((await client.call('/api/stop',{})).status,202);
  }
  for(let n=0;n<600&&client.server.state.phase!=='failed';n++)await pause();
  assert.equal(client.server.state.phase,'failed');assert.equal(closed,true);
  assert.equal(child.stdout.destroyed,true);assert.equal(child.stderr.destroyed,true);
  if(reason==='readiness exit')assert.match(client.server.state.error,/exit 40/);
  if(reason==='hard deadline')assert.match(client.server.state.error,/readiness deadline exceeded.*Last health: HTTP 503 waiting for startup/s);
  if(reason==='owner stop')assert.match(client.server.state.error,/cancelled/);
  assert.equal((await client.call('/api/start',{})).status,202);await client.phase('complete');
  assert.match(await readFile(join(client.root,'.seed/installer/install.log'),'utf8'),/ESCALATION_RETRY_OUTPUT/);
 } finally {if(child&&!closed){try{process.kill(-child.pid,'SIGKILL');}catch{}}}
});
