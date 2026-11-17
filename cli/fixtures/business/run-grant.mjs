import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {credentialHandle} from '../../business/state.mjs';

export const base=resolve(import.meta.dirname,'../../..'),entry=join(base,'bin/rer.mjs');
export const device='bz_device_synthetic-command-computer',secret='synthetic-scoped-command-secret',account='a'.repeat(32);
export async function fixture(t, {fileBacked = false} = {}) {
 const home=await mkdtemp(join(base,'.business-connect-command-'));t.after(()=>rm(home,{recursive:true,force:true}));
 const state={issued:0,revocations:0,refuse:false,cleanupFails:false,expiryMs:900000,leases:new Map(),credentials:new Map()};
 const server=createServer(async(req,res)=>{
  let text='';for await(const data of req)text+=data;
  const body=text?JSON.parse(text):{},root='/api/business/executors/cloudflare-token';
  const json=(status,value)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
  if(req.headers.authorization!=='Bearer '+device)return json(401,{error:'pairing refused'});
  if(req.url===root&&req.method==='POST'){
   state.issued++;if(state.refuse)return json(403,{error:`The owner has not approved this command. ${secret}`,credential:secret});
   if(state.answer)return json(state.answer.status,{...state.answer.body,lease_id:body.lease_id,grant_id:body.grant_id});
   const lease={lease_id:body.lease_id,grant_id:body.grant_id,business_id:'business',executor_id:'computer',account_id:account,credential_expires_at:new Date(Date.now()+state.expiryMs).toISOString(),cleanup_status:'active',provider_credential_revoked:false};
   const credential=state.credential??secret;
   state.leases.set(lease.lease_id,lease);state.credentials.set(lease.lease_id,credential);return json(200,{...lease,credential});
  }
  const id=req.url.slice(root.length+1).split('/')[0],lease=state.leases.get(id);
  if(state.cleanupRefusal)return json(state.cleanupRefusal.status,state.cleanupRefusal.body);
  if(!lease)return json(404,{error:'no such command'});
  if(req.url.endsWith('/revoke')){state.revocations++;const updated={...lease,cleanup_status:state.cleanupFails?'unconfirmed':'revoked',provider_credential_revoked:!state.cleanupFails};state.leases.set(id,updated);return json(200,updated);}
  return json(200,lease);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 const origin=`http://127.0.0.1:${server.address().port}`;
 await mkdir(join(home,'.rer/business'),{recursive:true});
 await writeFile(join(home,'.rer/business/state.json'),JSON.stringify({origin,businessId:'business',executorId:'computer',credentialVersion:2}));
 const calls=join(home,'keychain-calls');await writeFile(calls,'');
 const credentials=join(home,'credentials');
 if(fileBacked){await mkdir(credentials,{mode:0o700});await writeFile(join(credentials,`${credentialHandle(origin,'business').slice(7)}.credential`),device,{mode:0o600});}
 else await writeFile(join(home,'fake-keychain.json'),JSON.stringify({[credentialHandle(origin,'business')]:device}));
 const env={PATH:process.env.PATH,HOME:home,RER_NO_UPDATE_CHECK:'1',CI:'true',NODE_OPTIONS:`--import=${new URL('./register.mjs',import.meta.url).pathname}`,
  CLOUDFLARE_API_TOKEN:'ambient-broad-token',CLOUDFLARE_ACCOUNT_ID:'f'.repeat(32),CF_API_TOKEN:'ambient-alias-token',RER_TEST_KEYCHAIN_CALLS:calls,...(fileBacked?{RER_BUSINESS_CREDENTIAL_DIR:credentials}:{})};
 const start=(args,{env:additional={}}={})=>{
  const child=spawn(process.execPath,[entry,'business',...args],{cwd:home,env:{...env,...additional},stdio:['pipe','pipe','pipe']});let stdout='',stderr='';
  child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);child.stdin.end();
  const result=once(child,'close').then(([code,signal])=>({code,signal,stdout,stderr}));
  return {child,result,output:()=>stdout+stderr};
 };
 const run=async (command,options)=>(await start(['run','--grant','grant-1','--',...command],options).result);
 return {home,state,start,run,calls};
}

