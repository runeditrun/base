import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname, resolve} from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {resolveSources} from '../edition-authoring/lock.mjs';

const base=resolve(import.meta.dirname,'..');
const git=(root,...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',stdio:'pipe'}).trim();
const write=(root,name,body)=>{mkdirSync(dirname(join(root,name)),{recursive:true});writeFileSync(join(root,name),body);};
function fixture(t,{anchor=false,operations}={}) {
 const root=mkdtempSync(join(tmpdir(),'rer-rehearse-test-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 git(root,'init','-q');git(root,'config','user.name','Fixture');git(root,'config','user.email','test@example.invalid');
 write(root,'historic.txt','Original source\n');git(root,'add','.');git(root,'commit','-qm','Original history');
 const old=git(root,'rev-parse','HEAD');
 write(root,'history.mjs',`import fs from 'node:fs'; import {execFileSync} from 'node:child_process';
try { execFileSync('git',['cat-file','-e','${old}^{commit}'],{stdio:'pipe'}); }
catch { if (!fs.existsSync('docs/contract/ANCHOR.json')) { console.error('contract_anchor_missing: original history is unavailable; record it with anchor --old <ref>');process.exit(1); } }
`);
 if(anchor)write(root,'docs/contract/ANCHOR.json',JSON.stringify({original:old}));
 write(root,'.github/workflows/rer-managed.yml','name: Managed\non: workflow_dispatch\njobs: {}\n');
 write(root,'.github/workflows/publisher.yml','name: Publisher\non: push\n');
 write(root,'edition.json',JSON.stringify({schemaVersion:1,id:'example/rehearsal',toolchain:{id:'runeditrun/edition-authoring',version:'1.1.0'},components:[{id:'example/rehearsal',role:'edition',source:{kind:'local',paths:['history.mjs','.github/workflows/publisher.yml','.github/workflows/rer-managed.yml']}}]}));
 write(root,'build.mjs',`import fs from 'node:fs';import {createHash} from 'node:crypto';import {execFileSync} from 'node:child_process';
if (execFileSync('git',['rev-list','--count','HEAD'],{encoding:'utf8'}).trim()!=='2') throw Error('Wrong managed history');
if (execFileSync('git',['remote'],{encoding:'utf8'}).trim()) throw Error('Scratch has a remote');
if (process.env.PROVIDER_CREDENTIAL || process.env.NODE_OPTIONS || fs.existsSync(process.env.HOME+'/private-sentinel')) throw Error('Caller configuration leaked');
if (fs.existsSync('.github/workflows/publisher.yml')) throw Error('Publisher workflow survived');
const lock=JSON.parse(fs.readFileSync('sources.lock.json')), record=fs.readFileSync('rer-upstream.json');
if(lock.files['rer-upstream.json'].sha256!==createHash('sha256').update(record).digest('hex')) throw Error('Installation record is not locked');
const upstream=JSON.parse(record);if(upstream.commit!=='${old}' && !/^[0-9a-f]{40}$/.test(upstream.commit)) throw Error('Missing exact source');
fs.writeFileSync('built.txt','Built');
`);
 write(root,'rer-project.json',JSON.stringify({schema:1,projectId:'example/rehearsal',sourceRepository:'runeditrun/base',deployment:{target:'cloudflare-workers',artifactFile:'worker.json'},operations:operations??{setup:'node history.mjs',build:'node build.mjs',verify:'node history.mjs',artifact:'node -e "console.log(\'artifact ran\')"'}}));
 git(root,'add','.');write(root,'sources.lock.json',JSON.stringify(resolveSources(root),null,2)+'\n');git(root,'add','.');git(root,'commit','-qm','Declared operations');
 // Only the commit is rehearsed: dirty/untracked files must not leak into it.
 write(root,'untracked.txt','Keep private');
 const run=(...flags)=>spawnSync(process.execPath,[join(base,'global/rer.mjs'),'rehearse','--cwd',root,...flags],{encoding:'utf8',timeout:45000,env:{...process.env,PROVIDER_CREDENTIAL:'synthetic-rehearsal-1',RER_UPDATE_CHECK:'0'}});
 return {root,run};
}
function result(t,run,...args) {
 const call=run('--json',...args);assert.ifError(call.error);const row=JSON.parse(call.stdout.trim().split('\n').at(-1));
 if(row.captureLog)t.after(()=>rmSync(dirname(row.captureLog),{recursive:true,force:true}));
 return {call,row};
}

test('rehearse reports every history-dependent failure and still runs later declared operations',t=>{
 const {root,run}=fixture(t), before=git(root,'rev-parse','HEAD');
 const {call,row}=result(t,run);
 assert.equal(call.status,1,call.stdout+call.stderr);
 assert.deepEqual(row.operations.map(({name,status})=>[name,status]),[['setup','FAIL'],['build','PASS'],['verify','FAIL'],['artifact','PASS']]);
 assert.match(row.operations[0].cause,/contract_anchor_missing/);
 assert.match(readFileSync(row.captureLog,'utf8'),/artifact ran/);
 assert.equal(git(root,'rev-parse','HEAD'),before);assert.ok(existsSync(join(root,'untracked.txt')));
});

test('rehearse passes the anchored seed through the public command and can retain its managed copy',t=>{
 const {run}=fixture(t,{anchor:true});const {call,row}=result(t,run,'--keep');
 assert.equal(call.status,0,call.stdout+call.stderr);assert.equal(row.ok,true);
 assert.ok(row.operations.every(operation=>operation.status==='PASS'));
 t.after(()=>rmSync(dirname(row.scratch),{recursive:true,force:true}));
 assert.ok(!existsSync(join(row.scratch,'untracked.txt')));assert.equal(git(row.scratch,'rev-list','--count','HEAD'),'2');
});

test('rehearse bounds each operation, identifies unavailable prerequisites and honours its overall deadline',t=>{
 const {run}=fixture(t,{anchor:true,operations:{setup:'node -e "setInterval(()=>{},1000)"',build:'node -e "require(\'node:fs\').readFileSync(\'absent-output\')"',verify:'node -e "console.log(\'verified later\')"'}});
 const {call,row}=result(t,run,'--operation-timeout-seconds','1');
 assert.equal(call.status,1,call.stdout+call.stderr);assert.match(row.operations[0].cause,/exceeded/);
 assert.equal(row.operations[1].status,'NOT REACHED');assert.match(row.operations[1].cause,/setup/);assert.equal(row.operations[2].status,'PASS');
 const overall=result(t,run,'--timeout-seconds','2');
 assert.equal(overall.call.status,124,overall.call.stdout+overall.call.stderr);
 assert.ok(overall.row.operations.some(operation=>operation.status==='NOT REACHED'));
});
