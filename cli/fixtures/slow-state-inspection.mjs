import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {promisify} from 'node:util';

// Only the process-inspection edge is synthetic; the public CLI, checkout,
// exclusive lock and application are real. Spend the deadline without sleeping.
const exec=cp.execFile,now=performance.now.bind(performance);
let elapsed=0,inspected=false;
performance.now=()=>now()+elapsed;
cp.execFile=(command,args,options,callback)=>{
 const stateQuery=command.endsWith('lsof')&&!args.some(arg=>arg.startsWith('-iTCP'))&&!args.includes('-d')&&!args.includes('-p');
 const linuxQuery=process.platform==='linux'&&command==='/bin/ps'&&args.includes('-axo');
 if(inspected||!stateQuery&&!linuxQuery)return exec(command,args,options,callback);
 inspected=true;elapsed+=20000;
 queueMicrotask(()=>callback(Object.assign(Error('inspection timed out'),{killed:true}),'',''));
};
cp.execFile[promisify.custom]=(command,args,options)=>new Promise((resolve,reject)=>cp.execFile(command,args,options,(error,stdout,stderr)=>error?reject(Object.assign(error,{stdout,stderr})):resolve({stdout,stderr})));
syncBuiltinESMExports();
