import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, mkdir, writeFile, readFile, readdir, chmod, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const execute=promisify(execFile);
for(const pathValue of [false,true])for(const ending of ['success','failure'])test(`table: CLI manifest secrets are excluded from every command and redacted on a saved ${ending} rerun${pathValue?' including private path metadata':''}`,async t=>{
 const root=await mkdtemp(join(tmpdir(),'cli-gate-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const names=['COOKIE_KEY','BOOTSTRAP_KEY','OPAQUE_VALUE'];
 const values=names.map((_,index)=>'synthetic private / value '+index+' ü');
 if(pathValue)values[2]=root;
 const manifest={schema:1,title:'CLI secrets',groups:[],fields:[{name:'ADMIN_EMAIL',label:'Owner',kind:'email',required:true,prefill:'account-email'},...names.map((name,index)=>({name,label:'Private '+index,kind:'secret',required:true,ownerVisible:index!==0,...(index===2?{input:'entered'}:{generate:index===0?'base64':'hex'})}))],steps:[{type:'owner-claim',mode:'setup-token',emailField:'ADMIN_EMAIL',tokenField:'BOOTSTRAP_KEY'}]};
 await writeFile(join(root,'rer-setup.json'),JSON.stringify(manifest));
 const original=['# pre-base-27 owner settings','AUTH_LOCAL=true','AUTH_ORIGIN=http://127.0.0.1:9999','ADMIN_EMAIL=owner@example.test',...names.map((name,index)=>name+'='+JSON.stringify(values[index]))].join('\n')+'\n';
 await writeFile(join(root,'.dev.vars'),original);
 const forms=value=>[value,encodeURIComponent(value),Buffer.from(value).toString('base64'),Buffer.from(value).toString('hex'),value.toUpperCase()];
 const privateForms=values.flatMap(forms);
 await writeFile(join(root,'payload.json'),JSON.stringify(privateForms));
 await mkdir(join(root,'bin'));
 const shim=join(root,'bin/pnpm');
 await writeFile(shim,'#!'+process.execPath+'\n'+
  "const fs=require('fs');const names="+JSON.stringify(names.concat('ADMIN_EMAIL'))+";fs.appendFileSync('bindings.jsonl',JSON.stringify({filtered:names.every(name=>!Object.hasOwn(process.env,name))})+'\n');".replace("+'\n'","+'\\n'")+
  "for(const text of JSON.parse(fs.readFileSync('payload.json'))){for(const char of text)process.stderr.write(char);process.stderr.write('\\n');}process.stderr.write('PUBLIC_MARKER\\n');"+
  (ending==='failure'?"process.exitCode=7;":"if(process.argv.includes('execute'))process.stdout.write('[{\"results\":[{\"claimed\":1}]}]');"));
 await chmod(shim,0o755);
 const source="import {runLocalSetup} from "+JSON.stringify(new URL('./fixtures/setup.mjs',import.meta.url).href)+";await runLocalSetup("+JSON.stringify(root)+",{database:'fixture',args:[],parseAddress:email=>({email})});";
 let result;
 try{result=await execute(process.execPath,['--input-type=module','-e',source],{env:{...process.env,PATH:join(root,'bin'),...Object.fromEntries(names.map((name,index)=>[name,values[index]])),ADMIN_EMAIL:'owner@example.test'},maxBuffer:1024*1024});}catch(error){result=error;}
 const runs=await readdir(join(root,'.wrangler/local-setup'));
 const log=await readFile(join(root,'.wrangler/local-setup',runs[0],'commands.log'),'utf8');
 for(const output of [result.stdout,result.stderr,log])for(const value of privateForms)assert.equal(output.includes(value),false,'private bytes escaped a CLI sink');
 assert.ok(log.includes('PUBLIC_MARKER'));
 const commands=(await readFile(join(root,'bindings.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
 assert.equal(commands.length,ending==='success'?3:1);
 assert.ok(commands.every(command=>command.filtered),'manifest application bindings reached a child');
 assert.equal(await readFile(join(root,'.dev.vars'),'utf8'),original);
 if(ending==='success')assert.match(result.stdout,/Owner already claimed/);
 else assert.match(result.stderr,/exit 7/);
});
