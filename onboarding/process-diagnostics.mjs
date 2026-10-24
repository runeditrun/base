import {lstat,realpath,readFile,readdir,readlink} from 'node:fs/promises';
import {basename,join} from 'node:path';
import {availableParallelism,homedir,loadavg} from 'node:os';
import {isIP} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {commandFailure,approvedFailure} from './failures.mjs';
import {stateFiles} from './local/state-files.mjs';
import {boundedProcessRead,processReadMs,readProcessCommand} from './process-read.mjs';
// macOS supplies lsof in /usr/sbin, which a command PATH may omit.
// Diagnose sockets with the system utility even when that PATH is constrained.
const lsof=process.platform==='darwin'?'/usr/sbin/lsof':'lsof';
// One monotonic budget covers every command in an ownership decision.
export const inspectionContext=({budgetMs=15000,...details}={})=>({deadline:performance.now()+budgetMs,budgetMs,...details});
// The ownership check of one free-port candidate on a busy computer gets longer,
// still bounded: the budget grows with the 1-minute load per CPU, up to four
// times. The search itself is bounded by its candidate count, not by this.
export const searchContext=(details={})=>inspectionContext({budgetMs:Math.round(15000*Math.min(4,Math.max(1,loadavg()[0]/availableParallelism()))),...details});
export const uncheckedInspection=error=>approvedFailure(error)?.ownershipUnchecked===true;
// Procfs and command probes use the same hard per-read maximum. A failed read
// remains unchecked, including when a larger ownership-decision budget exists.
const proc=async(read,context)=>{
 try{return await boundedProcessRead(read,Math.min(processReadMs,context.deadline-performance.now()),context.signal);}
 catch(error){
  if(context.signal?.aborted)throw context.signal.reason;
  throw commandFailure('Could not check local process ownership within its inspection bound.',{ownershipUnchecked:true});
 }
};
const run=async(command,args,context=inspectionContext(),{maxBuffer=1024*1024,noMatch=false,positiveResult}={})=>{
 const invocation=[command,...args].join(' ').replaceAll(homedir(),'~');
 const deadline=Math.min(context.deadline,performance.now()+processReadMs);
 let failure;
 for(let attempt=0;attempt<2;attempt++){
  const remaining=Math.floor(deadline-performance.now());
  if(remaining<=0)break;
  const timeout=Math.min(processReadMs,remaining);
  try{return (await readProcessCommand(command,args,{timeout,maxBuffer,signal:context.signal})).stdout;}
  catch(error){
   // A cancelled caller stops inspecting: the abort is never an ownership verdict.
   if(context.signal?.aborted)throw context.signal.reason;
   // A selected state file positively observed before a timeout still has a
   // holder. Partial output can never establish the absence of a holder.
   if(typeof error.stdout==='string'&&positiveResult?.(error.stdout))return error.stdout;
   // A quiet lsof exit 1 means no match, including a selected PID exiting
   // while other selected PIDs still return records. Diagnostic output instead
   // means inspection failed, even if lsof also returned partial records.
   if((command===lsof||noMatch)&&error.code===1&&!error.killed&&!error.signal&&typeof error.stdout==='string'&&typeof error.stderr==='string'&&!error.stderr.trim())return error.stdout;
   failure=error.killed ? `timed out after ${timeout} ms` : `failed (${error.code??error.signal??'unknown error'}${typeof error.stderr==='string'&&error.stderr.trim()?'; diagnostic output':''}; attempt bound ${timeout} ms)`;
  }
 }
 const subject=context.port?`who uses port ${context.port}`:'local process ownership';
 const cause=failure?.startsWith('timed out')||performance.now()>=context.deadline?'in time (system busy)':'because the system process check failed';
 throw commandFailure(`Could not check ${subject} ${cause}. Run rer ${context.verb??'dev'} again. No other owner was identified.\nOwnership check: ${invocation} ${failure??'total inspection deadline exhausted'} (at most 2 attempts; shared total bound ${context.budgetMs??15000} ms).`,{ownershipUnchecked:true});
};

export async function processName(pid,context=inspectionContext()){
 try{process.kill(pid,0);}catch(error){if(error.code==='ESRCH')return 'process';}
 if(process.platform==='linux'){const name=await proc((_bound,signal)=>readFile(`/proc/${pid}/comm`,{encoding:'utf8',signal}).catch(()=>''),context);if(name)return name.trim().replace(/[^a-zA-Z0-9._-]/g,'').slice(0,80)||'process';}
 // A completed quiet ps exit 1 means the PID has exited. Its display label
 // is optional; this does not prove listener ownership or process liveness.
 const text=await run('/bin/ps',['-p',String(pid),'-o','comm='],context,{noMatch:true});
 return basename(text.trim()).replace(/[^a-zA-Z0-9._-]/g,'').slice(0,80)||'process';
}
function records(text,socketTypes=false){
 let record,family;const rows=[];
 for(const line of text.split('\n')){
  if(line[0]==='p'){record={pid:Number(line.slice(1)),names:[],...(socketTypes?{sockets:[]}: {})};family=undefined;rows.push(record);}
  else if(line[0]==='c'&&record)record.command=basename(line.slice(1)).replace(/[^a-zA-Z0-9._-]/g,'').slice(0,80);
  else if(line[0]==='f')family=undefined;
  else if(line[0]==='t')family=['IPv4','IPv6'].includes(line.slice(1))?line.slice(1):undefined;
  else if(line[0]==='n'&&record){const name=line.slice(1);record.names.push(name);if(socketTypes)record.sockets.push({name,family});}
 }
 return rows;
}
export async function listeners(pids,context=inspectionContext(),port){
 // -a is essential: otherwise lsof ORs the PID and network selections and
 // still walks every process's sockets. Read only the owned tree on failure.
 if(!pids&&!port&&context.allListeners)return context.allListeners;
 if(process.platform!=='linux'){
  // lsof renders both IPv4 and IPv6 wildcards as '*'. Keep the type of
  // each file descriptor: a process may hold sockets of both families.
  // -b avoids unrelated mount stat/readlink calls that can block even a PID
  // query on macOS. -w suppresses the expected warnings for skipped filesystem
  // metadata; neither that metadata nor pathname selection is used here.
  const rows=records(await run(lsof,['-nP','-b','-w',...(pids?['-a','-p',pids.join(',')]:[]),port?`-iTCP:${port}`:'-iTCP','-sTCP:LISTEN','-Fpftn'],context),true);
  if(!pids&&!port)context.allListeners=rows;
  return rows;
 }
 const sockets=new Map();
 for(const file of ['tcp','tcp6'])for(const line of (await proc((_bound,signal)=>readFile('/proc/net/'+file,{encoding:'utf8',signal}).catch(error=>{if(error.code==='ENOENT')return '';throw error;}),context)).trim().split('\n').slice(1)){
  const parts=line.trim().split(/\s+/);if(parts[3]==='0A'&&(!port||parseInt(parts[1].split(':')[1],16)===port))sockets.set(parts[9],{name:linuxAddress(parts[1]),family:file==='tcp'?'IPv4':'IPv6'});
 }
 const found=[];
 for(const pid of pids??await linuxPids(context)){
  const held=[];for(const target of await descriptors(pid,context)){const inode=/^socket:\[(\d+)\]$/.exec(target)?.[1];if(sockets.has(inode))held.push(sockets.get(inode));}
  if(held.length)found.push({pid,names:held.map(socket=>socket.name),sockets:held});
 }
 if(!pids&&!port)context.allListeners=found;
 return found;
}
// /proc encodes each 32-bit address word in host byte order.
function linuxAddress(local){
 const [hex,port]=local.split(':');
 const bytes=hex.match(/.{8}/g).map(word=>Buffer.from(word.match(/../g).reverse().join(''),'hex'));
 const address=Buffer.concat(bytes);
 const host=address.every(byte=>byte===0)?'*':hex.length===8?[...address].join('.'):
  address.subarray(0,10).every(byte=>byte===0)&&address[10]===255&&address[11]===255?'::ffff:'+([...address.subarray(12)].join('.')):
  [...Array(8)].map((_,i)=>address.readUInt16BE(i*2).toString(16)).join(':').replace(/(^|:)0(?::0)+(?=:|$)/,':').replace(/^:([^:])/, '::$1').replace(/([^:]):$/, '$1::');
 return `${host.includes(':')?'['+host+']':host}:${parseInt(port,16)}`;
}
async function linuxPids(context){return (await proc(()=>readdir('/proc'),context)).filter(name=>/^\d+$/.test(name)).map(Number);}
async function descriptors(pid,context){return proc(async()=>Promise.all((await readdir(`/proc/${pid}/fd`).catch(()=>[])).map(fd=>readlink(`/proc/${pid}/fd/${fd}`).catch(()=>''))),context);}

const portOf=name=>Number(/:(\d+)$/.exec(name)?.[1]);
export async function processCwd(pid,context=inspectionContext()){
 if(process.platform==='linux')return proc(()=>readlink(`/proc/${pid}/cwd`).catch(()=>undefined),context);
 return records(await run(lsof,['-nP','-b','-w','-a','-p',String(pid),'-d','cwd','-Fpn'],context)).flatMap(row=>row.names)[0];
}
// Every TCP port some process listens on, on any address: a wildcard listener
// does not stop a bind to 127.0.0.1, yet it still serves that port's traffic.
export async function listeningPorts(context=inspectionContext()){return new Set((await listeners(undefined,context)).flatMap(row=>row.names.map(portOf)).filter(Number.isInteger));}
// The process that listens on a port on the given host's address or on every
// address, with its command and working directory.
function normalizedAddress(address){
 const bare=address.replace(/^\[|\]$/g,'');
 if(bare.toLowerCase()==='localhost')return 'localhost';
 if(isIP(bare)!==6)return bare;
 const [ip,zone]=bare.split('%');
 const normalized=new URL(`http://[${ip}]/`).hostname.slice(1,-1)+(zone?'%'+zone:'');
 const mapped=/^::ffff:([\da-f]+):([\da-f]+)$/i.exec(normalized);
 return mapped?mapped.slice(1).flatMap(word=>[parseInt(word,16)>>>8,parseInt(word,16)&255]).join('.'):normalized;
}
// undefined means the inspection cannot prove whether this socket serves the
// address. In particular, an IPv6 wildcard does not reveal IPV6_V6ONLY.
function serves({name,family},port,host){
 if(portOf(name)!==port)return false;
 if(!host)return true;
 const address=normalizedAddress(name.slice(0,name.lastIndexOf(':'))),target=normalizedAddress(host);
 if(target==='localhost'){
  const matches=['127.0.0.1','::1'].map(loopback=>serves({name,family},port,loopback));
  return matches.includes(true)?true:matches.includes(undefined)?undefined:false;
 }
 if(address!=='*'&&address!=='0.0.0.0'&&address!=='::')return address===target;
 const socketFamily=family??(address==='0.0.0.0'?'IPv4':address==='::'?'IPv6':undefined);
 if(socketFamily==='IPv4')return isIP(target)===4;
 if(socketFamily==='IPv6'&&isIP(target)===6)return true;
 return undefined;
}
function matchingListener(rows,port,host){
 const row=rows.find(row=>row.sockets.some(socket=>serves(socket,port,host)===true));
 if(row)return row;
 if(rows.some(row=>row.sockets.some(socket=>serves(socket,port,host)===undefined))){
  throw commandFailure(`Could not check who uses port ${port}: a wildcard socket's address family does not prove it serves ${host}. No other owner was identified. Bind the application to the health address explicitly, then run rer dev again.`,{ownershipUnchecked:true});
 }
}
export async function portListener(port,host,context=inspectionContext()){
 context.port=port;
 const row=matchingListener(await listeners(undefined,context,port),port,host);
 if(!row)return;
 // Labels improve the instruction, but a slow optional label cannot erase a
 // positive PID/socket observation or turn it into an unchecked accusation.
 const optional=async action=>{try{return await action();}catch(error){if(!uncheckedInspection(error))throw error;}};
 return {pid:row.pid,command:await optional(()=>processName(row.pid,context))??'process',cwd:await optional(()=>processCwd(row.pid,context))};
}
async function descendants(pid,context){
 const rows=(await run('/bin/ps',['-axo','pid=,ppid='],context)).trim().split('\n').map(line=>line.trim().split(/\s+/).map(Number));
 const owned=new Set([pid]);for(let changed=true;changed;){changed=false;for(const [child,parent]of rows)if(owned.has(parent)&&!owned.has(child)){owned.add(child);changed=true;}}
 return owned;
}
export async function listenerPorts(pid,context=inspectionContext()){
 const owned=await descendants(pid,context);
 return [...new Set((await listeners([...owned],context)).filter(row=>owned.has(row.pid)).flatMap(row=>row.names.map(portOf)).filter(port=>Number.isInteger(port)&&port>0&&port<=65535))].sort((a,b)=>a-b);
}
// An exact health address can use positive own-tree evidence. localhost can
// reach either loopback family, so it also needs a completed inspection with
// no foreign listener on either address before owner/sign-in can proceed.
export async function listenerOwnership(pid,port,host,context=inspectionContext()){
 context.port=port;
 do {
 // A cancelled launch has stopped its app, so its listener never appears:
 // end now rather than polling ps and lsof until the inspection budget.
 context.signal?.throwIfAborted();
 const owned=await descendants(pid,context);
 const ownRows=await listeners([...owned],context);
 const own=ownRows.find(row=>owned.has(row.pid)&&row.sockets.some(socket=>serves(socket,port,host)===true));
 const localhost=host&&normalizedAddress(host)==='localhost';
 if(own&&!localhost)return {status:'owned',pid:own.pid};
 const rows=await listeners(undefined,context,port);
 if(localhost){
  const foreign=matchingListener(rows.filter(row=>!owned.has(row.pid)),port,host);
  if(foreign)return {status:'other',pid:foreign.pid};
 }
 const row=matchingListener(rows,port,host);
 if(row)return {status:owned.has(row.pid)?'owned':'other',pid:row.pid};
 const remaining=context.deadline-performance.now();
 if(remaining<=0)return {status:'none'};
 await delay(Math.min(100,remaining),undefined,{signal:context.signal});
 }while(performance.now()<context.deadline);
 return {status:'none'};
}
// The caller and the chain that launched it (an installer server running setup,
// pnpm, a shell) act for this command, never against it.
async function callerLineage(context){
 const parents=new Map((await run('/bin/ps',['-axo','pid=,ppid='],context)).trim().split('\n').map(line=>line.trim().split(/\s+/).map(Number)));
 const lineage=new Set([process.pid,process.ppid]);
 for(let pid=process.ppid;pid>1&&parents.has(pid);){pid=parents.get(pid);if(lineage.has(pid))break;lineage.add(pid);}
 return lineage;
}
export async function localProcessConflict(root,savedOrigin,context=inspectionContext()){
 root=await realpath(root);
 // Inspect canonical state before optional socket diagnostics spend the shared
 // budget. This is file custody, not a claim that another process owns a port.
 const state=join(root,'.wrangler/state');
 let hasState=true;try{await lstat(state);}catch(error){if(error.code==='ENOENT')hasState=false;else throw error;}
 // A checkout with no local state and no saved origin (a fresh clone) has
 // nothing another process could hold: no state files and no port of its own,
 // so no process table or socket scan is spent on it.
 if(!hasState&&!savedOrigin)return;
 const lineage=await callerLineage(context);
 let held;
 if(hasState){
  if(process.platform==='linux'){for(const pid of await linuxPids(context))if(!lineage.has(pid)&&(await descriptors(pid,context)).some(path=>path.startsWith(state+'/'))){held={pid};break;}}
  else {
   const files=await stateFiles(state);
   // Path selection needs stat, so -b (which skips stat) is inappropriate here.
   // No system-wide open-file output, and no query at all for empty state.
   if(files.length){
    const budgetMs=context.verb==='dev'?3000:context.budgetMs??15000;
    const stateContext=inspectionContext({verb:context.verb,budgetMs,deadline:Math.min(context.deadline,performance.now()+budgetMs)});
    const holder=text=>records(text).find(row=>!lineage.has(row.pid)&&row.names.some(path=>path.startsWith(state+'/')));
    held=holder(await run(lsof,['-nP','-w','-Fpcn','--',...files],stateContext,{positiveResult:holder}));
   }
  }
  if(held){
   // A slow optional label cannot discard a positively observed holder.
   let command=held.command;
   if(!command)try{command=await processName(held.pid,context);}catch(error){if(!uncheckedInspection(error))throw error;}
   return {pid:held.pid,command:command||'process',reason:'the canonical local state'};
  }
 }
 const all=await listeners(undefined,context);
 const cwdRecords=process.platform!=='linux'&&all.length?records(await run(lsof,['-nP','-b','-w','-a','-p',all.map(row=>row.pid).join(','),'-d','cwd','-Fpn'],context)):[];
 let port;try{const url=new URL(savedOrigin);port=Number(url.port||80);}catch{}
 for(const row of all){
  if(lineage.has(row.pid))continue;
  const onSavedPort=port&&row.names.some(name=>Number(/:(\d+)$/.exec(name)?.[1])===port);
  const cwd=process.platform==='linux'?[await processCwd(row.pid,context)].filter(Boolean):cwdRecords.filter(item=>item.pid===row.pid).flatMap(item=>item.names);
  const places=(await Promise.all(cwd.map(path=>realpath(path).catch(()=>undefined)))).filter(Boolean),inCheckout=places.includes(root);
  // A listener running somewhere else is another program's or another checkout's
  // server: it does not use this checkout's state, so it only blocks the port.
  if(onSavedPort&&places.length&&!places.some(place=>place===root||place.startsWith(root+'/')))continue;
  if(onSavedPort||inCheckout){
   let command;try{command=await processName(row.pid,context);}catch(error){if(!uncheckedInspection(error))throw error;}
   return {pid:row.pid,command:command||'process',reason:onSavedPort?`saved local port ${port}`:'this checkout'};
  }
 }
}
