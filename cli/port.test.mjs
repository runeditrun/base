import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {firstFreePort,busyPortMessage} from './port.mjs';
import {selectedOrigin} from './local.mjs';
import {prepareSettings} from '../onboarding/adapter-settings.mjs';

// A separate process listening on every address, the way another checkout's server may.
async function wildcardListener(t){
 const holder=spawn(process.execPath,['-e',"const s=require('node:net').createServer().listen(0,'0.0.0.0',()=>console.log(s.address().port));setInterval(()=>{},1000)"],{stdio:['ignore','pipe','inherit']});
 t.after(()=>holder.kill());
 return {pid:holder.pid,port:Number(String((await once(holder.stdout,'data'))[0]).trim())};
}
async function directory(t){const root=await mkdtemp(join(tmpdir(),'rer-port-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}

test('setup picks a free port and never one another process listens on, even on every address',async t=>{
 const holder=await wildcardListener(t);
 assert.notEqual(await firstFreePort('127.0.0.1',holder.port),holder.port);
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
 const holder=await wildcardListener(t),servers=await directory(t),root=await directory(t);
 await writeFile(join(servers,'state.json'),JSON.stringify({version:1,sequence:0,queued:[],running:[{checkout:'/work/other-checkout',mode:'dev',port:holder.port,owner:{pid:holder.pid}}]}));
 const message=await busyPortMessage({port:holder.port,host:'127.0.0.1',root,saved:true,env:{RER_SERVERS_DIR:servers}});
 assert.match(message,/\/work\/other-checkout/);
 assert.match(message,/rer setup --port \d+/);
 assert.match(message,/dev --cwd "\/work\/other-checkout" --stop/);
});
