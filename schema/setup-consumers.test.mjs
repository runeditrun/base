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
 // Similar letters in ordinary Business names must not trigger the refusal.
 for(const name of ['DISPLAY_NAME','SUPPORT_EMAIL','TIMEZONE','BUSINESS_NAME','LEGAL_NAME','WEBSITE','KEYBOARD_LAYOUT','MONKEY_NAME','TOKENIZER_LANG','AUTHOR_NAME','PASSPORT_COUNTRY','PATCH_POLICY','SIGNAL_REGION','SECRETARY_NAME','TOKENIZATION_LANGUAGE']){
  const candidate={...manifest,fields:[{name,label:'Business value',kind:'text',businessField:'display_name'}]};
  await writeFile(file,JSON.stringify(candidate));
  assert.equal(spawnSync(process.execPath,[new URL('schema/validate.mjs',root).pathname,'--schema','SETUP',file],{encoding:'utf8'}).status,0,name);
  for(const path of ['../onboarding/setup-manifest.mjs','../default-seed/scripts/base-onboarding/setup-manifest.mjs']){
   const {loadInstallerSeed:load}=await import(path);
   const {model:publicModel}=await load(destination,{product:'Business',setup:{manifestFile:'rer-setup.json'}});
   assert.equal(publicModel.validateInput({[name]:'A business value'})[name],'A business value',name);
  }
 }
 manifest.fields[0].audience='owner';
 manifest.fields[2].audience='developer';
 await writeFile(file,JSON.stringify(manifest));
 assert.equal((await loadInstallerSeed(destination,{product:'Workspace',setup:{manifestFile:'rer-setup.json'}})).model.fieldDefinition('WORKSPACE_TITLE',{}).audience,'owner');
});
test('setup CLI and installer consumers refuse invalid business hints, sensitive inputs, duplicate claims, audiences and owner overrides',async t=>{
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
  ...[
   'SESSION_SECRET','API_KEY','MAIL_API_KEY','STRIPE_SECRET_KEY',
   'RER_IDENTITY_PRIVATE_KEY','OPAQUE_CREDENTIAL','SETUP_TOKEN','DATABASE_PASSWORD',
   'ACCESSKEY','apikey','privateKey','dbPassword','clientSecret',
   'AUTH_TOKEN','SIGNING_KEY','RER_PROFILE','rer_profile','CREDENTIALS',
   'APITOKEN','CLIENTSECRET','DATABASEPASSWORD','SERVICECREDENTIAL',
   'GITHUBTOKEN','WEBHOOKSECRET','SMTPPASSWORD','DBPASSWD','BACKUPPASSPHRASE',
   'OAUTHCREDENTIAL','PAYMENTAPIKEY','SSHPRIVATEKEY','AWSACCESSKEY','JWTSIGNINGKEY',
   'sessionToken','clientSECRET','databasePassword','serviceCredential',
   'servicetoken','clientsecret','accountcredential','serviceApiKey',
   'mailPrivateKey','cloudAccessKey','jwtSigningKey','serverKey2','clientAuth2',
  ].map(name=>[
   data=>{Object.assign(data.fields[0],{name,businessField:'legal_name'});},
   new RegExp(`(?=.*${name})(?=.*(?:secret|vault))`,'i'),
  ]),
  ...[
   ['LEGAL_NAME','TRADING_NAME','legal_name'],
   ['OWNER_EMAIL','CONTACT_EMAIL','owner_email'],
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
  assert.equal(result.status,1);assert.match(result.stderr,message);
  await assert.rejects(loadInstallerSeed(destination,{product:'Synthetic setup',setup:{manifestFile:'rer-setup.json'}}),message);
  await assert.rejects(loadShippedInstallerSeed(destination,{product:'Synthetic setup',setup:{manifestFile:'rer-setup.json'}}),message);
 }
});
test('onboarding vendors the exact portable Base schema and validators',async()=>{
 for(const name of ['SETUP.schema.json','json-schema.mjs','setup-validation.mjs','credential-names.mjs']){
  assert.deepEqual(await readFile(new URL('onboarding/schema/'+name,root)),await readFile(new URL('schema/'+name,root)));
 }
 for(const name of ['json-schema.mjs','setup-validation.mjs','credential-names.mjs'])assert.doesNotMatch(await readFile(new URL('schema/'+name,root),'utf8'),/node:/);
});
test('a standalone installer copy reads the manifest and validates its declared answers', async t=>{
 const destination=await mkdtemp(join(tmpdir(),'copied-setup-reader-'));
 t.after(()=>rm(destination,{recursive:true,force:true}));
 await cp(new URL('onboarding/',root),join(destination,'kit'),{recursive:true});
 const manifest={schema:1,title:'Independent setup',groups:[],fields:[
  {name:'WORKSPACE_TITLE',label:'Workspace title',kind:'text',required:true},
  {name:'CONNECTION_PASSWORD',label:'Connection password',kind:'secret',input:'entered',ownerVisible:true,required:true},
  {name:'AUTH_MODE',label:'Authentication mode',kind:'select',required:true,default:'local',options:[{value:'local',label:'Local'},{value:'oidc',label:'OIDC'}]},
  {name:'COOKIE_CONSENT',label:'Cookie consent',kind:'text',required:true,default:'essential'},
 ],steps:[{type:'extension',id:'workspace'}]};
 await writeFile(join(destination,'rer-setup.json'),JSON.stringify(manifest));
 for(const path of [pathToFileURL(join(destination,'kit/setup-manifest.mjs')).href,new URL('../onboarding/setup-manifest.mjs',import.meta.url).href,new URL('../default-seed/scripts/base-onboarding/setup-manifest.mjs',import.meta.url).href]){
  const {loadInstallerSeed}=await import(path);
  const seed=await loadInstallerSeed(destination,{product:'Independent setup',setup:{manifestFile:'rer-setup.json'}});
  assert.equal(seed.model.initialDraft({}).AUTH_MODE,'local');
  assert.equal(seed.model.initialDraft({}).COOKIE_CONSENT,'essential');
  assert.ok(seed.model.safeKeys.includes('AUTH_MODE'));
  assert.ok(seed.model.safeKeys.includes('COOKIE_CONSENT'));
  assert.throws(()=>seed.model.validateInput({WORKSPACE_TITLE:'A workspace'}),/required setup inputs/);
  const answers=seed.model.validateInput({WORKSPACE_TITLE:'A workspace',CONNECTION_PASSWORD:'fixture-passphrase',AUTH_MODE:'oidc',COOKIE_CONSENT:'essential only'});
  assert.equal(answers.WORKSPACE_TITLE,'A workspace');
  assert.ok(answers.CONNECTION_PASSWORD==='fixture-passphrase','entered secret remains in installation input');
  assert.equal(answers.AUTH_MODE,'oidc');
  assert.equal(answers.COOKIE_CONSENT,'essential only');
  assert.throws(()=>seed.model.validateInput({...answers,UNDECLARED:'value'}),/Undeclared setup input/);
 }
});
