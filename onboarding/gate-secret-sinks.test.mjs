import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {localInstaller} from './adapter.mjs';
import {createCommands} from './commands.mjs';
import {loadInstallerSeed} from './setup-manifest.mjs';

for(const outcome of ['success','failure'])test(`table: generated, entered, saved and inherited manifest secrets stay out of build bindings and all installer ${outcome} sinks`,async t=>{
 const root=await mkdtemp(join(tmpdir(),'installer-secret-table-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const names=['OPAQUE_VALUE','NEW_GENERATED','SAVED_GENERATED','INHERITED_PRIVATE'];
 const inherited='synthetic inherited / ü private';
 const prior=process.env.INHERITED_PRIVATE;process.env.INHERITED_PRIVATE=inherited;
 t.after(()=>{if(prior===undefined)delete process.env.INHERITED_PRIVATE;else process.env.INHERITED_PRIVATE=prior;});
 const saved='synthetic saved generated private',old='synthetic old entered private';
 await writeFile(join(root,'.dev.vars'),'OPAQUE_VALUE='+JSON.stringify(old)+'\nSAVED_GENERATED='+JSON.stringify(saved)+'\n');
 const manifest={schema:1,title:'Secret table',groups:[],fields:names.map((name,index)=>({name,label:'Private '+index,kind:'secret',required:true,ownerVisible:index===0||index===3,...(index===0||index===3?{input:'entered'}:{generate:index===1?'hex':'base64'})})),steps:[{type:'extension',id:'configure'}]};
 await writeFile(join(root,'rer-setup.json'),JSON.stringify(manifest));
 const state={logs:[]};let terminal='',values=[];
 const commands=await createCommands(root,state,{terminal:text=>{terminal+=text;}});t.after(()=>commands.closeCommands());
 const store={...commands,state,step:async label=>commands.report(label),phase:async phase=>{state.phase=phase;}};
 const shapes=value=>[value,encodeURIComponent(value),Buffer.from(value).toString('base64'),Buffer.from(value).toString('hex'),value.toUpperCase()];
 const kit=localInstaller({tools:[],
  dependencies:[process.execPath,['-e',"process.stdout.write(process.env.INHERITED_PRIVATE+'\\n');"]],
  secrets:{},
  build:async context=>{
   values=[...names.map(name=>context.vars[name]),old].flatMap(shapes);
   await writeFile(join(root,'payload.json'),JSON.stringify(values));
   const body="const fs=require('fs');fs.writeFileSync('filtered.json',JSON.stringify("+JSON.stringify(names)+".every(name=>!Object.hasOwn(process.env,name))));for(const value of JSON.parse(fs.readFileSync('payload.json'))){let index=0;for(const char of value)(index++%2?process.stderr:process.stdout).write(char);process.stdout.write('\\n');}process.stdout.write('PUBLIC_MARKER\\n');"+(outcome==='failure'?'process.exitCode=7;':'');
   return [process.execPath,['-e',body],{env:{...process.env}}];
  },
 });
 const seed=await loadInstallerSeed(root,{product:'Secret table',setup:{manifestFile:'rer-setup.json'},...kit});store.setupManifest=seed.manifest;
 await kit.install(root,{OPAQUE_VALUE:'synthetic fresh entered / ü private',INHERITED_PRIVATE:inherited},store,()=>{});
 assert.equal(state.phase,outcome==='success'?'complete':'failed');
 assert.equal(JSON.parse(await readFile(join(root,'filtered.json'),'utf8')),true);
 const disk=await readFile(store.logPath,'utf8');
 for(const output of [JSON.stringify(state),disk,terminal,state.error??'']){
  for(const value of values)assert.equal(output.includes(value),false,'private bytes escaped an installer sink');
  if(output)assert.ok(output.includes('PUBLIC_MARKER'));
 }
 if(outcome==='failure')assert.match(state.error,/exit 7/);
});
