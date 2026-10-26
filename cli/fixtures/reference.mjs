import { commandDiagnostic } from './command-diagnostic.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile, rm, stat, access, symlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { createRequire } from 'node:module';
import { exportReference } from '../../scripts/export-reference.mjs';
import { initialize } from '../../foundation/initialize.mjs';
import { assemble } from '../../composition/assemble.mjs';
import { sourceRoots } from '../export.mjs';
import { isolatedQueue } from './queue.mjs';
import { localD1 } from './local-d1.mjs';
const base = resolve(import.meta.dirname, '../..');
export const { chromium } = createRequire(join(base,'default-seed/package.json'))('@playwright/test');
const git = (root,...args) => execFileSync('git',['-C',root,...args],{encoding:'utf8',stdio:'pipe'}).trim();
export const pause = ms => new Promise(resolve=>setTimeout(resolve,ms));
// A local reverse proxy as a tunnel agent with Host rewrite runs it: every
// forwarded request reaches the app with a loopback URL and Host.
export async function forwardingProxy(target) {
 const { createServer: http }=await import('node:http'),{ request: forward }=await import('node:http'),{ host }=new URL(target);
 const server=http((req,res)=>{const upstream=forward(target+req.url,{method:req.method,headers:{...req.headers,host,'x-forwarded-for':'203.0.113.7'}},reply=>{res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);});upstream.on('error',()=>{res.writeHead(502);res.end();});req.pipe(upstream);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 return {url:`http://127.0.0.1:${server.address().port}`,close:()=>new Promise(resolve=>server.close(resolve))};
}
export async function hostStatus(url,host) {return await new Promise((resolve,reject)=>{const req=request(url,{headers:{Host:host}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.once('error',reject);req.end();});}
// A documented command line as [program, ...args]. `rer` is the installed
// launcher, run from this Base's own source; `node` is this Node.
export function documentedCommand(line) {
 const [program,...args]=line.split(/\s+/);
 if(program==='rer')return [process.execPath,join(base,'global/rer.mjs'),...args];
 return [program==='node'?process.execPath:program,...args];
}
export async function freePort() { const socket=createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));return port; }

// Setup announces its chosen port before starting its temporary application.
// Observe that real selection when a journey needs to probe setup while alive.
export async function setupOrigin(child) {
 const deadline=Date.now()+120000;
 for (;;) {
  const events=child.stdoutText.split('\n').slice(0,-1).filter(Boolean).map(JSON.parse);
  const ready=events.find(event=>event.event==='setup-ready');
  if(ready)return ready.url;
  const selected=events.find(event=>event.event==='port');
  if(selected)return `http://127.0.0.1:${selected.port}`;
  assert.equal(child.exitCode,null,'setup must announce its selected port');
  assert.ok(Date.now()<deadline,'setup port announcement deadline');
  await pause(25);
 }
}

export async function fixture(kind,t) {
 const directory=await mkdtemp(join(tmpdir(),'rer-real-journey-')), root=join(directory,'seed with spaces');
 const children=new Set();
 async function stop(child) { if(child.exitCode!==null||child.signalCode!==null)return;child.kill('SIGTERM');await Promise.race([child.done,pause(15000)]);if(child.exitCode===null&&child.signalCode===null)throw Error('CLI did not finish owned teardown'); }
 t.after(async()=>{for(const child of children)await stop(child);await rm(directory,{recursive:true,force:true,maxRetries:3,retryDelay:100});});
 if(kind==='default-seed')await exportReference(base,root);
 else {
  const snapshot=join(directory,'base'),family=join(directory,'family');await mkdir(snapshot);
  for(const path of [...new Set([...sourceRoots,'modules/operator-auth','foundation','composition','schema','onboarding','export','LICENSE'])])await cp(join(base,path),join(snapshot,path),{recursive:true,filter:path=>!path.includes('node_modules')&&!path.includes('__pycache__')});
  git(snapshot,'init','--quiet');git(snapshot,'add','.');git(snapshot,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','real source fixture');
  const ref=git(snapshot,'rev-parse','HEAD');await initialize({baseRepo:snapshot,ref,output:family,family:'journey',edition:'foundation',repository:'just-every/run-happytohelp'});
  const manifestPath=join(family,'editions/foundation/rer-setup.json');
  const manifest=JSON.parse(await readFile(manifestPath,'utf8'));manifest.fields.push({name:'WORKSPACE_TITLE',label:'Workspace title',kind:'text',required:true,default:'Composed workspace',group:'application'},{name:'CONNECTION_PASSWORD',label:'Connection password',kind:'secret',input:'entered',required:true,ownerVisible:true,group:'application'});
  await writeFile(manifestPath,JSON.stringify(manifest,null,2)+'\n');
  await mkdir(join(family,'editions/foundation/migrations/core'),{recursive:true});
  await writeFile(join(family,'editions/foundation/migrations/core/0005_notes.sql'), 'CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT, attachment BLOB);\n');
  git(family,'init','--quiet');git(family,'add','.');git(family,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','composed fixture');
  await assemble({familyRepo:family,baseRepo:snapshot,edition:'foundation',output:root,toolCommit:ref});
  await rm(snapshot,{recursive:true,force:true,maxRetries:3,retryDelay:100});await rm(family,{recursive:true,force:true,maxRetries:3,retryDelay:100});
 }
 // Keep the prepared manager cache when the runner gives each job a fresh HOME.
 const tools=Object.fromEntries(['HTTP_PROXY','HTTPS_PROXY','NO_PROXY','NODE_EXTRA_CA_CERTS','SSL_CERT_FILE','PLAYWRIGHT_BROWSERS_PATH','COREPACK_HOME','TMPDIR','TMP','TEMP'].filter(name=>process.env[name]).map(name=>[name,process.env[name]]));
 const env=await isolatedQueue(t,{...tools,PATH:process.env.PATH,HOME:process.env.HOME,CI:'true',RER_SERVERS_DIR:join(directory,'servers'),WRANGLER_SEND_METRICS:'false',npm_config_child_concurrency:'1',npm_config_network_concurrency:'2'});
 // Wall time of each launched command, by kind, for `timingSummary`.
 const timings=new Map();
 const timingKind=(program,args)=>program!==process.execPath?'program':args[0].includes('wrangler')?'wrangler '+args.slice(1,3).join(' '):args[0]==='scripts/rer.mjs'?'rer '+args[1]:'node';
 function timingSummary() {return [...timings].map(([kind,list])=>`${kind} x${list.length} ${Math.round(list.reduce((sum,ms)=>sum+ms,0)/1000)}s [${list.map(ms=>Math.round(ms/1000)).join(' ')}]`).join('; ');}
 function launch(args, program=process.execPath, overrides={}) {
  const started=Date.now(),kind=timingKind(program,args);
  const child=spawn(program,args,{cwd:root,env:{...env,...overrides},stdio:['ignore','pipe','pipe']});children.add(child);child.stdoutText='';child.stderrText='';
  child.once('close',()=>timings.set(kind,[...(timings.get(kind)??[]),Date.now()-started]));
  child.stdout.on('data',data=>{child.stdoutText+=data});child.stderr.on('data',data=>{child.stderrText+=data});
  child.done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>resolve(code))});return child;
 }
 const start=args=>launch(['scripts/rer.mjs',...args]);
 async function data(query) {const child=launch(['node_modules/wrangler/bin/wrangler.js','d1','execute',kind==='default-seed'?'default-seed-reference':'foundation','--local','--persist-to','.wrangler/state','--config','dist/server/wrangler.json','--command',query,'--json']);assert.equal(await child.done,0,'actual local D1 fixture command');return JSON.parse(child.stdoutText);}
 async function run(args,expected=0) {
  const child=start(args),code=await child.done;
  let diagnostic='';
  if(code!==expected){
   // Setup can refuse before opening its capture log. Its own error event and
   // stderr must survive even when a successful install left a log behind.
   const reasons=child.stdoutText.split('\n').flatMap(line=>{
    try{const row=JSON.parse(line);return row.event==='error'?[`${row.code}: ${row.message}`]:[];}catch{return [];}
   });
   const installLog=await readFile(join(root,'.seed/installer/install.log'),'utf8').catch(()=>'');
   const log=[...reasons,child.stderrText,installLog].join('\n');
   if(process.env.RER_TEST_EVIDENCE_DIRECTORY)await writeFile(join(process.env.RER_TEST_EVIDENCE_DIRECTORY,kind+'-failure.log'),log,{mode:0o600});
   diagnostic=[...reasons,child.stderrText.slice(-2500),...installLog.split('\n').filter(line=>/error TS|ERROR|Error|ERR_PNPM|HTTP [45]|did not|First owner|already claimed|sign-in|health status|not ok|ENOENT|failureType:/.test(line)).slice(-20)].join('\n').replace(/https?:\/\/\S+/g,'[URL]');
   t.diagnostic(diagnostic);
  }
  assert.equal(code,expected,`Safe command outcome: ${args[0]} exited ${code}; ${JSON.stringify(commandDiagnostic(child))}\n${args[0]==='install'?child.stdoutText.slice(-2500):diagnostic}`);
  return child;
 }
 async function documented(line,overrides={}) {const [program,...args]=documentedCommand(line);const child=launch(args,program,overrides);const code=await child.done;assert.equal(code,0,`documented command succeeds: ${line} exited ${code}; ${JSON.stringify(commandDiagnostic(child))}\n${(child.stdoutText+child.stderrText).split('\n').filter(text=>/error TS|ERROR|Error|ERR_PNPM|HTTP [45]|did not|ENOENT|failed/.test(text)).map(text=>text.replace(/https?:\/\/\S+/g,'[URL]')).slice(-20).join('\n')}`);return child;}
 const sql=query=>localD1(root,query);
 return {root,registry:env.RER_SERVERS_DIR,run,start,stop,data,sql,documented,launch,timingSummary};
}
