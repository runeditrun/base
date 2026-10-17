import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,realpath,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {selectedOrigin} from './local.mjs';
import {prepareSettings} from '../onboarding/adapter-settings.mjs';

// A separate process listening on every address, the way another checkout's server may.
async function wildcardListener(t,host='0.0.0.0'){
 const holder=spawn(process.execPath,['-e',`
 const {createServer}=require('node:net'),host=${JSON.stringify(host)};
 function start(){
  let next;
  const server=createServer(connection=>next.close(()=>connection.end('released'))).listen(0,host,()=>{
   const port=server.address().port;
   // Also hold the next port: an expired shared search budget must not erase
   // the instruction just because its first candidate is occupied too. The
   // selection case releases this reserved candidate at the inspection edge.
   if(port===65535)return server.close(start);
   next=createServer();
   next.once('error',error=>{if(error.code!=='EADDRINUSE')throw error;server.close(start);});
   next.listen(port+1,'127.0.0.1',()=>console.log(port));
  });
 }
 start();`],{stdio:['ignore','pipe','inherit']});
 t.after(async()=>{const stopped=once(holder,'exit');holder.kill();await stopped;});
 return {pid:holder.pid,port:Number(String((await once(holder.stdout,'data'))[0]).trim())};
}
async function directory(t){const root=await realpath(await mkdtemp(join(tmpdir(),'rer-port-')));t.after(()=>rm(root,{recursive:true,force:true}));return root;}

test('setup picks a free port and never one another process listens on, even on every address',async t=>{
 const holder=await wildcardListener(t),root=await directory(t);
 const {stdout}=await promisify(execFile)(process.execPath,[join(import.meta.dirname,'fixtures/port-inspection.mjs'),'identified','select',String(holder.pid),String(holder.port),root],{timeout:30000});
 assert.notEqual(Number(stdout.trim()),holder.port);
});

test('on a busy computer, where checking who holds a port is slow, the free-port search moves past ports in use instead of failing',async t=>{
 // Both held ports refuse the bind; each ownership check costs the whole budget.
 const holder=await wildcardListener(t,'127.0.0.1'),root=await directory(t);
 const {stdout}=await promisify(execFile)(process.execPath,[join(import.meta.dirname,'fixtures/port-inspection.mjs'),'late','select',String(holder.pid),String(holder.port),root],{timeout:30000});
 assert.ok(Number(stdout.trim())>holder.port+1,stdout);
});

test('setup --port on a saved checkout moves its saved origin and keeps its other settings',async t=>{
 const root=await directory(t),file=join(root,'.dev.vars');
 await writeFile(file,'OWNER_EMAIL=owner@example.test\nAUTH_ORIGIN=http://127.0.0.1:8787\nSESSION_SECRET=kept-secret\n',{mode:0o600});
 const hooks={secrets:{keepExisting:true,originKey:'AUTH_ORIGIN',values:({origin})=>({AUTH_ORIGIN:origin})}};
 const project={root,adapter:{hooks}};
 const selected=await selectedOrigin(project,{port:8790},{setup:true});
 assert.deepEqual(selected.moved,{from:8787,to:8790});
 await prepareSettings({root,input:{},store:{step:async()=>{}},selectedOrigin:selected.url},hooks);
 assert.equal(await readFile(file,'utf8'),'OWNER_EMAIL=owner@example.test\nAUTH_ORIGIN=http://127.0.0.1:8790\nSESSION_SECRET=kept-secret\n');
 assert.equal((await stat(file)).mode&0o777,0o600);
});

test('a busy port held by another checkout names that checkout and the command that moves this one',async t=>{
 const holder=await wildcardListener(t,'127.0.0.1'),servers=await directory(t),root=await directory(t);
 for(const mode of ['late','identified','inconclusive','own'])for(const entry of ['preflight','listen']){
  const checkout=mode==='own'?root:'/work/other-checkout';
  await writeFile(join(servers,'state.json'),JSON.stringify({version:1,sequence:0,queued:[],running:[{checkout,mode:'dev',port:holder.port,owner:{pid:holder.pid}}]}));
  const {stdout:message}=await promisify(execFile)(process.execPath,[join(import.meta.dirname,'fixtures/port-inspection.mjs'),mode,entry,String(holder.pid),String(holder.port),root],{env:{...process.env,RER_SERVERS_DIR:servers},cwd:root,timeout:30000});
  assert.match(message,/rer setup --port \d+/,`${mode} ${entry}: ${message}`);
  if(mode==='inconclusive')assert.doesNotMatch(message,/other-checkout|kill -TERM/);
  else {
   assert.ok(message.includes(checkout),message);
   assert.ok(message.includes(`dev --cwd "${checkout}" --stop`),message);
  }
  const port=Number(/rer setup --port (\d+)/.exec(message)[1]);
  assert.notEqual(port,holder.port);
  const socket=createServer();
  try{await new Promise((resolve,reject)=>{socket.once('error',reject);socket.listen(port,'127.0.0.1',resolve);});}
  finally{if(socket.listening)await new Promise(resolve=>socket.close(resolve));}
 }
});
