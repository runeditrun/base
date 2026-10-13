import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,symlink,mkdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startInstaller} from './server.mjs';
import {localInstaller} from './adapter.mjs';
import {createState} from './state.mjs';
const bytes = value => new TextEncoder().encode(JSON.stringify(value));
const manifest = {
 schema:1,title:'Service',groups:[{id:'service',label:'Service'},{id:'credentials',label:'Access',presentations:[{when:{field:'MODE',equals:'online'},label:'Online access'}]}],
 fields:[
  {name:'MODE',label:'Mode',kind:'select',required:true,default:'local',options:[{value:'local',label:'Local'},{value:'online',label:'Online'}]},
  {name:'SERVICE_URL',label:'Address',kind:'url',required:true,group:'service',when:{field:'MODE',equals:'online'},order:2},
  {name:'CONTACT_EMAIL',label:'Contact',kind:'email',group:'service',order:1,presentations:[{when:{field:'MODE',equals:'online'},label:'Online contact',required:true},{when:{field:'MODE',equals:'local'},required:false}]},
  {name:'ACCESS_KEY',label:'Key',kind:'secret',input:'entered',ownerVisible:true,required:true,group:'credentials',presentations:[{when:{field:'MODE',equals:'online'},required:true}]},
  {name:'HEX_SECRET',label:'Hex',kind:'secret',input:'managed',ownerVisible:false,required:true,generate:'hex'},
  {name:'BASE64_SECRET',label:'Base64',kind:'secret',input:'managed',ownerVisible:false,required:true,generate:'base64'},
 ],steps:[{type:'extension',id:'configure'}],
};
const presentation={product:{name:'Manifest fixture'},features:{}};
async function reader(){return import('./setup-manifest.mjs');}
async function fixture(t, value=manifest){
 const root=await mkdtemp(join(tmpdir(),'setup-manifest-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(join(root,'rer-setup.json'),JSON.stringify(value,null,2)+'\n');
 await writeFile(join(root,'seed.mjs'),"export const product={name:'Manifest fixture'}; export const features={};");
 return root;
}
async function session(t,root,seed={}){
 const server=await startInstaller(root,{seed:{product:presentation.product.name,setup:{manifestFile:'rer-setup.json'},browserModule:'seed.mjs',install:async(_root,_input,store)=>store.phase('complete'),...seed}});t.after(()=>server.close());
 const page=await fetch(server.origin),html=await page.text();
 const headers={Origin:server.origin,Cookie:page.headers.get('set-cookie').split(';')[0],'X-Installer-Token':html.match(/name="installer-token" content="([a-f0-9]+)"/)[1],'Content-Type':'application/json'};
 return {server,call:async(path,value)=>fetch(server.origin+path,{headers,...(value===undefined?{}:{method:'POST',body:JSON.stringify(value)})})};
}
test('manifest model preserves names, group order, defaults, options and conditional presentation',async()=>{
 const {createInstallerModel}=await reader();const model=createInstallerModel(manifest,presentation);
 assert.deepEqual(Object.keys(model.fields),manifest.fields.map(field=>field.name));
 assert.deepEqual(model.setupGroups.map(group=>group.id),['ungrouped','service','credentials']);
 assert.equal(model.initialDraft({}).MODE,'local');assert.deepEqual(model.fields.MODE.options,[['local','Local'],['online','Online']]);
 assert.deepEqual(model.groupKeys(model.setupGroups[1],{MODE:'online'}),['CONTACT_EMAIL','SERVICE_URL']);
 assert.equal(model.fieldDefinition('CONTACT_EMAIL',{MODE:'online'}).label,'Online contact');
 assert.equal(model.groupDefinition(model.setupGroups[2],{MODE:'online'}).title,'Online access');
 assert.deepEqual(model.setupModel({MODE:'local'}).missing,[],'hidden required fields do not block');
 assert.ok(model.setupModel({MODE:'online',SERVICE_URL:'https://example.test',ACCESS_KEY:'private'}).missing.includes('CONTACT_EMAIL'),'presentation requiredness is enforced');
 assert.equal(model.fields.CONTACT_EMAIL.valid('invalid'),false);
 assert.deepEqual(model.summaryKeys({MODE:'local',SERVICE_URL:'https://example.test'},{answered:['SERVICE_URL']}),['MODE'],'hidden answers stay out of the summary');
});
test('browser-rejected values are refused by the server before any adapter code',async t=>{
 const root=await fixture(t);let installs=0;
 const {call,server}=await session(t,root,{install:async()=>{installs++;}});
 const {createInstallerModel}=await reader();assert.equal(createInstallerModel(manifest,presentation).fields.SERVICE_URL.valid('ftp://example.test'),false);
 assert.equal((await call('/api/start',{MODE:'online',SERVICE_URL:'ftp://example.test',CONTACT_EMAIL:'owner@example.test',ACCESS_KEY:'private'})).status,400);
 assert.equal((await call('/api/start',{MODE:'online',SERVICE_URL:'https://example.test',ACCESS_KEY:'private'})).status,400);
 assert.equal(installs,0);
 assert.deepEqual(await (await fetch(server.origin+'/rer-setup.json')).json(),manifest);
});
test('missing, invalid, linked and unsafe selections fail naming the file before commands',async t=>{
 const root=await fixture(t);let installs=0;const seed={product:'Fixture',setup:{manifestFile:'missing.json'},install:async()=>{installs++;}};
 for(const name of ['missing.json','invalid.json','linked.json','../escape.json','/absolute.json','setup.yaml','nested/link/file.json']){
  await writeFile(join(root,'invalid.json'),'{}');await symlink('rer-setup.json',join(root,'linked.json')).catch(()=>{});
  await mkdir(join(root,'nested'),{recursive:true});await symlink(root,join(root,'nested/link')).catch(()=>{});
  await assert.rejects(startInstaller(root,{seed:{...seed,setup:{manifestFile:name}}}),error=>error.message.includes(name));
 }
 assert.equal(installs,0);
});
test('seed and browser refuse handwritten shapes naming rer-setup.json',async t=>{
 const root=await fixture(t);const {createInstallerModel}=await reader();
 for(const name of ['fields','safeKeys','setupGroups','requiredKeys','secretScopes']){
  assert.throws(()=>createInstallerModel(manifest,{...presentation,[name]:{}}),/rer-setup.json/);
  await assert.rejects(startInstaller(root,{seed:{product:'Fixture',setup:{manifestFile:'rer-setup.json'},[name]:{},install:async()=>{}}}),/rer-setup.json/);
 }
 await writeFile(join(root,'seed.mjs'),"export const fields={};");
 await assert.rejects(startInstaller(root,{seed:{product:'Fixture',setup:{manifestFile:'rer-setup.json'},browserModule:'seed.mjs',install:async()=>{}}}),/rer-setup.json/);
});
test('managed secrets without a generator require declared adapter supply',async()=>{
 const {createInstallerModel}=await reader();const value=structuredClone(manifest);delete value.fields.at(-1).generate;
 assert.throws(()=>createInstallerModel(value,presentation),/BASE64_SECRET/);
 assert.doesNotThrow(()=>createInstallerModel(value,presentation,{supplied:['BASE64_SECRET']}));
});
test('entered secrets follow presentation dependencies, stay private, and settings prefill by name',async t=>{
 const root=await fixture(t);await writeFile(join(root,'.dev.vars'),'MODE=online\nSERVICE_URL=https://example.test\nCONTACT_EMAIL=owner@example.test\nACCESS_KEY=test-saved-private-value\n');
 const {call,server}=await session(t,root,{settings:{file:'.dev.vars'}});
 let state=await (await call('/api/state')).json();assert.equal(state.draft.MODE,'online');assert.equal(state.known.secretReadiness.ACCESS_KEY,true);assert.ok(!JSON.stringify(state).includes('test-saved-private-value'));
 await call('/api/draft',{MODE:'local'});state=await (await call('/api/state')).json();assert.equal(state.known.secretReadiness.ACCESS_KEY,false);
 await call('/api/draft',{MODE:'online'});state=await (await call('/api/state')).json();assert.equal(state.known.secretReadiness.ACCESS_KEY,false,'changing back does not revive an invalidated secret');
 assert.ok(!JSON.stringify(server.state).includes('test-saved-private-value'));
});
test('settings use manifest answer names and 32-byte hex and padded base64; rerun preserves exact bytes',async t=>{
 const root=await fixture(t);const {loadInstallerSeed}=await reader();const kit=localInstaller({tools:[],dependencies:false,secrets:{}});
 const seed=await loadInstallerSeed(root,{product:'Fixture',setup:{manifestFile:'rer-setup.json'},...kit});
 const store=await createState(root,seed);store.setupManifest=seed.manifest;t.after(()=>store.closeCommands());
 const input={MODE:'online',SERVICE_URL:'https://example.test',CONTACT_EMAIL:'owner@example.test',ACCESS_KEY:'test-entered-private-value'};
 await kit.install(root,input,store,()=>{});assert.equal(store.state.phase,'complete');
 const {localVariables}=await import('./local/environment.mjs');const first=await readFile(join(root,'.dev.vars')),values=localVariables(first.toString());
 assert.equal(values.MODE,input.MODE);assert.equal(values.ACCESS_KEY,input.ACCESS_KEY);assert.match(values.HEX_SECRET,/^[a-f0-9]{64}$/);assert.match(values.BASE64_SECRET,/^[A-Za-z0-9+/]{43}=$/);assert.equal(Buffer.from(values.BASE64_SECRET,'base64').length,32);
 await kit.install(root,input,store,()=>{});assert.deepEqual(await readFile(join(root,'.dev.vars')),first);
 assert.ok(!JSON.stringify(store.state).includes(values.ACCESS_KEY));
});
test('legacy drafts resume and drop keys absent from the manifest',async t=>{
 const root=await fixture(t);await mkdir(join(root,'.seed/installer'),{recursive:true});
 await writeFile(join(root,'.seed/installer/state.json'),JSON.stringify({product:presentation.product.name,draft:{email:'old@example.test',MODE:'local',alien:'old'}}));
 const {server}=await session(t,root);assert.deepEqual(server.state.draft,{MODE:'local'});
});
test('owner and sign-in hooks use the manifest email and token names unless overridden',async t=>{
 const {owner,signIn}=await import('./adapter-auth.mjs');
 const requests=[];let outboxReads=0;
 t.mock.method(globalThis,'fetch',async(url,options={})=>{
  if(options.method==='POST'){
   requests.push({path:new URL(url).pathname,input:JSON.parse(options.body)});
   return new Response(null,{status:requests.length===1?303:202});
  }
  outboxReads++;
  return new Response(outboxReads===1?'':'<article><p>To: admin@example.test</p><a href="?message=new-message">Open</a></article>');
 });
 const context={origin:'http://127.0.0.1:9000',input:{displayName:'Owner'},vars:{ADMIN_EMAIL:'admin@example.test',BOOTSTRAP_KEY:'test-private-bootstrap'},ownerClaim:{emailField:'ADMIN_EMAIL',tokenField:'BOOTSTRAP_KEY'},store:{step:async()=>{},report:()=>{}},fail:()=>Error('hook failed')};
 await owner(context,{});await signIn(context,{attempts:1});
 assert.equal(requests[0].input.token===context.vars.BOOTSTRAP_KEY,true);
 assert.equal(requests[1].input.email,'admin@example.test');
 assert.match(context.appUrl,/message=new-message/);
});
