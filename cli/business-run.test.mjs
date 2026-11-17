import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {readFile} from 'node:fs/promises';
import {constants} from 'node:os';
import {fixture,base,entry,device,secret,account} from './fixtures/business/run-grant.mjs';

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
  const expiry=result.stderr.match(/Cloud credential expiry: (\S+) \((\d+) minutes? remaining\)/);
  assert.ok(expiry,'the caller sees its time limit');
  assert.equal(expiry[1],[...f.state.leases.values()].at(-1).credential_expires_at);
  assert.ok(Number(expiry[2])>0);assert.ok(Number(expiry[2])<=Math.ceil(f.state.expiryMs/60000));
  assert.ok(!result.stderr.includes('credential expired'));
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
  assert.equal(result.signal,signal);assert.match(result.stderr,/cleanup: revoked/);assert.ok(!result.stderr.includes('credential expired'));
 }
 f.state.expiryMs=1000;
 for(const childExit of [undefined,19]){
  const script=childExit===undefined?'setInterval(()=>{},1000)':`process.on('SIGTERM',()=>process.exit(${childExit}));setInterval(()=>{},1000)`;
  const expired=await f.run([process.execPath,'-e',script]);
  assert.equal(expired.signal,childExit===undefined?'SIGTERM':null);assert.equal(expired.code,childExit??null);
  assert.match(expired.stderr,/credential expired; run it again to resume/);
  const status=childExit??(128+constants.signals.SIGTERM);
  const reportedStatus=expired.stderr.match(/Caller exit status: (\d+)(?: \((\w+)\))?\./);
  assert.ok(reportedStatus);assert.equal(Number(reportedStatus[1]),status);
  assert.equal(reportedStatus[2],expired.signal??undefined);
  assert.match(expired.stderr,/cleanup: revoked/);
  for(const value of [secret,account,device])assert.ok(!(expired.stdout+expired.stderr).includes(value));
 }
 assert.equal(f.state.revocations,4);
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
