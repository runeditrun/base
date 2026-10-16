import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
export {assert,performance};
const execute=promisify(execFile);
export async function docker(...args){const result=await execute(process.env.DOCKER_BIN??'docker',args,{env:process.env,maxBuffer:4*1024*1024,timeout:120000});return(args[0]==='logs'?result.stdout+result.stderr:result.stdout).trim()}
export async function control(name,input){
 const child=execFile(process.env.DOCKER_BIN??'docker',['exec','-i',name,'node','/proof/control.mjs'],{env:process.env,maxBuffer:4*1024*1024,timeout:['export','import'].includes(input.operation)?600000:60000});child.stdin.end(JSON.stringify(input));
 return await new Promise((resolve,reject)=>{let out='',error='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>error+=x);child.on('error',reject);child.on('close',(code,signal)=>{if(code!==0)return reject(Error('Container diagnostic failed: '+(signal??error.slice(0,400))));try{resolve(JSON.parse(out));}catch{reject(Error('Container diagnostic returned an incomplete receipt'));}})});
}
export const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function wait(fn,label,{timeout=30000,interval=100}={}){
 const end=Date.now()+timeout;while(Date.now()<end){try{const value=await fn();if(value)return value}catch{}await delay(interval)}throw Error(label+' did not complete');
}
export function client(origin){
 let cookie='';
 const call=async(path,{method='GET',input,form,headers={}}={})=>{
  const response=await fetch(origin+path,{method,redirect:'manual',signal:AbortSignal.timeout(15000),headers:{origin,host:new URL(origin).host,...(cookie?{cookie}:{}),...(input!==undefined?{'content-type':'application/json'}:{}),...(form!==undefined?{'content-type':'application/x-www-form-urlencoded'}:{}),...headers},...(input!==undefined?{body:JSON.stringify(input)}:{}),...(form!==undefined?{body:new URLSearchParams(form)}:{})});
  return response;
 };
 return {origin,call,setCookie(response){const value=response.headers.get('set-cookie');assert.ok(value,'native session issued');cookie=value.split(';')[0]},get cookie(){return cookie}};
}
export async function json(client,path,init,status=200){const response=await client.call(path,init);assert.equal(response.status,status,path+' status');return response.json()}
export async function bootstrapAndOutbox(client,settings){
 const response=await client.call('/auth/bootstrap',{method:'POST',input:{token:settings.bindings.SETUP_TOKEN,displayName:'Spike Owner',returnTo:'/app'}});
 assert.equal(response.status,303,'first owner bootstrap');client.setCookie(response);
 const started=await client.call('/auth/magic-link',{method:'POST',input:{email:settings.bindings.OWNER_EMAIL,returnTo:'/app'}});
 assert.equal(started.status,202,'ordinary owner sign-in request');
 const headers={'x-rer-dev-key':settings.bindings.RER_DEV_KEY};
 const listing=await client.call('/__dev/outbox',{headers});assert.equal(listing.status,200,'public-port outbox');
 const detailPath=(await listing.text()).match(/href="([^\"]+\?message=[^\"]+)"/)?.[1];assert.ok(detailPath,'outbox contains mail');
 const detail=await client.call(detailPath.replaceAll('&amp;','&'),{headers});
 const linkText=(await detail.text()).match(/class="open" href="([^\"]+)"/)?.[1];assert.ok(linkText,'outbox contains native link');
 const link=new URL(linkText.replaceAll('&amp;','&'));
 assert.equal((await client.call(link.pathname+link.search)).status,200,'native link preview');
 const confirm=await client.call('/auth/confirm',{method:'POST',input:{token:link.searchParams.get('token')}});assert.equal(confirm.status,303,'native link confirmation');client.setCookie(confirm);
 const replay=await client.call('/auth/confirm',{method:'POST',input:{token:link.searchParams.get('token')}});assert.ok(replay.status>=400,'one-time token cannot be replayed');
 assert.equal((await client.call('/setup',{method:'POST',...(settings.seed==='default-seed'?{form:{confirm:'yes'}}:{})})).status,303,'first-run completion');
}
export function summary(samples){const sorted=[...samples].sort((a,b)=>a-b);return {n:sorted.length,p50_ms:sorted[Math.ceil(sorted.length*.5)-1],p95_ms:sorted[Math.ceil(sorted.length*.95)-1],max_ms:sorted.at(-1)}};
export async function sample(client,path,n=30){const values=[];for(let i=0;i<n;i++){const at=performance.now();const response=await client.call(path);assert.equal(response.status,200,path+' latency request');await response.arrayBuffer();values.push(performance.now()-at)}return summary(values)};
export async function memory(name){return Number(await docker('exec',name,'cat','/sys/fs/cgroup/memory.current'))/1024/1024};
