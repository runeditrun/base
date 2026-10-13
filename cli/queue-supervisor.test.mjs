import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {access,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {isolatedQueue} from './fixtures/queue.mjs';
import {processInfo} from '../modules/job-queue/processes.mjs';

const entry=fileURLToPath(new URL('../bin/rer.mjs',import.meta.url));
const gone=async pid=>{const info=await processInfo(pid);return !info||info.zombie;};
async function until(probe,message){for(let i=0;i<1200;i++){const value=await probe();if(value)return value;await delay(25);}throw Error(message);}

// A heavy command whose job supervisor dies (as on a loaded runner) must not
// leave its client waiting on output pipes the job's own processes still hold.
test('a rer command whose job supervisor is killed ends with one message, no lease, socket or job process', async t => {
 const root=await mkdtemp(join(tmpdir(),'rer-dead-supervisor-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const env=await isolatedQueue(t,{...process.env,RER_JOBS_SLOTS:'1'});delete env.CI;
 await writeFile(join(root,'OPERATIONS.json'),JSON.stringify({version:2,project:'example/dead-supervisor',runtime:{requirements:[]},requiredEnvironment:[],
  commands:{verify:{argv:[process.execPath,'task.mjs'],inputs:['task.mjs'],effects:'Runs until stopped.'}}}));
 await writeFile(join(root,'task.mjs'),"import {writeFileSync} from 'node:fs';writeFileSync('task.pid',String(process.pid));setInterval(()=>{},1000);\n");
 const client=spawn(process.execPath,[entry,'verify','--json'],{cwd:root,env,stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';client.stdout.on('data',chunk=>stdout+=chunk);client.stderr.on('data',chunk=>stderr+=chunk);
 const closed=new Promise(resolve=>client.once('close',code=>resolve(code)));
 let task;
 t.after(async()=>{if(client.exitCode===null)client.kill('SIGKILL');if(task&&!await gone(task))process.kill(task,'SIGKILL');});
 const statePath=join(env.RER_JOBS_DIR,'state.json');
 task=Number(await until(()=>readFile(join(root,'task.pid'),'utf8').catch(()=>null),'task never started'));
 const job=JSON.parse(await readFile(statePath,'utf8')).running[0];
 assert.ok(job.owner.marker,'the lease names its supervisor');
 process.kill(job.owner.pid,'SIGKILL');
 const code=await Promise.race([closed,delay(30000).then(()=>'still waiting 30s after its supervisor was killed')]);
 assert.notEqual(code,0);assert.equal(typeof code,'number',String(code));
 assert.match(stderr,new RegExp(`${job.label.replace(/[[\]]/g,'\\$&')}: the job's supervisor ended before the job finished`));
 assert.equal(JSON.parse(stdout.trim().split('\n').at(-1)).ok,false);
 assert.deepEqual(JSON.parse(await readFile(statePath,'utf8')).running,[]);
 await assert.rejects(access(job.owner.socket),{code:'ENOENT'});
 assert.ok(await until(()=>gone(task),'the job process survived its supervisor'));
});
