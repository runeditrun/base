import assert from 'node:assert/strict';
import cp from 'node:child_process';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { createConnection, createServer } from 'node:net';

// Only the process-inspection edge is synthetic. The occupied socket and the
// suggested port's bind in the parent are real. Advance the inspection clock
// at that edge so the late path never depends on scheduler timing or sleeps.
const [mode,entry,pid,port,root]=process.argv.slice(2);
const now=performance.now();let elapsed=0,inspected=false;
performance.now=()=>now+elapsed;
const observe=()=>{inspected=true;if(mode!=='identified'&&mode!=='own')elapsed=20000;};
const unknown=mode==='inconclusive';
// The selection case owns its next candidate until inspection asks for it.
// Release it with an acknowledged socket close, independent of machine load
// and of unrelated listeners on randomly selected neighboring ports.
let released,queries=0;
const releaseCandidate=()=>released??=new Promise((resolve,reject)=>{
 const socket=createConnection({host:'127.0.0.1',port:Number(port)});
 socket.once('error',reject);socket.resume();socket.once('end',resolve);
});
const exec=cp.execFile;
cp.execFile=(command,args,options,callback)=>{
 if(command==='/bin/ps'&&args.includes('comm='))return queueMicrotask(()=>callback(null,'node\n',''));
 if(!command.endsWith('lsof'))return exec(command,args,options,callback);
 observe();
 const selected=args.find(arg=>arg.startsWith('-iTCP:'));
 const stdout=unknown||selected&&selected!==`-iTCP:${port}`?'':`p${pid}\nf1\ntIPv4\nn*:${port}\n`;
 const error=unknown?Object.assign(Error('inspection timed out'),{killed:true}):null;
 if(entry==='select'&&selected===`-iTCP:${Number(port)+1}`)return releaseCandidate().then(()=>callback(null,'',''),callback);
 queueMicrotask(()=>callback(error,stdout,''));
};
cp.execFile[promisify.custom]=(command,args,options)=>new Promise((resolve,reject)=>cp.execFile(command,args,options,(error,stdout,stderr)=>error?reject(Object.assign(error,{stdout,stderr})):resolve({stdout,stderr})));
const read=fs.readFile,dirs=fs.readdir,link=fs.readlink;
fs.readFile=async(path,...args)=>{
 if(path===`/proc/${pid}/comm`)return 'node\n';
 if(path==='/proc/net/tcp'||path==='/proc/net/tcp6'){
  if(entry==='select'&&path==='/proc/net/tcp'&&++queries===2)await releaseCandidate();
  // Linux identifies the holder only after matching a PID's FD to this
  // table's socket inode. Expire late there, as lsof does with its PID row.
  if(mode!=='late')observe();
  return 'header\n'+(unknown||path.endsWith('6')?'':`0: 00000000:${Number(port).toString(16)} 00000000:0000 0A 0 0 0 0 0 1234\n`);
 }
 return read(path,...args);
};
fs.readdir=async(path,...args)=>path==='/proc'?[pid]:path===`/proc/${pid}/fd`?['1']:dirs(path,...args);
fs.readlink=async(path,...args)=>{
 if(path===`/proc/${pid}/fd/1`){observe();return 'socket:[1234]';}
 return link(path,...args);
};
syncBuiltinESMExports();
const {availablePort}=await import('../local.mjs');
const {firstFreePort}=await import('../port.mjs');
const {listen}=await import('../listen.mjs');
const server=createServer();
try{
 if(entry==='select'){
  process.stdout.write(String(await firstFreePort('127.0.0.1',Number(port)))+'\n');
 }else{
 await assert.rejects(entry==='listen'?listen(server,'127.0.0.1',Number(port)):availablePort('127.0.0.1',Number(port),{root,saved:true}),error=>{
  assert.equal(error.exitCode,4);
  process.stdout.write(error.message+'\n');
  return true;
 });
 }
 assert.ok(inspected,'the injected process edge was exercised');
}finally{if(server.listening)await new Promise(resolve=>server.close(resolve));}
