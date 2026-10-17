import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {serverRegistry} from './server-registry.mjs';
import { liveServers } from '../global/registry.mjs';
import { checkCapacity } from '../global/launch/capacity.mjs';

// Several checkouts share one machine registry. People keep the cap; a declared
// journey on its own port does not count; no checkout ever stops another's server.
test('over the cap a person is refused naming the running servers, a declared journey is not counted, and no other checkout\'s server is stopped',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'rer-registry-test-'));
 const roots=await Promise.all(['a','b','c','journey','d'].map(async name=>{const root=join(directory,name);await mkdir(root);return root;}));
 const clients=[],stopped=[],options={supplied:new Set(),idleTimeout:1800};
 const env={HOME:directory,RER_SERVER_LIMIT:'2'};
 const start=async(index,extra={},port=8787+index)=>{
  const client=await serverRegistry(roots[index],{env:{...env,...extra}});clients.push(client);
  const {owned}=await client.reserve('dev',options);assert.ok(owned);
  await client.update({host:'127.0.0.1',port,url:`http://127.0.0.1:${port}`});
  // Long idle and ready: the old eviction rule would have chosen these.
  await client.serve(async action=>{if(action==='status')return {ready:true,active:0,idleSeconds:3600,lastActivity:0};stopped.push([index,action]);return {};});
  return client;
 };
 try{
  await start(0);await start(1);
  assert.equal((await liveServers(env)).length, 2, 'global and checkout registries share supplied HOME');
  assert.deepEqual(await liveServers({ ...env, RER_SERVERS_DIR: join(directory, 'override') }), [], 'an explicit registry override wins');
  await start(3,{RER_SERVER_JOURNEY:'1'},9100);
  const third=await serverRegistry(roots[2],{env});clients.push(third);
  await assert.rejects(()=>third.reserve('dev',options),error=>error.exitCode===4&&/2 dev or preview servers are running[^]*limit is 2/.test(error.message)&&error.message.includes('RER_SERVER_LIMIT')&&error.message.includes('--stop')&&error.message.includes(roots[0])&&error.message.includes(roots[1])&&!error.message.includes(roots[3]));
  const second=await serverRegistry(roots[4],{env:{...env,RER_SERVER_JOURNEY:'1'}});clients.push(second);
  assert.ok((await second.reserve('dev',options)).owned,'a second journey is not counted either');
  await clients[0].close();
  assert.ok((await third.reserve('dev',options)).owned,'a freed slot admits the refused checkout');
  assert.deepEqual(stopped,[],'no server was stopped by another checkout');
 }finally{for(const client of clients.reverse())await client.close();await rm(directory,{recursive:true,force:true});}
});

// Without RER_SERVER_LIMIT ten servers fit, the eleventh is refused, and a record
// left by an older default of 2 (not set by a person) does not lower the cap.
test('the default allows ten servers and a recorded default of 2 never lowers the cap',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'rer-registry-default-'));
 const env={RER_SERVERS_DIR:join(directory,'registry')},options={supplied:new Set(),idleTimeout:43200},clients=[];
 try{
  for(let index=0;index<10;index++){
   const root=join(directory,`s${index}`);await mkdir(root);
   const client=await serverRegistry(root,{env});clients.push(client);
   const {owned}=await client.reserve('dev',options);assert.ok(owned,`server ${index+1} starts`);
   // Simulate a record written before the default was raised: limit 2, never set by a person.
   if(index===0)await client.update({limit:2,explicit:false});
  }
  const root=join(directory,'eleventh');await mkdir(root);
  const eleventh=await serverRegistry(root,{env});clients.push(eleventh);
  await assert.rejects(()=>eleventh.reserve('dev',options),error=>error.exitCode===4&&/10 dev or preview servers are running[^]*limit is 10/.test(error.message)&&error.message.includes('RER_SERVER_LIMIT'));
 }finally{for(const client of clients.reverse())await client.close();await rm(directory,{recursive:true,force:true});}
});

// A new server is refused only below the memory floor. The message gives the
// available memory, the floor, what is running and how to start anyway; reusing a
// running checkout's server and a declared journey are never refused for memory.
test('a start below the memory floor is refused with what is running and how to override it',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'rer-registry-memory-'));
 const GIB=1024**3,options={supplied:new Set(),idleTimeout:43200},clients=[],env={RER_SERVERS_DIR:join(directory,'registry')};
 const open=async(name,memory,extra={})=>{const root=join(directory,name);await mkdir(root,{recursive:true});const client=await serverRegistry(root,{env:{...env,...extra},memory});clients.push(client);return client;};
 try{
  const first=await open('first',()=>8*GIB);
  assert.ok((await first.reserve('dev',options)).owned,'plenty of memory starts');
  const short=await open('second',()=>1.2*GIB);
  await assert.rejects(()=>short.reserve('preview',options),error=>error.exitCode===4&&/1\.2 GiB is available[^]*1\.5 GiB/.test(error.message)&&error.message.includes(join(directory,'first'))&&error.message.includes('--stop')&&error.message.includes('RER_SERVERS_MIN_MEMORY_BYTES'));
  assert.ok((await (await open('second',()=>1.2*GIB,{RER_SERVERS_MIN_MEMORY_BYTES:String(GIB)})).reserve('preview',options)).owned,'a lower floor starts it');
  assert.ok((await (await open('third',()=>0,{RER_SERVER_JOURNEY:'1'})).reserve('dev',options)).owned,'a declared journey is not refused for memory');
  assert.ok((await (await open('first',()=>0)).reserve('dev',options)).existing,'a running checkout is reused whatever the memory');
 }finally{for(const client of clients.reverse())await client.close();await rm(directory,{recursive:true,force:true});}
});

// A long-lived run that still exports an older RER_SERVER_LIMIT (4) must not cap the
// fleet: RER_SERVER_LIMIT_FILE is the limit for a start, read at that start, over
// this process's RER_SERVER_LIMIT and over every running record's recorded limit.
// Without it the start behaves as before; a bad file refuses and names itself.
test('RER_SERVER_LIMIT_FILE sets the limit for a start over its own RER_SERVER_LIMIT and every running record\'s',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'rer-registry-file-'));
 const base={HOME:directory,RER_SERVERS_DIR:join(directory,'registry')},options={supplied:new Set(),idleTimeout:1800},clients=[],file=join(directory,'limit');
 const open=async(name,extra={})=>{const root=join(directory,name);await mkdir(root,{recursive:true});const client=await serverRegistry(root,{env:{...base,...extra}});clients.push(client);return client;};
 try{
  for(const name of ['a','b','c','d'])assert.ok((await (await open(name,{RER_SERVER_LIMIT:'4'})).reserve('dev',options)).owned,`${name} starts under its own limit of 4`);
  await assert.rejects(()=>(open('e1')).then(client=>client.reserve('dev',options)),error=>error.exitCode===4&&/limit is 4/.test(error.message)&&!error.message.includes('RER_SERVER_LIMIT_FILE'),'without the file the records still hold the cap at 4');
  await writeFile(file,'10\n');
  const withFile=await open('e2',{RER_SERVER_LIMIT:'4',RER_SERVER_LIMIT_FILE:file});
  assert.ok((await withFile.reserve('dev',options)).owned,'a file saying 10 admits the 5th start over RER_SERVER_LIMIT=4 and four records limited to 4');
  assert.deepEqual((await liveServers(base)).map(record=>[record.limit,record.explicit]).slice(-1),[[10,true]]);
  assert.equal((await checkCapacity(join(directory,'e3'),{...base,RER_SERVER_LIMIT_FILE:file},{explicitOnly:true,limit:10})).own,undefined,'the launcher check admits it too');
  await assert.rejects(()=>checkCapacity(join(directory,'e3'),{...base,RER_SERVER_LIMIT:'10'},{explicitOnly:true,limit:10}),error=>error.exitCode===4,'the launcher check without the file still holds at 4');
  await writeFile(file,'2');
  await assert.rejects(()=>open('e4',{RER_SERVER_LIMIT_FILE:file}).then(client=>client.reserve('dev',options)),error=>error.exitCode===4&&/5 dev or preview servers are running[^]*limit is 2/.test(error.message)&&error.message.includes(file)&&error.message.includes('RER_SERVER_LIMIT_FILE'),'the file saying 2 refuses at 2 and names itself');
  await assert.rejects(()=>checkCapacity(join(directory,'e3'),{...base,RER_SERVER_LIMIT_FILE:file},{explicitOnly:true,limit:10}),error=>error.exitCode===4&&/limit is 2/.test(error.message)&&error.message.includes(file));
  for(const [name,content] of [['words','ten'],['negative','-3'],['zero','0'],['decimal','4.5'],['empty','']]){
   const bad=join(directory,name);await writeFile(bad,content);
   await assert.rejects(()=>open('e5',{RER_SERVER_LIMIT_FILE:bad}).then(client=>client.reserve('dev',options)),error=>error.exitCode===4&&error.message.includes(bad),`${name} is refused naming the file`);
  }
  const missing=join(directory,'absent');
  await assert.rejects(()=>open('e5',{RER_SERVER_LIMIT_FILE:missing}).then(client=>client.reserve('dev',options)),error=>error.exitCode===4&&error.message.includes(missing)&&/cannot be read/.test(error.message));
  await assert.rejects(()=>checkCapacity(join(directory,'e3'),{...base,RER_SERVER_LIMIT_FILE:missing},{explicitOnly:true,limit:10}),error=>error.exitCode===4&&error.message.includes(missing));
 }finally{for(const client of clients.reverse())await client.close();await rm(directory,{recursive:true,force:true});}
});
