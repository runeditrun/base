import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, mkdir, stat, rm, symlink, link, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCommands } from './commands.mjs';
import { installationFailureMessage } from './failures.mjs';
import { privateDirectory, openPrivateLog, PRIVATE_LOG_LIMIT } from './private-files.mjs';

const execute=promisify(execFile);
async function workspace(t) {const root=await mkdtemp(join(tmpdir(),'output-safety-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
function childDouble() {
 const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.exitCode=null;child.signalCode=null;
 child.finish=code=>{child.exitCode=code;child.emit('exit',code,null);child.emit('close',code,null);};return child;
}

// All credentials below are invented here. Assertions never include environment
// values, raw child diagnostics, or secret-bearing subprocess error objects.
test('real child output is redacted in browser state, log, terminal and failure while flags and trusted status survive',async t=>{
 const root=await workspace(t),state={logs:[]};let terminal='';
 const store=await createCommands(root,state,{terminal:text=>{terminal+=text;}});t.after(()=>store.closeCommands());
 const environment={DATABASE_URL:'postgres://example-user:db-private-test-pass@db.invalid/database',STRIPE_KEY:'stripe-private-test-value',GITHUB_PAT:'github-private-test-value',key:'key-private-test-value',pat:'pat-private-test-value',dsn:'dsn-private-test-value',auth:'auth-private-test-value',pass:'pass-private-test-value',signature:'signature-private-test-value',sig:'sig-private-test-value',COOKIE_SECURE:'1',AUTH_ENABLED:'true'};
 const privateValues=Object.entries(environment).filter(([key])=>!['COOKIE_SECURE','AUTH_ENABLED'].includes(key)).map(([,value])=>value);
 const explicit='explicit-private / päss?';store.addSecrets(explicit);
 // Trusted numeric status stays readable; diagnostic path metadata is redacted
 // when it coincides with an explicitly registered credential.
 store.addSecrets(['40',root]);
 const body="for (const [key,value] of Object.entries(process.env)) if (!['COOKIE_SECURE','AUTH_ENABLED'].includes(key)) process.stdout.write(value+'\\n');"+
  `process.stdout.write(${JSON.stringify('BEFORE_MARKER\nhttps://user:test-unregistered-private-password@host.invalid/path\nAuthorization: Basic '+Buffer.from('private-basic:user-pass').toString('base64')+'\n-----BEGIN PRIVATE KEY-----\nTEST_PRIVATE_KEY_BODY\n-----END PRIVATE KEY-----\nhttps://host.invalid/?sig=query-private&safe=public\n'+Buffer.from(explicit).toString('base64')+'\n'+encodeURIComponent(explicit)+'\nbuild 1 of 10\nAFTER_MARKER\n')});process.exitCode=40;`;
 let failure;
 await assert.rejects(store.run('Capture',process.execPath,['--input-type=module','-e',body],{env:environment}),error=>{failure=error;return true;});
 const message=installationFailureMessage(failure),disk=await readFile(store.logPath,'utf8');
 for(const output of [JSON.stringify(state),disk,terminal,message]) {
  for(const value of [...privateValues,explicit,Buffer.from(explicit).toString('base64'),encodeURIComponent(explicit),'unregistered-private-password',Buffer.from('private-basic:user-pass').toString('base64'),'PRIVATE_KEY_BODY','query-private'])assert.ok(!output.includes(value),'private bytes escaped a command sink');
  assert.match(output,/BEFORE_MARKER/);assert.match(output,/AFTER_MARKER/);assert.match(output,/build 1 of 10/);
 }
 assert.match(message,/exit 40, signal none/);
 assert.ok(message.endsWith('Log: '+store.redact(store.logPath)));
 assert.equal(message.includes(root),false,'private path metadata escaped the diagnostic');
});

for(const code of ['EPIPE','EAGAIN'])test(`terminal ${code} does not interrupt capture and cleanup`,async t=>{
 const root=await workspace(t),state={logs:[]};let calls=0,terminal='',child;
 const store=await createCommands(root,state,{spawn:()=>child=childDouble(),terminal:text=>{calls++;if(calls===1)throw Object.assign(new Error('synthetic terminal error'),{code});terminal+=text;}});
 t.after(()=>store.closeCommands());const pending=store.run('Sink test','synthetic-command');
 child.stdout.write('FIRST_MARKER\n');child.stderr.write('FINAL_MARKER\n');child.finish(0);await pending;await store.closeCommands();
 assert.match(state.logs.join('\n'),/FINAL_MARKER/);assert.match(await readFile(store.logPath,'utf8'),/FINAL_MARKER/);
 if(code==='EPIPE'){assert.equal(calls,1);assert.equal(terminal,'');}else{assert.ok(calls>1);assert.match(terminal,/FINAL_MARKER/);}
});

test('real pipe reader exits while installer retains cleanup custody of its detached child',async t=>{
 const root=await workspace(t),marker=join(root,'cleanup.json');
 const producer="setInterval(()=>process.stdout.write('child output\\n'),10)";
 const source=`import { createCommands } from ${JSON.stringify(new URL('./commands.mjs',import.meta.url).href)};
 import { writeFile } from 'node:fs/promises';
 const store=await createCommands(${JSON.stringify(root)},{logs:[]});
 const child=store.spawn('Starting continuing child',process.execPath,['-e',${JSON.stringify(producer)}]);
 process.send({pid:child.pid});
 try {
 await new Promise(resolve=>process.once('message',resolve));
 // Observe output after the real stdout reader has closed. A child that fails
 // to parse cannot satisfy this evidence or impersonate successful cleanup.
 await new Promise((resolve,reject)=>{
  const exited=()=>reject(new Error('Fixture child exited before producing output'));
  child.once('close',exited);
  child.stdout.once('data',()=>{child.removeListener('close',exited);resolve();});
  if(child.exitCode!==null||child.signalCode!==null)exited();
 });
 const activeBeforeStop=child.exitCode===null&&child.signalCode===null;
 for(let index=0;index<20;index++)store.report('AFTER_READER_EXIT');
 await store.closeCommands();
 await writeFile(${JSON.stringify(marker)},JSON.stringify({pid:child.pid,activeBeforeStop,closed:child.exitCode!==null||child.signalCode!==null}));
 } finally { await store.closeCommands(); }`;
 const runner=spawn(process.execPath,['--input-type=module','-e',source],{stdio:['ignore','pipe','pipe','ipc']});
 const reader=spawn(process.execPath,['-e',"process.stdin.once('data',()=>process.exit(0));process.stdin.resume();"],{stdio:['pipe','ignore','pipe']});
 let runnerError='',appPid,cleanupConfirmed=false;runner.on('message',value=>{appPid=value.pid;});runner.stderr.on('data',chunk=>{runnerError+=chunk;});reader.stderr.resume();reader.stdin.on('error',()=>{});
 const runnerClosed=new Promise(resolve=>runner.once('close',(code,signal)=>resolve({code,signal})));
 const readerClosed=new Promise(resolve=>reader.once('close',code=>resolve(code)));
 const timeout=setTimeout(()=>{runner.kill('SIGKILL');reader.kill('SIGKILL');},15000);timeout.unref();
 t.after(async()=>{clearTimeout(timeout);if(runner.exitCode===null&&runner.signalCode===null)runner.kill('SIGKILL');if(reader.exitCode===null&&reader.signalCode===null)reader.kill('SIGKILL');await Promise.all([runnerClosed,readerClosed]);if(appPid&&!cleanupConfirmed){try{process.kill(process.platform==='win32'?appPid:-appPid,'SIGKILL');}catch{}}});
 runner.stdout.pipe(reader.stdin);assert.equal(await readerClosed,0);
 // Destroy the actual OS pipe's read end, then release the writer through IPC.
 runner.stdout.unpipe(reader.stdin);runner.stdout.destroy();runner.send('reader is closed');
 const result=await runnerClosed;assert.equal(result.code,0,'installer crashed after its stdout reader exited');assert.equal(runnerError.length,0,'installer emitted unexpected stderr');
 const receipt=JSON.parse(await readFile(marker,'utf8'));assert.equal(receipt.activeBeforeStop,true);assert.equal(receipt.closed,true);
 assert.throws(()=>process.kill(receipt.pid,0),error=>error.code==='ESRCH');
 cleanupConfirmed=true;
 assert.match(await readFile(join(root,'install.log'),'utf8'),/AFTER_READER_EXIT/);
});

test('private log starts a fresh session and caps output with exactly one marker',async t=>{
 const root=await workspace(t),path=join(root,'install.log');await writeFile(path,'OLD_SESSION_PRIVATE_OUTPUT',{mode:0o600});
 const log=await openPrivateLog(path);assert.equal(await readFile(path,'utf8'),'');
 const chunk='bounded output\n'.repeat(4096);
 for(let size=0;size<PRIVATE_LOG_LIMIT*2;size+=Buffer.byteLength(chunk))log.write(chunk);
 await log.close();const bytes=await readFile(path);
 assert.ok(bytes.length<=PRIVATE_LOG_LIMIT);assert.equal(bytes.toString().split('[log truncated]').length-1,1);assert.ok(!bytes.includes('OLD_SESSION_PRIVATE_OUTPUT'));
 assert.equal((await stat(path)).mode&0o777,0o600);
 const resumed=await openPrivateLog(path);resumed.write('NEW_SESSION\n');await resumed.close();assert.equal(await readFile(path,'utf8'),'NEW_SESSION\n');
});

test('100 MiB real command output stays within a small heap and bounded browser and disk logs',async t=>{
 const root=await workspace(t);
 // Serialize the producer once: a nested script string must retain its newline
 // escapes until the producer parses it, rather than inserting literal newlines.
 const producer="process.stdout.write(Buffer.alloc(100*1024*1024,120));process.stdout.write('\\nFINAL_MARKER\\n')";
 const source=`import { createCommands } from ${JSON.stringify(new URL('./commands.mjs',import.meta.url).href)};
 import { stat, readFile } from 'node:fs/promises';
 const state={logs:[]};let terminalBytes=0;
 const store=await createCommands(${JSON.stringify(root)},state,{terminal:text=>{terminalBytes+=text.length;}});
 try { await store.run('Large output',process.execPath,['-e',${JSON.stringify(producer)}],{env:{}}); }
 finally { await store.closeCommands(); }
 const log=await readFile(store.logPath);
 process.stdout.write(JSON.stringify({bytes:(await stat(store.logPath)).size,markers:log.toString().split('[log truncated]').length-1,pageBytes:state.logs.join('\\n').length,lines:state.logs.length,final:state.logs.join('\\n').includes('FINAL_MARKER'),terminalBytes}));`;
 let result;
 try{result=await execute(process.execPath,['--max-old-space-size=64','--input-type=module','-e',source],{timeout:60000,maxBuffer:4096});}
 catch(error){assert.fail(`bounded-output subprocess failed (code ${error.code ?? 'none'}, signal ${error.signal ?? 'none'}, killed ${error.killed ?? false})`);}
 const receipt=JSON.parse(result.stdout);assert.ok(receipt.bytes<=PRIVATE_LOG_LIMIT);assert.equal(receipt.markers,1);assert.ok(receipt.pageBytes<=65536);assert.ok(receipt.lines<=400);assert.equal(receipt.final,true);assert.ok(receipt.terminalBytes>=100*1024*1024);
});

for(const existing of [false,true])test(`private directory self-ignore covers ${existing?'existing':'new'} .seed storage`,async t=>{
 const root=await workspace(t);if(existing){await mkdir(join(root,'.seed'));await writeFile(join(root,'.seed/.gitignore'),'old rules\n');}
 const path=await privateDirectory(root,['.seed','installer']);
 assert.equal(path,join(root,'.seed/installer'));assert.equal(await readFile(join(root,'.seed/.gitignore'),'utf8'),'*\n');assert.equal((await stat(join(root,'.seed'))).mode&0o777,0o700);
});

for(const kind of ['symlink','hardlink'])test(`self-ignore refuses a permissive ${kind} without modifying its target`,async t=>{
 const root=await workspace(t),target=join(root,'target');await mkdir(join(root,'.seed'));await writeFile(target,'UNCHANGED',{mode:0o644});
 await (kind==='symlink'?symlink:link)(target,join(root,'.seed/.gitignore'));
 await assert.rejects(privateDirectory(root,['.seed']));assert.equal(await readFile(target,'utf8'),'UNCHANGED');assert.equal((await stat(target)).mode&0o777,0o644);
});

test('self-ignore replaces an owned private hardlink without mutating its other name',async t=>{
 const root=await workspace(t),target=join(root,'target');await mkdir(join(root,'.seed'));await writeFile(target,'UNCHANGED',{mode:0o600});await link(target,join(root,'.seed/.gitignore'));
 await privateDirectory(root,['.seed']);assert.equal(await readFile(target,'utf8'),'UNCHANGED');assert.equal(await readFile(join(root,'.seed/.gitignore'),'utf8'),'*\n');
});

test('log revalidates replacement links before appending or changing permissions',async t=>{
 const root=await workspace(t),target=join(root,'target'),path=join(root,'install.log');await writeFile(target,'UNCHANGED',{mode:0o644});
 for(const createLink of [symlink,link]) {
  const log=await openPrivateLog(path);await rm(path);await createLink(target,path);
  assert.throws(()=>log.write('NEW_OUTPUT'));await log.close();assert.equal(await readFile(target,'utf8'),'UNCHANGED');assert.equal((await stat(target)).mode&0o777,0o644);await rm(path);
 }
 // Even a private hardlink must not be truncated at the next session start.
 await chmod(target,0o600);await link(target,path);await assert.rejects(openPrivateLog(path),/hard links/);assert.equal(await readFile(target,'utf8'),'UNCHANGED');
});
