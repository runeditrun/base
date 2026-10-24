import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,cp,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {BUSINESS_FIELD_INPUTS} from './business-field-inputs.mjs';
const root=new URL('../',import.meta.url);
test('setup doors share the Business input table and retain developer audiences and owner defaults',async t=>{
 const destination=await mkdtemp(join(tmpdir(),'setup-audience-'));
 t.after(()=>rm(destination,{recursive:true,force:true}));
 const manifest={schema:1,title:'Workspace settings',groups:[{id:'technical',label:'Technical settings',audience:'developer'}],fields:[
  {name:'WORKSPACE_TITLE',label:'Workspace title',kind:'text',required:true},
  {name:'PROFILE',label:'Profile',kind:'text',audience:'developer'},
  {name:'SERVICE_URL',label:'Service address',kind:'url',group:'technical'},
 ],steps:[{type:'extension',id:'workspace'}]};
 const businessFields=Object.keys(BUSINESS_FIELD_INPUTS);
 const publicKinds=['text','email','url','select','colour','timezone'];
 for(const [index,businessField] of businessFields.entries()){
  const kind=publicKinds[index%publicKinds.length];
  manifest.fields.push({name:BUSINESS_FIELD_INPUTS[businessField][0],label:'Business value',kind,businessField,...(kind==='select'?{options:[{value:'synthetic-base-1',label:'Synthetic option'}]}:{})});
 }
 const file=join(destination,'rer-setup.json');
 await writeFile(file,JSON.stringify(manifest));
 const result=spawnSync(process.execPath,[new URL('schema/validate.mjs',root).pathname,'--schema','SETUP',file],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
 const {loadInstallerSeed}=await import('../onboarding/setup-manifest.mjs');
 const {model}=await loadInstallerSeed(destination,{product:'Workspace',setup:{manifestFile:'rer-setup.json'}});
 assert.equal(model.fieldDefinition('WORKSPACE_TITLE',{}).audience,'owner');
 assert.equal(model.fieldDefinition('PROFILE',{}).audience,'developer');
 assert.equal(model.fieldDefinition('SERVICE_URL',{}).audience,'developer');
 assert.equal(model.groupDefinition(model.setupGroups.find(group=>group.id==='technical'),{}).audience,'developer');
 for(const businessField of businessFields)assert.equal(model.fieldDefinition(BUSINESS_FIELD_INPUTS[businessField][0],{}).businessField,businessField);
 const input={WORKSPACE_TITLE:'synthetic-base-1',PROFILE:'local',SERVICE_URL:'https://service.example.test'};
 for(const name of Object.keys(input))assert.equal(model.fieldVisible(name,input),true);
 assert.equal(model.validateInput(input).SERVICE_URL,input.SERVICE_URL);
 // Every declared name/field pair crosses the CLI and both loader doors.
 for(const [businessField,names] of Object.entries(BUSINESS_FIELD_INPUTS))for(const name of names){
  const candidate={...manifest,fields:[{name,label:'Business value',kind:'text',businessField}]};
  await writeFile(file,JSON.stringify(candidate));
  const result=spawnSync(process.execPath,[new URL('schema/validate.mjs',root).pathname,'--schema','SETUP',file],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  for(const path of ['../onboarding/setup-manifest.mjs','../default-seed/scripts/base-onboarding/setup-manifest.mjs']){
   const {loadInstallerSeed:load}=await import(path);
   const {model:publicModel}=await load(destination,{product:'Business',setup:{manifestFile:'rer-setup.json'}});
   assert.equal(publicModel.fieldDefinition(name,{}).businessField,businessField);
   assert.equal(publicModel.validateInput({[name]:'A business value'})[name],'A business value');
  }
 }
 manifest.fields[0].audience='owner';
 manifest.fields[2].audience='developer';
 await writeFile(file,JSON.stringify(manifest));
 assert.equal((await loadInstallerSeed(destination,{product:'Workspace',setup:{manifestFile:'rer-setup.json'}})).model.fieldDefinition('WORKSPACE_TITLE',{}).audience,'owner');
});
test('setup doors refuse off-list and invalid hints, structural secrets, duplicate claims and invalid audiences',async t=>{
 const destination=await mkdtemp(join(tmpdir(),'invalid-setup-audience-'));
 t.after(()=>rm(destination,{recursive:true,force:true}));
 const base={schema:1,title:'Settings',groups:[{id:'technical',label:'Technical settings'}],fields:[
  {name:'PROFILE',label:'Profile',kind:'text',group:'technical'},
 ],steps:[{type:'extension',id:'workspace'}]};
 const {loadInstallerSeed}=await import('../onboarding/setup-manifest.mjs');
 const {loadInstallerSeed:loadShippedInstallerSeed}=await import('../default-seed/scripts/base-onboarding/setup-manifest.mjs');
 for(const [mutate,message] of [
  [data=>{data.fields[0].businessField='unknown_business_field';},/businessField.*not one of/],
  [data=>{data.fields[0].businessField=null;},/businessField.*not one of/],
  [data=>{Object.assign(data.fields[0],{kind:'secret',required:false,ownerVisible:true,input:'entered',businessField:'owner_email'});},/kind is "secret".*excluded schema/],
  [data=>{Object.assign(data.fields[0],{kind:'secret',required:false,ownerVisible:false,input:'managed',businessField:'legal_name'});},/kind is "secret".*excluded schema/],
  [data=>{Object.assign(data.fields[0],{kind:'secret',required:false,ownerVisible:false,generate:'hex',businessField:'mail_sender'});},/kind is "secret".*excluded schema/],
  [data=>{Object.assign(data.fields[0],{name:'APP_CLIENTSECRET',businessField:'display_name'});}],
  ...[
   ['LEGAL_NAME','TRADING_NAME','legal_name'],
   ['OWNER_EMAIL','SUPPORT_EMAIL','owner_email'],
  ].map(([first,second,businessField])=>[
   data=>{data.fields=[first,second].map(name=>({name,label:'Profile value',kind:'text',businessField}));},
   new RegExp(`(?=.*${first})(?=.*${second})(?=.*${businessField})`),
  ]),
  [data=>{data.fields[0].audience='admin';},/PROFILE.*audience.*owner.*developer/],
  [data=>{data.groups[0].audience='admin';},/technical.*audience.*owner.*developer/],
  [data=>{data.groups[0].audience='developer';data.fields[0].audience='owner';},/PROFILE.*owner.*developer.*technical/],
  [data=>{Object.assign(data.fields[0],{kind:'secret',required:false,ownerVisible:false,audience:'developer'});},/PROFILE.*secret.*audience/],
 ]){
  const candidate=structuredClone(base);mutate(candidate);
  const file=join(destination,'rer-setup.json');await writeFile(file,JSON.stringify(candidate));
  const result=spawnSync(process.execPath,[new URL('schema/validate.mjs',root).pathname,'--schema','SETUP',file],{encoding:'utf8'});
  assert.equal(result.status,1);if(message)assert.match(result.stderr,message);
  await assert.rejects(loadInstallerSeed(destination,{product:'Synthetic setup',setup:{manifestFile:'rer-setup.json'}}),message);
  await assert.rejects(loadShippedInstallerSeed(destination,{product:'Synthetic setup',setup:{manifestFile:'rer-setup.json'}}),message);
 }
});
test('onboarding vendors the exact portable Base schema and validators',async()=>{
 for(const name of ['SETUP.schema.json','json-schema.mjs','setup-validation.mjs','business-field-inputs.mjs']){
  assert.deepEqual(await readFile(new URL('onboarding/schema/'+name,root)),await readFile(new URL('schema/'+name,root)));
 }
 for(const name of ['json-schema.mjs','setup-validation.mjs','business-field-inputs.mjs'])assert.doesNotMatch(await readFile(new URL('schema/'+name,root),'utf8'),/node:/);
});
test('a standalone installer copy reads the manifest and validates its declared answers', async t=>{
 const destination=await mkdtemp(join(tmpdir(),'copied-setup-reader-'));
 t.after(()=>rm(destination,{recursive:true,force:true}));
 await cp(new URL('onboarding/',root),join(destination,'kit'),{recursive:true});
 const publicDefaults={SESSION_SECRET:'session label',APITOKEN:'API label',ENCRYPTIONKEY:'encryption label'};
 const hintedPublicFields=Object.fromEntries(Object.entries(BUSINESS_FIELD_INPUTS).slice(0,5).map(([field,names])=>[names[0],field]));
 const manifest={schema:1,title:'Independent setup',groups:[],fields:[
  {name:'WORKSPACE_TITLE',label:'Workspace title',kind:'text',required:true},
  {name:'CONNECTION_PASSWORD',label:'Connection password',kind:'secret',input:'entered',ownerVisible:true,required:true},
  {name:'AUTH_MODE',label:'Authentication mode',kind:'select',required:true,default:'local',options:[{value:'local',label:'Local'},{value:'oidc',label:'OIDC'}]},
  {name:'COOKIE_CONSENT',label:'Cookie consent',kind:'text',required:true,default:'essential'},
  ...Object.entries(publicDefaults).map(([name,value])=>({name,label:'Public label',kind:'text',required:true,default:value})),
  ...Object.entries(hintedPublicFields).map(([name,businessField])=>({name,label:'Business value',kind:'text',businessField,default:'A business default'})),
 ],steps:[{type:'extension',id:'workspace'}]};
 await writeFile(join(destination,'rer-setup.json'),JSON.stringify(manifest));
 for(const path of [pathToFileURL(join(destination,'kit/setup-manifest.mjs')).href,new URL('../onboarding/setup-manifest.mjs',import.meta.url).href,new URL('../default-seed/scripts/base-onboarding/setup-manifest.mjs',import.meta.url).href]){
  const {loadInstallerSeed}=await import(path);
  const seed=await loadInstallerSeed(destination,{product:'Independent setup',setup:{manifestFile:'rer-setup.json'}});
  assert.equal(seed.model.initialDraft({}).AUTH_MODE,'local');
  assert.equal(seed.model.initialDraft({}).COOKIE_CONSENT,'essential');
  assert.ok(seed.model.safeKeys.includes('AUTH_MODE'));
  assert.ok(seed.model.safeKeys.includes('COOKIE_CONSENT'));
  for(const [name,value] of Object.entries(publicDefaults)){
   assert.equal(seed.model.fieldDefinition(name,{}).kind,'text',name);
   assert.equal(seed.model.initialDraft({})[name],value,name);
   assert.ok(seed.model.safeKeys.includes(name),name);
  }
  for(const [name,businessField] of Object.entries(hintedPublicFields)){
   assert.equal(seed.model.fieldDefinition(name,{}).businessField,businessField,name);
   assert.equal(seed.model.initialDraft({})[name],'A business default',name);
   assert.ok(seed.model.safeKeys.includes(name),name);
  }
  assert.throws(()=>seed.model.validateInput({WORKSPACE_TITLE:'A workspace'}),/required setup inputs/);
  const answers=seed.model.validateInput({WORKSPACE_TITLE:'A workspace',CONNECTION_PASSWORD:'fixture-passphrase',AUTH_MODE:'oidc',COOKIE_CONSENT:'essential only',...Object.fromEntries(Object.keys(publicDefaults).map(name=>[name,`Public answer for ${name}`])),...Object.fromEntries(Object.keys(hintedPublicFields).map(name=>[name,`Business answer for ${name}`]))});
  assert.equal(answers.WORKSPACE_TITLE,'A workspace');
  assert.ok(answers.CONNECTION_PASSWORD==='fixture-passphrase','entered secret remains in installation input');
  assert.equal(answers.AUTH_MODE,'oidc');
  assert.equal(answers.COOKIE_CONSENT,'essential only');
  for(const name of Object.keys(publicDefaults))assert.equal(answers[name],`Public answer for ${name}`,name);
  for(const name of Object.keys(hintedPublicFields))assert.equal(answers[name],`Business answer for ${name}`,name);
  assert.throws(()=>seed.model.validateInput({...answers,UNDECLARED:'value'}),/Undeclared setup input/);
 }
});
