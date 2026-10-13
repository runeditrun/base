import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startInstaller} from './server.mjs';
import {localInstaller} from './adapter.mjs';
import {createCommands} from './commands.mjs';
import {loadInstallerSeed} from './setup-manifest.mjs';
import {localVariables} from './local/environment.mjs';
import {readAnswers,readSecrets} from './prefill.mjs';
import {Readable} from 'node:stream';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';

const manifest = {
 schema:1,title:'Gate fixture',groups:[],fields:[
  {name:'MODE',label:'Mode',kind:'select',required:true,default:'first',options:[{value:'first',label:'First'},{value:'second',label:'Second'}]},
  {name:'OPAQUE_VALUE',label:'Access',kind:'secret',input:'entered',ownerVisible:true,required:true,presentations:[{when:{field:'MODE',equals:'first'}},{when:{field:'MODE',equals:'second'}}]},
  {name:'COOKIE_KEY',label:'Cookie',kind:'secret',required:true,ownerVisible:false,generate:'base64'},
  {name:'BOOTSTRAP_KEY',label:'Bootstrap',kind:'secret',required:true,ownerVisible:false,generate:'hex'},
 ],steps:[{type:'extension',id:'configure'}],
};
export async function fixture(t, value=manifest) {
 const root=await mkdtemp(join(tmpdir(),'gate-regression-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(join(root,'rer-setup.json'),JSON.stringify(value,null,2)+'\n');
 await writeFile(join(root,'seed.mjs'),"export const product={name:'Gate fixture'}; export const features={};");
 await writeFile(join(root,'background.svg'),'<svg xmlns="http://www.w3.org/2000/svg"/>');
 return root;
}
async function session(t,root,options={}) {
 const server=await startInstaller(root,{seed:{product:'Gate fixture',setup:{manifestFile:'rer-setup.json'},browserModule:'seed.mjs',background:'background.svg',settings:{file:'.dev.vars'},install:async(_root,_input,store)=>store.phase('complete')},...options});
 t.after(()=>server.close());
 const page=await fetch(server.origin),html=await page.text();
 const headers={Origin:server.origin,Cookie:page.headers.get('set-cookie').split(';')[0],'X-Installer-Token':html.match(/name="installer-token" content="([a-f0-9]+)"/)[1],'Content-Type':'application/json'};
 return {server,call:async(path,value)=>fetch(server.origin+path,{headers,...(value===undefined?{}:{method:'POST',body:JSON.stringify(value)})})};
}

for(const format of ['dotenv','json']) test(`approved public and entered replacements win over saved ${format} settings, generated values and exact reruns survive`,async t=>{
 const root=await fixture(t);
 const saved={MODE:'first',OPAQUE_VALUE:'synthetic prior private value',COOKIE_KEY:'synthetic generated cookie',BOOTSTRAP_KEY:'synthetic generated bootstrap',UNRELATED:'owner setting'};
 const file=format==='json'?'settings.json':'.dev.vars';
 const original=format==='json'?JSON.stringify(saved)+'\n':Object.entries(saved).map(([key,value])=>key+'='+JSON.stringify(value)).join('\n')+'\n';
 await writeFile(join(root,file),original);
 let context;
 const kit=localInstaller({tools:[],dependencies:false,secrets:{file,format},migrate:value=>{context=value;}});
 const seed=await loadInstallerSeed(root,{product:'Gate fixture',setup:{manifestFile:'rer-setup.json'},...kit});
 const state={logs:[]},commands=await createCommands(root,state,{terminal:()=>{}});
 t.after(()=>commands.closeCommands());
 const store={...commands,state,setupManifest:seed.manifest,step:async label=>commands.report(label),phase:async phase=>{state.phase=phase;}};
 const input={MODE:'second',OPAQUE_VALUE:'synthetic replacement private value'};
 await kit.install(root,input,store,()=>{});
 assert.equal(state.phase,'complete');
 const read=async()=>format==='json'?JSON.parse(await readFile(join(root,file),'utf8')):localVariables(await readFile(join(root,file),'utf8'));
 const result=await read();
 assert.equal(context.vars.MODE===input.MODE,true);
 assert.equal(context.vars.OPAQUE_VALUE===input.OPAQUE_VALUE,true);
 assert.equal(result.MODE===input.MODE,true);
 assert.equal(result.OPAQUE_VALUE===input.OPAQUE_VALUE,true);
 for(const key of ['COOKIE_KEY','BOOTSTRAP_KEY','UNRELATED'])assert.equal(result[key]===saved[key],true,'an untouched setting changed');
 const first=await readFile(join(root,file));
 await kit.install(root,input,store,()=>{});
 assert.equal((await readFile(join(root,file))).equals(first),true,'rerun settings bytes changed');
});

test('startup answers permanently invalidate saved entered secrets even when dependencies change back',async t=>{
 const root=await fixture(t);
 await writeFile(join(root,'.dev.vars'),'MODE=first\nOPAQUE_VALUE=synthetic-saved-private-value\n');
 const {call}=await session(t,root,{answers:{MODE:'second'}});
 assert.equal((await (await call('/api/state')).json()).known.secretReadiness.OPAQUE_VALUE,false);
 assert.equal((await call('/api/draft',{MODE:'first'})).status,200);
 assert.equal((await (await call('/api/state')).json()).known.secretReadiness.OPAQUE_VALUE,false);
});

test('Start applies an approved replacement after saved credentials are invalidated',async t=>{
 const root=await fixture(t);
 await writeFile(join(root,'.dev.vars'),'MODE=first\nOPAQUE_VALUE=synthetic-old-private-value\nCOOKIE_KEY=synthetic-saved-cookie\nBOOTSTRAP_KEY=synthetic-saved-bootstrap\n');
 let observed;
 const kit=localInstaller({tools:[],dependencies:false,secrets:{},migrate:context=>{observed={...context.vars};}});
 const {call,server}=await session(t,root,{seed:{product:'Gate fixture',setup:{manifestFile:'rer-setup.json'},browserModule:'seed.mjs',...kit}});
 assert.equal((await call('/api/draft',{MODE:'second'})).status,200);
 assert.equal((await call('/api/start',{OPAQUE_VALUE:'synthetic-approved-private-value'})).status,202);
 for(let n=0;n<100&&server.state.phase==='running';n++)await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(server.state.phase,'complete');
 assert.equal(observed.MODE==='second',true);
 assert.equal(observed.OPAQUE_VALUE==='synthetic-approved-private-value',true);
 assert.equal(observed.COOKIE_KEY==='synthetic-saved-cookie',true);
 assert.equal(observed.BOOTSTRAP_KEY==='synthetic-saved-bootstrap',true);
});

test('saved manifest secrets are redacted before any seed artwork callback captures a command',async t=>{
 const root=await fixture(t),privateValue='synthetic saved callback private value';
 await writeFile(join(root,'.dev.vars'),'MODE=first\nOPAQUE_VALUE='+JSON.stringify(privateValue)+'\n');
 let terminal='';const writeSync=fs.writeSync;
 t.mock.method(fs,'writeSync',(fd,text,...args)=>{if(fd===1){terminal+=String(text);return Buffer.byteLength(text);}return writeSync(fd,text,...args);});
 syncBuiltinESMExports();
 t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
 const {server}=await session(t,root,{seed:{product:'Gate fixture',setup:{manifestFile:'rer-setup.json'},browserModule:'seed.mjs',settings:{file:'.dev.vars'},install:async()=>{},artwork:async(_root,store)=>{
  await store.run('Early callback',process.execPath,['-e',"process.stdout.write("+JSON.stringify(privateValue)+"+'\\nPUBLIC_MARKER\\n')"]);
  return {};
 }}});
 const disk=await readFile(join(root,'.seed/installer/install.log'),'utf8');
 for(const output of [terminal,disk,JSON.stringify(server.state)]){
  assert.equal(output.includes(privateValue),false,'a private value escaped an early callback sink');
  assert.ok(output.includes('PUBLIC_MARKER'));
 }
});

test('valid manifest values at the shared limit survive defaults, answers files, drafts, secure input, transport and resume',async t=>{
 const publicValue='🙂'.repeat(8192),privateValue='x'.repeat(16384);
 const value={schema:1,title:'Limits',groups:[],fields:[{name:'NOTE',label:'Note',kind:'text',default:publicValue},{name:'PRIVATE_NOTE',label:'Private note',kind:'secret',input:'entered',ownerVisible:true,required:true}],steps:[{type:'extension',id:'limits'}]};
 const root=await fixture(t,value);
 const {call,server}=await session(t,root);
 assert.equal(server.state.draft.NOTE===publicValue,true);
 const seed=await loadInstallerSeed(root,{product:'Gate fixture',setup:{manifestFile:'rer-setup.json'}});
 await writeFile(join(root,'answers.json'),JSON.stringify({NOTE:publicValue}));
 assert.equal((await readAnswers(join(root,'answers.json'),seed.model)).NOTE===publicValue,true);
 assert.equal((await readSecrets(Readable.from([JSON.stringify({PRIVATE_NOTE:privateValue})]),seed.model)).PRIVATE_NOTE===privateValue,true);
 assert.equal((await call('/api/prefill',{NOTE:publicValue})).status,200);
 assert.equal((await call('/api/draft',{NOTE:publicValue})).status,200);
 const state=await (await call('/api/state')).json();
 assert.equal((await call('/api/secrets',{revision:state.lastUpdate.revision,secrets:{PRIVATE_NOTE:privateValue}})).status,200);
 assert.equal((await call('/api/draft',{NOTE:publicValue+'x'})).status,400);
 assert.equal((await call('/api/start',{})).status,202);
 await server.close();
 const resumed=await session(t,root,{resume:true});
 assert.equal(resumed.server.state.draft.NOTE===publicValue,true);
});

test('an existing valid external manifest is refused before adapter execution',async t=>{
 const root=await fixture(t),outside=await mkdtemp(join(tmpdir(),'gate-outside-'));
 t.after(()=>rm(outside,{recursive:true,force:true}));
 await writeFile(join(outside,'escape.json'),JSON.stringify(manifest));
 let installs=0;
 const selection='../'+outside.split('/').at(-1)+'/escape.json';
 const attempt=startInstaller(root,{seed:{product:'Gate fixture',setup:{manifestFile:selection},install:async()=>{installs++;}}}).then(server=>{t.after(()=>server.close());return server;});
 await assert.rejects(attempt,error=>error.message.includes(selection)&&error.message.includes('root-relative'));
 assert.equal(installs,0);
});
