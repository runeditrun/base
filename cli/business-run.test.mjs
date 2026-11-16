import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {credentialHandle} from './business/state.mjs';

const base=resolve(import.meta.dirname,'..'),entry=join(base,'bin/rer.mjs');
const device='bz_device_synthetic-command-computer',secret='synthetic-scoped-command-secret',account='a'.repeat(32);
async function fixture(t, {fileBacked = false} = {}) {
 const home=await mkdtemp(join(base,'.business-connect-command-'));t.after(()=>rm(home,{recursive:true,force:true}));
 const state={issued:0,revocations:0,refuse:false,cleanupFails:false,expiryMs:900000,leases:new Map()};
 const server=createServer(async(req,res)=>{
  let text='';for await(const data of req)text+=data;
  const body=text?JSON.parse(text):{},root='/api/business/executors/cloudflare-token';
  const json=(status,value)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
  if(req.headers.authorization!=='Bearer '+device)return json(401,{error:'pairing refused'});
  if(req.url===root&&req.method==='POST'){
   state.issued++;if(state.refuse)return json(403,{error:secret});
   const lease={lease_id:body.lease_id,grant_id:body.grant_id,business_id:'business',executor_id:'computer',account_id:account,credential_expires_at:new Date(Date.now()+state.expiryMs).toISOString(),cleanup_status:'active',provider_credential_revoked:false};
   state.leases.set(lease.lease_id,lease);return json(200,{...lease,credential:secret});
  }
  const id=req.url.slice(root.length+1).split('/')[0],lease=state.leases.get(id);
  if(!lease)return json(404,{error:'no such command'});
  if(req.url.endsWith('/revoke')){state.revocations++;const updated={...lease,cleanup_status:state.cleanupFails?'unconfirmed':'revoked',provider_credential_revoked:!state.cleanupFails};state.leases.set(id,updated);return json(200,updated);}
  return json(200,lease);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 const origin=`http://127.0.0.1:${server.address().port}`;
 await mkdir(join(home,'.rer/business'),{recursive:true});
 await writeFile(join(home,'.rer/business/state.json'),JSON.stringify({origin,businessId:'business',executorId:'computer',credentialVersion:2}));
 const calls=join(home,'keychain-calls'); await writeFile(calls,'');
 const credentials=join(home,'credentials');
 if(fileBacked){await mkdir(credentials,{mode:0o700});await writeFile(join(credentials,`${credentialHandle(origin,'business').slice(7)}.credential`),device,{mode:0o600});}
 else await writeFile(join(home,'fake-keychain.json'),JSON.stringify({[credentialHandle(origin,'business')]:device}));
 const env={PATH:process.env.PATH,HOME:home,RER_NO_UPDATE_CHECK:'1',CI:'true',NODE_OPTIONS:`--import=${new URL('./fixtures/business/register.mjs',import.meta.url).pathname}`,
  CLOUDFLARE_API_TOKEN:'ambient-broad-token',CLOUDFLARE_ACCOUNT_ID:'f'.repeat(32),CF_API_TOKEN:'ambient-alias-token',RER_TEST_KEYCHAIN_CALLS:calls,...(fileBacked?{RER_BUSINESS_CREDENTIAL_DIR:credentials}:{})};
 const start=args=>{
  const child=spawn(process.execPath,[entry,'business',...args],{cwd:home,env,stdio:['pipe','pipe','pipe']});let stdout='',stderr='';
  child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);child.stdin.end();
  const result=once(child,'close').then(([code,signal])=>({code,signal,stdout,stderr}));
  return {child,result,output:()=>stdout+stderr};
 };
 const run=async command=>(await start(['run','--grant','grant-1','--',...command]).result);
 return {home,state,start,run,calls};
}

test('business run and cleanup use the private device credential file and mask its encoded forms without keychain access',async t=>{
 const f=await fixture(t,{fileBacked:true});
 const script=String.raw`const fs=require('node:fs'),path=require('node:path');const folder=process.env.RER_BUSINESS_CREDENTIAL_DIR;const device=fs.readFileSync(path.join(folder,fs.readdirSync(folder)[0]),'utf8');for(const value of [device,encodeURIComponent(device),Buffer.from(device).toString('hex'),Buffer.from(device).toString('base64'),Buffer.from(device).toString('base64url')]){process.stdout.write(value.slice(0,5));process.stdout.write(value.slice(5)+'\n');process.stderr.write(value+'\n');}console.log('COMMAND_OK');`;
 const result=await f.run([process.execPath,'-e',script]);
 assert.equal(result.code,0,result.stderr);assert.match(result.stdout,/COMMAND_OK/);assert.match(result.stderr,/cleanup: revoked/);
 for(const value of [device,Buffer.from(device).toString('hex'),Buffer.from(device).toString('base64'),Buffer.from(device).toString('base64url')])assert.ok(!(result.stdout+result.stderr).includes(value));
 const lease=[...f.state.leases.keys()][0];
 assert.equal((await f.start(['cleanup',lease,'--status']).result).code,0);
 assert.equal((await f.start(['cleanup',lease]).result).code,0);
 assert.equal(f.state.issued,1);assert.equal(await readFile(f.calls,'utf8'),'');
});

test('business run preserves arguments and exits, injects only the scoped child environment, masks split output and cleans success, failure and spawn errors',async t=>{
 const f=await fixture(t);
 const script=`const token=process.env.CLOUDFLARE_API_TOKEN; if(token!==${JSON.stringify(secret)}||process.env.CLOUDFLARE_ACCOUNT_ID!==${JSON.stringify(account)}||process.env.CF_API_TOKEN)process.exit(92); console.log(JSON.stringify(process.argv.slice(1))); process.stdout.write(token.slice(0,8)); setTimeout(()=>{process.stdout.write(token.slice(8));process.stderr.write(token.slice(0,11));setTimeout(()=>{process.stderr.write(token.slice(11));console.log(' finished');process.exit(Number(process.argv[1]));},10)},10);`;
 for(const code of [0,17]){
  const result=await f.run([process.execPath,'-e',script,String(code),'argument with spaces','--help','$(literal)','']);
  assert.equal(result.code,code,result.stderr);assert.equal(result.signal,null);
  assert.ok(result.stdout.includes(JSON.stringify([String(code),'argument with spaces','--help','$(literal)',''])));
  assert.match(result.stdout,/\[credential\]/);assert.match(result.stderr,/cleanup: revoked/);
  for(const value of [secret,account,device,'ambient-broad-token','ambient-alias-token'])assert.ok(!(result.stdout+result.stderr).includes(value));
 }
 const missing=await f.run(['/missing-command-for-business-run']);assert.equal(missing.code,127);assert.match(missing.stderr,/cleanup: revoked/);
 assert.equal(f.state.issued,3);assert.equal(f.state.revocations,3);
});

test('business run refuses unavailable authority without spawning or retrying and reports unconfirmed cleanup separately from the child exit',async t=>{
 const f=await fixture(t);f.state.refuse=true;
 let result=await f.run([process.execPath,'-e','console.log("SHOULD-NOT-RUN")']);
 assert.equal(result.code,1);assert.ok(!result.stdout.includes('SHOULD-NOT-RUN'));assert.ok(!result.stderr.includes(secret));assert.equal(f.state.issued,1);
 f.state.refuse=false;f.state.cleanupFails=true;
 result=await f.run([process.execPath,'-e','process.exit(23)']);assert.equal(result.code,23);assert.match(result.stderr,/cleanup: unconfirmed/);assert.match(result.stderr,/rer business cleanup [a-f0-9-]+/);
 const lease=[...f.state.leases.keys()][0];f.state.cleanupFails=false;
 const cleaned=await f.start(['cleanup',lease]).result;assert.equal(cleaned.code,0);assert.match(cleaned.stderr,/cleanup: revoked/);
 assert.equal(f.state.issued,2,'cleanup never reissues a credential');
});

test('business run forwards signals and enforces credential expiry, then revokes before exiting with the child signal',async t=>{
 const f=await fixture(t);
 for(const signal of ['SIGINT','SIGTERM']){
  const running=f.start(['run','--grant','grant-1','--',process.execPath,'-e','console.log("COMMAND_READY");setInterval(()=>{},1000)']);
  await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('child did not start')),15000);const see=()=>{if(running.output().includes('COMMAND_READY')){clearTimeout(timeout);running.child.stdout.off('data',see);resolve();}};running.child.stdout.on('data',see);see();});
  running.child.kill(signal);const result=await running.result;
  assert.equal(result.signal,signal);assert.match(result.stderr,/cleanup: revoked/);
 }
 f.state.expiryMs=1000;
 const expired=await f.run([process.execPath,'-e','setInterval(()=>{},1000)']);assert.equal(expired.signal,'SIGTERM');assert.match(expired.stderr,/cleanup: revoked/);
 assert.equal(f.state.revocations,3);
});

test('business run reaches the ordinary rer deploy dry-run child without live provider mutation',{timeout:300000},async t=>{
 const f=await fixture(t);
 const result=await f.run([process.execPath,entry,'deploy','--dry-run','--cwd',join(base,'default-seed'),'--json']);
 assert.equal(result.code,0,result.stderr+'\n'+result.stdout);
 const receipt=result.stdout.trim().split('\n').filter(Boolean).map(line=>{try{return JSON.parse(line);}catch{return null;}}).filter(Boolean).at(-1);
 assert.equal(receipt.ok,true);assert.equal(receipt.dryRun,true);assert.equal(receipt.deployed,false);assert.equal(receipt.providerChecked,false);
 assert.equal(f.state.issued,1);assert.equal(f.state.revocations,1);
 assert.ok(!(result.stdout+result.stderr).includes(secret));assert.match(result.stderr,/cleanup: revoked/);
});
