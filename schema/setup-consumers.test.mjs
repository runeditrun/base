import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,cp,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
const root=new URL('../',import.meta.url);
test('setup CLI and installer accept public business hints and developer audiences, inherit groups and retain owner defaults',async t=>{
 const destination=await mkdtemp(join(tmpdir(),'setup-audience-'));
 t.after(()=>rm(destination,{recursive:true,force:true}));
 const manifest={schema:1,title:'Workspace settings',groups:[{id:'technical',label:'Technical settings',audience:'developer'}],fields:[
  {name:'WORKSPACE_TITLE',label:'Workspace title',kind:'text',required:true},
  {name:'PROFILE',label:'Profile',kind:'text',audience:'developer'},
  {name:'SERVICE_URL',label:'Service address',kind:'url',group:'technical'},
 ],steps:[{type:'extension',id:'workspace'}]};
 const businessFields=['owner_email','legal_name','timezone','currency','jurisdiction','mail_sender','display_name','owner_name','brand_color','logo_ref','entity_type','state_of_organization','fiscal_year_start','books_start_date','tax_method','country','state'];
 const publicKinds=['text','email','url','select','colour','timezone'];
 for(const [index,businessField] of businessFields.entries()){
  const kind=publicKinds[index%publicKinds.length];
  manifest.fields.push({name:`SYNTHETIC_SETUP_${index}`,label:`Synthetic setup ${index}`,kind,businessField,...(kind==='select'?{options:[{value:'synthetic-base-1',label:'Synthetic option'}]}:{})});
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
 for(const [index,businessField] of businessFields.entries())assert.equal(model.fieldDefinition(`SYNTHETIC_SETUP_${index}`,{}).businessField,businessField);
 const input={WORKSPACE_TITLE:'synthetic-base-1',PROFILE:'local',SERVICE_URL:'https://service.example.test'};
 for(const name of Object.keys(input))assert.equal(model.fieldVisible(name,input),true);
 assert.equal(model.validateInput(input).SERVICE_URL,input.SERVICE_URL);
 manifest.fields[0].audience='owner';
 manifest.fields[2].audience='developer';
 await writeFile(file,JSON.stringify(manifest));
 assert.equal((await loadInstallerSeed(destination,{product:'Workspace',setup:{manifestFile:'rer-setup.json'}})).model.fieldDefinition('WORKSPACE_TITLE',{}).audience,'owner');
});
test('setup CLI and installer refuse unknown business hints, hints on secrets, unknown audiences and owner overrides',async t=>{
 const destination=await mkdtemp(join(tmpdir(),'invalid-setup-audience-'));
 t.after(()=>rm(destination,{recursive:true,force:true}));
 const base={schema:1,title:'Settings',groups:[{id:'technical',label:'Technical settings'}],fields:[
  {name:'PROFILE',label:'Profile',kind:'text',group:'technical'},
 ],steps:[{type:'extension',id:'workspace'}]};
 const {loadInstallerSeed}=await import('../onboarding/setup-manifest.mjs');
 for(const [mutate,message] of [
  [data=>{data.fields[0].businessField='unknown_business_field';},/businessField.*not one of/],
  [data=>{data.fields[0].businessField=null;},/businessField.*not one of/],
  [data=>{Object.assign(data.fields[0],{kind:'secret',required:false,ownerVisible:true,input:'entered',businessField:'owner_email'});},/kind is "secret".*excluded schema/],
  [data=>{Object.assign(data.fields[0],{kind:'secret',required:false,ownerVisible:false,input:'managed',businessField:'legal_name'});},/kind is "secret".*excluded schema/],
  [data=>{Object.assign(data.fields[0],{kind:'secret',required:false,ownerVisible:false,generate:'hex',businessField:'mail_sender'});},/kind is "secret".*excluded schema/],
  [data=>{data.fields[0].audience='admin';},/PROFILE.*audience.*owner.*developer/],
  [data=>{data.groups[0].audience='admin';},/technical.*audience.*owner.*developer/],
  [data=>{data.groups[0].audience='developer';data.fields[0].audience='owner';},/PROFILE.*owner.*developer.*technical/],
  [data=>{Object.assign(data.fields[0],{kind:'secret',required:false,ownerVisible:false,audience:'developer'});},/PROFILE.*secret.*audience/],
 ]){
  const candidate=structuredClone(base);mutate(candidate);
  const file=join(destination,'rer-setup.json');await writeFile(file,JSON.stringify(candidate));
  const result=spawnSync(process.execPath,[new URL('schema/validate.mjs',root).pathname,'--schema','SETUP',file],{encoding:'utf8'});
  assert.equal(result.status,1);assert.match(result.stderr,message);
  await assert.rejects(loadInstallerSeed(destination,{product:'Synthetic setup',setup:{manifestFile:'rer-setup.json'}}),message);
 }
});
test('onboarding vendors the exact portable Base schema and validators',async()=>{
 for(const name of ['SETUP.schema.json','json-schema.mjs','setup-validation.mjs']){
  assert.deepEqual(await readFile(new URL('onboarding/schema/'+name,root)),await readFile(new URL('schema/'+name,root)));
 }
 for(const name of ['json-schema.mjs','setup-validation.mjs'])assert.doesNotMatch(await readFile(new URL('schema/'+name,root),'utf8'),/node:/);
});
test('a standalone installer copy reads the manifest and validates its declared answers', async t=>{
 const destination=await mkdtemp(join(tmpdir(),'copied-setup-reader-'));
 t.after(()=>rm(destination,{recursive:true,force:true}));
 await cp(new URL('onboarding/',root),join(destination,'kit'),{recursive:true});
 const manifest={schema:1,title:'Independent setup',groups:[],fields:[
  {name:'WORKSPACE_TITLE',label:'Workspace title',kind:'text',required:true},
  {name:'CONNECTION_PASSWORD',label:'Connection password',kind:'secret',input:'entered',ownerVisible:true,required:true},
 ],steps:[{type:'extension',id:'workspace'}]};
 await writeFile(join(destination,'rer-setup.json'),JSON.stringify(manifest));
 const {loadInstallerSeed}=await import(pathToFileURL(join(destination,'kit/setup-manifest.mjs')));
 const seed=await loadInstallerSeed(destination,{product:'Independent setup',setup:{manifestFile:'rer-setup.json'}});
 assert.throws(()=>seed.model.validateInput({WORKSPACE_TITLE:'A workspace'}),/required setup inputs/);
 const answers=seed.model.validateInput({WORKSPACE_TITLE:'A workspace',CONNECTION_PASSWORD:'fixture-passphrase'});
 assert.equal(answers.WORKSPACE_TITLE,'A workspace');
 assert.ok(answers.CONNECTION_PASSWORD==='fixture-passphrase','entered secret remains in installation input');
 assert.throws(()=>seed.model.validateInput({...answers,UNDECLARED:'value'}),/Undeclared setup input/);
});
