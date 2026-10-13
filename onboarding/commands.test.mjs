import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp,readFile,stat,rm,symlink,writeFile,link } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCommands } from './commands.mjs';
import { createRedaction } from './redaction.mjs';
import { createSecretVault } from './secrets.mjs';
import { installationFailureMessage } from './failures.mjs';
import { randomBytes } from 'node:crypto';

function fakeChild(){const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.exitCode=null;child.signalCode=null;child.finish=(code=0,signal=null)=>{child.exitCode=code;child.signalCode=signal;child.emit('exit',code,signal);child.emit('close',code,signal);};return child;}
async function fixture(t,spawn){const root=await mkdtemp(join(tmpdir(),'commands-'));const state={logs:[]};let terminal='';const store=await createCommands(root,state,{spawn,terminal:text=>{terminal+=text;}});t.after(async()=>{await store.closeCommands();await rm(root,{recursive:true,force:true});});return {root,state,store,terminal:()=>terminal};}
function clock(){let time=0,timers=[];return {now:()=>time,wait:(ms,signal)=>new Promise(resolve=>{const entry={at:time+ms,resolve};timers.push(entry);const abort=()=>{timers=timers.filter(timer=>timer!==entry);resolve();};signal?.addEventListener('abort',abort,{once:true});entry.cleanup=()=>signal?.removeEventListener('abort',abort);}),async advance(ms){time+=ms;for(const entry of [...timers])if(entry.at<=time){timers=timers.filter(timer=>timer!==entry);entry.cleanup();entry.resolve();}for(let n=0;n<20;n++)await Promise.resolve();},get pending(){return timers.length;}};}

test('command capture strips ANSI and all split credentials and preserves final close output',async t=>{
 let child;const f=await fixture(t,()=>child=fakeChild());
 const secrets=['VAULT_SECRET_123','INVALIDATED_SECRET_456','DIRECT_NESTED_KEY_789','SESSION_TOKEN_ABC'];
 f.store.addSecrets(secrets);
 const result=f.store.run('Build application','unused',['argv-never-printed'],{env:{MY_TOKEN:'TEST_ENV_SECRET_ABC'}});
 child.stdout.write('\x1b[');child.stdout.write('31mFirst line\x1b[0m\n');
 for(const secret of [...secrets,'TEST_ENV_SECRET_ABC','ghp_FOO123456','sk-proj-XYZ987654']){for(const character of secret)child.stderr.write(character);child.stderr.write('\n');}
 child.exitCode=40;child.emit('exit',40,null);child.stderr.write('real final output after exit\n');child.emit('close',40,null);
 let error;await assert.rejects(result,value=>{error=value;return true;});
 const message=installationFailureMessage(error),disk=await readFile(f.store.logPath,'utf8');
 for(const text of [JSON.stringify(f.state),disk,f.terminal(),message]){for(const secret of [...secrets,'TEST_ENV_SECRET_ABC','ghp_FOO123456','sk-proj-XYZ987654','argv-never-printed'])assert.ok(!text.includes(secret));assert.ok(!text.includes('\x1b'));}
 assert.match(message,/Build application: exit 40, signal none/);assert.match(message,/real final output after exit/);assert.match(message,/Log:/);assert.match(disk,/First line/);
 error.message='UNTRUSTED';assert.equal(installationFailureMessage(error),message);
 assert.equal((await stat(f.store.logPath)).mode&0o777,0o600);
});

test('redaction registry retains omitted and cleared vault secrets',()=>{
 const redaction=createRedaction();const vault=createSecretVault({fields:{token:{valid:()=>true}},secretScopes:{token:['name']}},redaction.addSecrets);
 vault.set({token:'old-secret'},{name:'old'});vault.set({token:'new-secret'},{name:'new'});vault.clear();
 assert.equal(redaction.redact('old-secret new-secret'),'[REDACTED] [REDACTED]');
});

test('stream and page memory remain bounded for huge lines and token tails',async t=>{
 const redaction=createRedaction();redaction.addSecrets('planted-secret');let result='';const stream=redaction.stream(text=>{result+=text;});
 stream.write('ghp_'+ 'A'.repeat(300000));assert.ok(stream.bufferedLength<17000);stream.write('TAIL_MUST_NOT_APPEAR\nplanted-');stream.write('secret\n');stream.end();
 assert.ok(!result.includes('TAIL_MUST_NOT_APPEAR'));assert.ok(!result.includes('planted-secret'));assert.ok(result.length<1000);
 let child;const f=await fixture(t,()=>child=fakeChild());const running=f.store.run('Output','unused');child.stdout.write('plain output '.repeat(30000));child.finish();await running;
 assert.ok(f.state.logs.join('\n').length<=65536);assert.ok(f.state.logs.length<=400);assert.match(f.terminal(),/plain output/);
});

for(const kind of ['symlink','hardlink'])test(`log refuses permissive ${kind} without touching target`,async t=>{
 const root=await mkdtemp(join(tmpdir(),'log-link-'));t.after(()=>rm(root,{recursive:true,force:true}));const target=join(root,'target');await writeFile(target,'preserve',{mode:0o644});await (kind==='symlink'?symlink:link)(target,join(root,'install.log'));
 await assert.rejects(createCommands(root,{logs:[]},{terminal:()=>{}}));assert.equal(await readFile(target,'utf8'),'preserve');assert.equal((await stat(target)).mode&0o777,0o644);
});

test('150-second readiness succeeds after soft progress without stopping child',async t=>{
 const f=await fixture(t),child=fakeChild(),time=clock();f.store.track('Start',child);
 const ready=f.store.waitForReady('Start',child,()=>time.now()>=150000?true:{ready:false,message:'HTTP 503'},{...time,intervalMs:1000});
 await time.advance(0);for(let n=0;n<150;n++)await time.advance(1000);assert.equal(await ready,true);assert.equal(child.exitCode,null);assert.match(f.state.logs.join('\n'),/Still starting \(149 s\)/);child.finish();
});

test('child exit at 40 seconds wins even during a hung health probe and includes final output',async t=>{
 const f=await fixture(t),child=fakeChild(),time=clock();f.store.track('Start',child);
 const ready=f.store.waitForReady('Start',child,()=>new Promise(()=>{}),{...time});
 const failed=assert.rejects(ready,error=>/exit 40/.test(installationFailureMessage(error))&&/last output/.test(installationFailureMessage(error)));
 await time.advance(40000);child.stderr.write('last output');child.finish(40);await failed;assert.equal(time.now(),40000);assert.equal(time.pending,0);
});

test('hard limit names last health and cancellation interrupts an in-flight probe',async t=>{
 const f=await fixture(t),child=fakeChild(),time=clock();f.store.track('Start',child);
 const ready=f.store.waitForReady('Start',child,()=>({ready:false,message:'HTTP 503 waiting for migration'}),{...time,timeoutMs:900000});
 const failed=assert.rejects(ready,error=>/deadline exceeded.*Last health: HTTP 503 waiting for migration/s.test(installationFailureMessage(error)));
 await time.advance(0);await time.advance(900000);await failed;assert.equal(child.exitCode,null);
 const abort=new AbortController();const pending=f.store.waitForReady('Start',child,()=>new Promise(()=>{}),{...time,signal:abort.signal});const cancelled=assert.rejects(pending,error=>/cancelled/.test(installationFailureMessage(error)));abort.abort();await cancelled;assert.equal(time.pending,0);child.finish();
});

test('short newline output streams before child close while multiline secrets stay private',async t=>{
 let child;const f=await fixture(t,(_command,_args,options)=>{assert.equal(options.shell,false);return child=fakeChild();});
 f.store.addSecrets(['first secret line\nsecond secret line','hello\rworld']);
 const running=f.store.run('Streaming','unused',[],{shell:true});
 child.stdout.write('early progress\n');assert.match(f.state.logs.join('\n'),/early progress/);assert.match(await readFile(f.store.logPath,'utf8'),/early progress/);
 child.stdout.write('first secret line\n');assert.ok(!f.terminal().includes('first secret line'));
 child.stdout.write('second secret line\nhello\rworld\n');child.finish();await running;
 assert.ok(!f.terminal().includes('first secret line'));assert.ok(!f.terminal().includes('hello'));
});

test('soft progress continues while a health probe hangs',async t=>{
 const f=await fixture(t),child=fakeChild(),time=clock(),abort=new AbortController();f.store.track('Start',child);
 const ready=f.store.waitForReady('Start',child,()=>new Promise(()=>{}),{...time,signal:abort.signal});const failed=assert.rejects(ready,/cancelled/);
 await time.advance(30000);assert.match(f.state.logs.join('\n'),/Still starting \(30 s\)/);await time.advance(20000);assert.match(f.state.logs.join('\n'),/Still starting \(50 s\)/);
 abort.abort();await failed;child.finish();
});

test('known provider token patterns stay redacted across character and buffer boundaries',()=>{
 const redaction=createRedaction();let output='';const stream=redaction.stream(text=>{output+=text;});
 const tokens=['SG.TEST_PLANTED_SENDGRID_PART.ONE_SECRET_PART','sk_live_TEST_PLANTED_STRIPE_KEY','sk_test_PLANTED_STRIPE_KEY','whsec_PLANTED_WEBHOOK','xoxb-TEST-PLANTED-SLACK-TOKEN','AKIATEST_PLANTED_AWS_ACCESS_ID','ASIATEST_PLANTED_SESSION_ID','AIzaTEST_PLANTED_GOOGLE_KEY','npm_PLANTEDTOKEN','glpat-PLANTEDTOKEN','eyJhbGciOiJIUzI1NiJ9.PLANTEDPAYLOAD.SIGNATURE'];
 stream.write('prefix '.repeat(100));
 for(const token of tokens){for(const char of token)stream.write(char);stream.write('\n');}
 stream.write('{"api_key":"TEST_PLANTED_JSON_KEY"}\n');stream.end();
 for(const token of [...tokens,'TEST_PLANTED_JSON_KEY'])assert.ok(!output.includes(token));assert.match(output,/prefix/);
});

test('readiness fails immediately on a child error without displaying its private error text',async t=>{
 const f=await fixture(t),child=fakeChild(),time=clock();f.store.track('Start',child);
 const ready=f.store.waitForReady('Start',child,()=>new Promise(()=>{}),{...time});
 const failed=assert.rejects(ready,error=>/could not start/.test(installationFailureMessage(error))&&!installationFailureMessage(error).includes('private spawn error'));
 child.emit('error',new Error('private spawn error'));await failed;assert.equal(time.now(),0);child.finish(1);
});

test('shared sinks redact a credential split between stdout and stderr',async t=>{
 let child;const f=await fixture(t,()=>child=fakeChild());const secret='split-across-both-descriptors-test';f.store.addSecrets(secret);
 const pending=f.store.run('Capture','unused');child.stdout.write(secret.slice(0,12));child.stderr.write(secret.slice(12)+'\n');child.finish(1);
 let failure;await assert.rejects(pending,error=>{failure=error;return true;});
 for(const text of [f.terminal(),f.state.logs.join('\n'),await readFile(f.store.logPath,'utf8'),installationFailureMessage(failure)])assert.ok(!text.includes(secret));
});

test('append log refuses an already-private hardlink rather than modifying its other name',async t=>{
 const root=await mkdtemp(join(tmpdir(),'log-private-link-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const target=join(root,'private-target');await writeFile(target,'preserve',{mode:0o600});await link(target,join(root,'install.log'));
 await assert.rejects(createCommands(root,{logs:[]},{terminal:()=>{}}),/hard links/);assert.equal(await readFile(target,'utf8'),'preserve');
});

test('an already-cancelled attempt never starts its command',async t=>{
 let calls=0;const f=await fixture(t,()=>{calls++;return fakeChild();});const abort=new AbortController();abort.abort();
 await assert.rejects(f.store.run('Cancelled','unused',[],{signal:abort.signal}),/cancelled/);
 f.store.setCommandSignal(abort.signal);assert.throws(()=>f.store.spawn('Cancelled','unused'),/cancelled/);assert.equal(calls,0);
});

test('exit diagnostics snapshot buffered output without flushing a partial held credential',async t=>{
 const f=await fixture(t),child=fakeChild(),secret='HELD_CREDENTIAL_ACROSS_EXIT_TEST';
 f.store.addSecrets(secret);f.store.track('Starting application',child);
 const pending=f.store.waitForReady('Starting application',child,()=>new Promise(()=>{}),{timeoutMs:1000,intervalMs:5});
 let failure;const rejected=assert.rejects(pending,error=>{failure=error;return true;});
 child.stdout.write('\x1b[31mBuffered output\x1b[0m '+secret.slice(0,12));child.exitCode=40;child.emit('exit',40,null);
 try {
  await rejected;
  const message=installationFailureMessage(failure);assert.match(message,/exit 40/);assert.match(message,/Buffered output/);assert.match(message,/\[REDACTED\]/);
  for(const text of [message,f.terminal(),f.state.logs.join('\n'),await readFile(f.store.logPath,'utf8')]){assert.ok(!text.includes(secret.slice(0,12)));assert.ok(!text.includes('\x1b'));}
  child.stderr.write(secret.slice(12)+'\n');child.emit('close',40,null);
  for(const text of [f.terminal(),f.state.logs.join('\n'),await readFile(f.store.logPath,'utf8')]){assert.match(text,/Buffered output/);assert.ok(!text.includes(secret));assert.ok(!text.includes(secret.slice(12)));}
 } finally { child.emit('close',40,null); }
});

test('a buffered snapshot masks overlapping complete and incomplete held secrets',()=>{
 const redaction=createRedaction();redaction.addSecrets(['complete-private-value','private-value-continues']);
 let output='';const stream=redaction.stream(text=>{output+=text;});stream.write('complete-private-value');
 assert.equal(stream.snapshot(),'[REDACTED]');assert.equal(output,'');
 stream.write('-continues\n');stream.end();assert.equal(output,'[REDACTED]\n');
});

test('provider prefix matching preserves pnpm diagnostics and still masks actual and held tokens',()=>{
 const redaction=createRedaction(),held='literal-held-inside-identifier';redaction.addSecrets(held);
 let output='';const stream=redaction.stream(text=>{output+=text;});
 const tokens=['npm_TEST_PLANTED_AUTH_VALUE','ghp_TEST_PLANTED_GITHUB_VALUE','sk-proj-TEST_PLANTED_OPENAI_VALUE','SG.TEST_PLANTED_SENDGRID.VALUE'];
 for(const character of 'ERR_PNPM_OUTDATED_LOCKFILE\n'+tokens.join('\n')+'\nIDENTIFIER_'+held+'_SUFFIX\n')stream.write(character);
 stream.end();assert.match(output,/ERR_PNPM_OUTDATED_LOCKFILE/);
 for(const token of [...tokens,held])assert.ok(!output.includes(token));assert.match(output,/IDENTIFIER_\[REDACTED\]_SUFFIX/);
});

test('a snapshot keeps a partial JWT private until its signature arrives',()=>{
 const redaction=createRedaction();let output='';const stream=redaction.stream(text=>{output+=text;});
 stream.write('Last response eyJhbGciOiJIUzI1NiJ9.PRIVATEPAYLOAD');
 assert.equal(stream.snapshot(),'Last response [REDACTED]');assert.equal(output,'');
 stream.write('.PRIVATESIGNATURE\n');stream.end();assert.equal(output,'Last response [REDACTED]\n');
});

test('closing a command after a buffered credential prefix keeps every sink private',async t=>{
 let child;const f=await fixture(t,()=>child=fakeChild());
 const secret=randomBytes(32).toString('hex'),partial=secret.slice(0,24);f.store.addSecrets(secret);
 const pending=f.store.run('Interrupted credential output','unused');
 child.stdout.write('Useful final diagnostic '+partial);child.finish(40);
 let failure;await assert.rejects(pending,error=>{failure=error;return true;});
 for(const output of [f.terminal(),f.state.logs.join('\n'),await readFile(f.store.logPath,'utf8'),installationFailureMessage(failure)]){
  assert.ok(output.includes('Useful final diagnostic'));
  assert.ok(output.includes('[REDACTED]'));
  assert.ok(!output.includes(partial),'a truncated held credential escaped redaction at close');
 }
});

test('supervisor exit during descendant cancellation succeeds only after the owned group disappears', async t=>{
 const f=await fixture(t);
 // Reparenting must never turn the fixture's supervisor signal into a signal
 // to the host/container init process.
 const leaf="const supervisor=Number(process.argv[1]);process.on('SIGTERM',()=>{if(process.ppid===supervisor)process.kill(supervisor,'SIGTERM')});console.log('LEAF_READY '+process.pid);setInterval(()=>{},1000)";
 const parent="require('node:child_process').spawn(process.execPath,['-e',"+JSON.stringify(leaf)+",String(process.pid)],{stdio:'inherit'});setInterval(()=>{},1000)";
 const child=f.store.spawn('Supervisor fixture',process.execPath,['-e',parent]);
 const deadline=Date.now()+10000;
 while(!f.terminal().includes('LEAF_READY')&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
 const pid=Number(/LEAF_READY (\d+)/.exec(f.terminal())?.[1]);assert.ok(pid);
 await f.store.stop(child);
 for(const owned of [child.pid,pid])assert.throws(()=>process.kill(owned,0),error=>error.code==='ESRCH');
});
