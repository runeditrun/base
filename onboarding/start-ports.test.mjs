import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { localInstaller, freePort, defaultHealth } from './adapter.mjs';
import { createState } from './state.mjs';

// A runtime socket is deliberately not an HTTP service. Receiving even one
// connection disturbs it, just as an HTTP request corrupts workerd's RPC stream.
const application = `
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { appendFileSync } from 'node:fs';
const port=Number(process.argv[3]);
const auxiliary=spawn(process.execPath,['auxiliary.mjs'],{stdio:['ignore','inherit','inherit','ipc']});
await once(auxiliary,'message');
if(process.argv[4]==='bind')await new Promise(done=>setTimeout(done,400));
if(process.argv[4]==='bind')http.createServer((request,response)=>{appendFileSync('application-traffic','request\\n');response.end('{"status":"ok"}');}).listen(port,'127.0.0.1');
process.on('SIGTERM',()=>{auxiliary.kill();process.exit();});
`;
const auxiliary = `
import net from 'node:net';
import { appendFileSync, writeFileSync } from 'node:fs';
process.title='workerd';
const server=net.createServer(socket=>{appendFileSync('auxiliary-traffic','connection\\n');socket.destroy();});
server.listen(Number(process.env.AUXILIARY_PORT??0),'127.0.0.1',()=>{writeFileSync('auxiliary-port',String(server.address().port));process.send('listening');});
`;
async function fixture(t) {
 const root=await mkdtemp(join(tmpdir(),'start-ports-'));
 await writeFile(join(root,'application.mjs'),application);
 await writeFile(join(root,'auxiliary.mjs'),auxiliary);
 const stores=[],children=[];
 t.after(async()=>{for(const [store,child] of children)await store.stop(child);for(const store of stores)await store.closeCommands();await rm(root,{recursive:true,force:true});});
 return {root,async start(expected,declared,mode,env={}){
  const store=await createState(root,{product:'Port fixture',model:{safeKeys:[]}});stores.push(store);
  let child;
  await localInstaller({tools:[],dependencies:false,origin:()=>`http://127.0.0.1:${expected}`,
   health:(url,signal)=>defaultHealth(url,signal).catch(()=>({ready:false,message:'Application has not bound its health listener'})),
   start:[process.execPath,['application.mjs','--port',String(declared),mode],{timeoutMs:2000,intervalMs:20,env:{...process.env,...env}}],
  }).install(root,{},store,app=>{child=app;children.push([store,app]);});
  return {store,child};
 },async traffic(name='auxiliary-traffic'){return readFile(join(root,name),'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;});}};
}

test('startup waits for the application without connecting to an auxiliary runtime listener',async t=>{
 const f=await fixture(t),port=await freePort();
 const {store,child}=await f.start(port,port,'bind');
 assert.equal(store.state.phase,'complete',store.state.error);
 assert.ok(Number(await readFile(join(f.root,'auxiliary-port'),'utf8'))>0,'the runtime socket was open before the app bound');
 assert.equal(await f.traffic(),'','no TCP connection, including an HTTP probe, reached the runtime socket');
 await store.stop(child);
});

test('a declared misbound application is diagnosed without probing it or a workerd helper',async t=>{
 const f=await fixture(t),expected=await freePort(),wrong=await freePort();
 // Merely declaring a port does not make a workerd helper an application.
 const helper=await f.start(expected,wrong,'wait',{AUXILIARY_PORT:String(wrong)});
 assert.equal(helper.store.state.phase,'failed');
 assert.match(helper.store.state.error,/readiness deadline exceeded/);
 assert.doesNotMatch(helper.store.state.error,/the application listened on port/);
 assert.equal(await f.traffic(),'','even the failure diagnosis leaves the RPC socket untouched');
 assert.notEqual(helper.child.exitCode??helper.child.signalCode,null);
 // An application process binding the explicitly declared wrong port provides
 // enough evidence itself. Its health need not receive a diagnostic request.
 const app=await f.start(expected,wrong,'bind');
 assert.equal(app.store.state.phase,'failed');
 assert.match(app.store.state.error,new RegExp(`the application listened on port ${wrong} but the CLI expected ${expected}`));
 assert.equal(await f.traffic(),'');
 assert.equal(await f.traffic('application-traffic'),'','the wrong application port was identified without an HTTP request');
 assert.notEqual(app.child.exitCode??app.child.signalCode,null);
});
