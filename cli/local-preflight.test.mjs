import test from 'node:test';
import assert from 'node:assert/strict';
import {cp,mkdir,mkdtemp,readFile,readdir,rm,writeFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {DatabaseSync} from 'node:sqlite';
import {exportCLI} from './export.mjs';
import {localOperation} from '../onboarding/local/operation.mjs';
const base=join(import.meta.dirname,'..');
async function seed(t){
 const root=await mkdtemp(join(tmpdir(),'rer-public-preflight-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await cp(join(base,'default-seed'),root,{recursive:true,filter:path=>!path.split('/').some(part=>['node_modules','.wrangler','.seed','.rer','dist','.cache'].includes(part))});
 await exportCLI(base,root);await cp(join(base,'onboarding'),join(root,'scripts/base-onboarding'),{recursive:true,filter:path=>!path.endsWith('.test.mjs')});
 const run=async args=>{const child=spawn(process.execPath,['scripts/rer.mjs',...args,'--json','--non-interactive'],{cwd:root,env:{...process.env,CI:'true'},stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});return {code,stdout,stderr,events:stdout.trim().split('\n').filter(Boolean).map(JSON.parse)};};
 return {root,run};
}
test('public setup enumerates active missing fields and private answer shape without prompting or echoing answers',async t=>{
 const {root,run}=await seed(t);const path=join(root,'rer-setup.json');const manifest=JSON.parse(await readFile(path,'utf8'));
 manifest.fields.push({name:'WORKSPACE',label:'Workspace',kind:'text',required:true},{name:'MODE',label:'Mode',kind:'select',options:[{value:'online',label:'Online'},{value:'local',label:'Local'}],default:'online',required:true},{name:'ACCESS',label:'Access',kind:'secret',input:'entered',ownerVisible:true,required:true,when:{field:'MODE',equals:'online'}},{name:'INACTIVE',label:'Inactive',kind:'text',required:true,when:{field:'MODE',equals:'local'}});
 const region={name:'REGION',label:'Region',kind:'select',options:[{value:'east',label:'East'},{value:'west',label:'West'}],required:true};manifest.fields.push(region);
 await writeFile(path,JSON.stringify(manifest));
 const result=await run(['setup']);assert.equal(result.code,3,result.stdout);const message=result.events.find(event=>event.event==='error').message;
 assert.match(message,/OWNER_EMAIL/);assert.match(message,/WORKSPACE/);assert.match(message,/ACCESS/);assert.doesNotMatch(message,/INACTIVE|SESSION_SECRET|SETUP_TOKEN/);assert.match(message,/--answers answers.json --non-interactive/);assert.match(message,/"ACCESS":"<private value>"/);
 assert.match(message,/OWNER_EMAIL[^.;]*email/);assert.match(message,/WORKSPACE[^.;]*text/);assert.match(message,/ACCESS[^.;]*secret/);assert.match(message,/REGION[^.;]*select/);
 for(const option of region.options)assert.ok(message.includes(JSON.stringify(option.value)),`Missing accepted choice ${option.value}`);
 const shape=JSON.parse(message.match(/shaped (\{.*\}), then run/)[1]);assert.ok(region.options.some(option=>option.value===shape.REGION),'Answer shape must use an accepted select value');
 assert.equal(result.events.filter(event=>event.event==='result').length,1);
 const privateAnswers={WORKSPACE:'synthetic-entered-workspace',ACCESS:'synthetic-private-answer',REGION:'synthetic-invalid-choice','synthetic-undeclared-field':'https://example.test/?token=synthetic-private-token'};
 await writeFile(join(root,'answers.json'),JSON.stringify(privateAnswers),{mode:0o600});
 const invalid=await run(['setup','--answers','answers.json']);assert.equal(invalid.code,3);const invalidMessage=invalid.events.find(event=>event.event==='error').message;
 for(const value of Object.values(privateAnswers))assert.ok(!invalidMessage.includes(value),'Supplied answers must stay private');
 assert.ok(!invalidMessage.includes('synthetic-undeclared-field'),'Unknown input names must stay private');
 assert.ok(region.options.some(option=>option.value===JSON.parse(invalidMessage.match(/shaped (\{.*\}), then run/)[1]).REGION));
 region.default='east';
 manifest.fields.push({name:'FINAL_FIELD',label:'Last required answer',kind:'text',required:true});await writeFile(path,JSON.stringify(manifest));
 const terminal=JSON.parse((await promisify(execFile)('python3',[join(base,'cli/fixtures/terminal-setup.py'),root,process.execPath],{timeout:90000})).stdout);
 assert.deepEqual(terminal.prompted,['OWNER_EMAIL','WORKSPACE','ACCESS','FINAL_FIELD']);assert.equal(terminal.secretWasEchoed,false);assert.equal(terminal.managedSecretPrompted,false);assert.equal(terminal.termination,143);
});
test('public setup refuses retained database owner mismatch before changing private settings or data',async t=>{
 const {root,run}=await seed(t);const directory=join(root,'.wrangler/state/v3/d1/miniflare-D1DatabaseObject');await mkdir(directory,{recursive:true});
 const path=join(directory,'installation.sqlite');const db=new DatabaseSync(path);
 for(const file of (await readdir(join(root,'migrations/core'))).filter(file=>file.endsWith('.sql')).sort())db.exec(await readFile(join(root,'migrations/core',file),'utf8'));
 db.prepare("INSERT INTO oa_operators(id,email,display_name,role,status,created_at) VALUES(?,?,?,'owner','active',0)").run('retained','original@example.test','Retained owner');db.close();
 const privatePath=join(root,'.dev.vars');await writeFile(privatePath,'OWNER_EMAIL="different@example.test"\nSESSION_SECRET="synthetic-private-retained-value"\n',{mode:0o600});
 const before=await readFile(privatePath),data=await readFile(path),mode=(await stat(privatePath)).mode;
 for(const address of ['different@example.test','original@example.test']){
  const result=await run(['setup','--owner-email',address]);assert.equal(result.code,4,result.stdout);assert.match(result.stdout,/original@example.test/);assert.match(result.stdout,/rer setup --owner-email original@example.test/);assert.match(result.stdout,/rer reset --yes/);assert.doesNotMatch(result.stdout,/synthetic-private-retained-value/);
  assert.deepEqual(await readFile(privatePath),before);assert.deepEqual(await readFile(path),data);assert.equal((await stat(privatePath)).mode,mode);
 }
});
test('public lifecycle refuses legacy saved-origin listeners despite overrides and identifies live lock owners',async t=>{
 // A separate process holds the saved origin; the caller's own launch chain never counts as its holder.
 const {root,run}=await seed(t);const listen=cwd=>spawn(process.execPath,['-e',"const s=require('node:net').createServer().listen(0,'127.0.0.1',()=>console.log(s.address().port));setInterval(()=>{},1000)"],{cwd,stdio:['ignore','pipe','inherit']});
 const holder=listen(root);t.after(()=>holder.kill());
 const port=Number(String((await once(holder.stdout,'data'))[0]).trim());await writeFile(join(root,'.dev.vars'),`OWNER_EMAIL="original@example.test"\nAUTH_ORIGIN="http://127.0.0.1:${port}"\n`,{mode:0o600});
 for(const args of [['setup','--port','49731'],['dev','--port','49731'],['preview','--port','49731'],['reset','--yes']]){const result=await run(args);assert.equal(result.code,4,result.stdout);assert.match(result.stdout,new RegExp(`PID ${holder.pid}`));assert.match(result.stdout,/kill -TERM/);}
 await writeFile(join(root,'.dev.vars'),'OWNER_EMAIL="original@example.test"\n',{mode:0o600});
 const explicit=await run(['setup','--port',String(port)]);assert.equal(explicit.code,4,explicit.stdout);assert.match(explicit.stdout,new RegExp(`PID ${holder.pid}`));
 holder.kill();await once(holder,'exit');
 // A listener running elsewhere only blocks the port: dev says how to move, reset still works.
 const foreign=listen(tmpdir());t.after(()=>foreign.kill());const taken=Number(String((await once(foreign.stdout,'data'))[0]).trim());
 await writeFile(join(root,'.dev.vars'),`OWNER_EMAIL="original@example.test"\nAUTH_ORIGIN="http://127.0.0.1:${taken}"\n`,{mode:0o600});
 const busy=await run(['dev']);assert.equal(busy.code,4,busy.stdout);assert.match(busy.stdout,new RegExp(`PID ${foreign.pid}`));assert.match(busy.stdout,/rer setup --port \d+/);
 assert.equal((await run(['reset','--yes'])).code,0);
 foreign.kill();await once(foreign,'exit');
 await writeFile(join(root,'.dev.vars'),'OWNER_EMAIL="original@example.test"\n',{mode:0o600});
 const operation=await localOperation(root);try{const result=await run(['reset','--yes']);assert.equal(result.code,4,result.stdout);assert.match(result.stdout,new RegExp(`PID ${process.pid}`));assert.match(result.stdout,/Stop it/);}finally{await operation.release();}
});
