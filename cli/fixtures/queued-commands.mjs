import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const entry=fileURLToPath(new URL('../../bin/rer.mjs',import.meta.url));

export async function queuedCommands(t) {
 const root=await mkdtemp(join(tmpdir(),'rer-queue-policy-')),children=new Set();
 t.after(async()=>{for(const child of children){if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await child.done;}await rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:100});});
 const environment={...process.env,RER_JOBS_DIR:join(root,'jobs'),RER_JOBS_SLOTS:'1',RER_JOBS_LOAD_THRESHOLD:'100000',RER_JOBS_MIN_FREE_MEMORY_BYTES:'0'};
 delete environment.CI;delete environment.RER_JOB_POLICY;delete environment.RER_JOB_MEMBERSHIP;
 const commands=Object.fromEntries(['install','setup','build','verify','deploy','export','import'].map(verb=>[verb,{argv:[process.execPath,'task.mjs',verb],inputs:['task.mjs'],effects:'Records real queue ownership for this independent command.'}]));
 await writeFile(join(root,'OPERATIONS.json'),JSON.stringify({version:2,project:'example/queue-policy',runtime:{requirements:[]},requiredEnvironment:[],commands}));
 await writeFile(join(root,'task.mjs'),`
import {appendFile} from 'node:fs/promises';import {spawnSync} from 'node:child_process';
import {callerPolicy} from ${JSON.stringify(new URL('../../modules/job-queue/policy.mjs',import.meta.url).href)};
import {liveMembership} from ${JSON.stringify(new URL('../../modules/job-queue/membership.mjs',import.meta.url).href)};
const policy=await callerPolicy(),member=await liveMembership();
await appendFile('observed.jsonl',JSON.stringify({verb:process.argv[2],ci:policy.ci,member:member?.id,label:member?.label})+'\\n');
if(process.argv[2]==='verify'){
 const child=spawnSync(process.execPath,[${JSON.stringify(entry)},'build','--json'],{env:{...process.env,CI:'true'},encoding:'utf8'});
 if(child.status!==0)process.exitCode=19;
 const denied=spawnSync(process.execPath,[${JSON.stringify(entry)},'build','--no-queue','--json'],{env:{...process.env,CI:'true'},encoding:'utf8'});
 if(denied.status!==(policy.ci?0:2))process.exitCode=21;
}
await policy.close();
`);
 async function run(verb,{ci,noQueue=false,invalid=false}={}){
  t.signal.throwIfAborted();
  const env={...environment,...(ci===undefined?{}:{CI:ci}),...(invalid?{RER_JOB_POLICY:'{}',RER_JOB_MEMBERSHIP:'{}'}:{})};
  const child=spawn(process.execPath,[entry,verb,...(noQueue?['--no-queue']:[]),'--json'],{cwd:root,env,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
  children.add(child);child.done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  const abort=()=>child.kill('SIGTERM');t.signal.addEventListener('abort',abort,{once:true});
  let code;try{code=await child.done;}finally{t.signal.removeEventListener('abort',abort);}
  const events=stdout.trim().split('\n').filter(Boolean).map(JSON.parse);assert.equal(events.filter(event=>event.event==='result').length,1);
  return {code,events,stderr};
 }
 for(const ci of [undefined,'false']){
  assert.equal((await run('verify',{ci})).code,0);
  const rows=(await readFile(join(root,'observed.jsonl'),'utf8')).trim().split('\n').map(JSON.parse).slice(-2);
  assert.deepEqual(rows.map(row=>row.verb),['verify','build']);assert.ok(rows.every(row=>row.ci===false&&row.member));assert.equal(rows[0].member,rows[1].member);assert.ok(rows[0].label.includes('verify'));
 }
 for(const verb of ['install','setup','deploy','export','import']) {
  assert.equal((await run(verb)).code,0);
  const row=(await readFile(join(root,'observed.jsonl'),'utf8')).trim().split('\n').map(JSON.parse).at(-1);
  assert.equal(row.verb,verb); assert.ok(row.member,'public heavy command owns live queue admission');
 }
 const state=JSON.parse(await readFile(join(root,'jobs/state.json'),'utf8'));
 assert.deepEqual(state.running,[]); assert.deepEqual(state.queued,[]);
 assert.equal((await run('build',{noQueue:true})).code,2);
 assert.equal((await run('build',{ci:'true',noQueue:true,invalid:true})).code,2);
 assert.equal((await run('build',{ci:'true',invalid:true})).code,0);
 const invalid=(await readFile(join(root,'observed.jsonl'),'utf8')).trim().split('\n').map(JSON.parse).at(-1);assert.ok(invalid.member);assert.equal(invalid.ci,false);
 await rm(join(root,'jobs'),{recursive:true});
 assert.equal((await run('verify',{ci:'true',noQueue:true})).code,0);
 assert.ok(!(await readdir(root)).includes('jobs'),'original CI skips queue state');
 const ciRows=(await readFile(join(root,'observed.jsonl'),'utf8')).trim().split('\n').map(JSON.parse).slice(-3);assert.ok(ciRows.every(row=>row.ci===true&&!row.member));
}
