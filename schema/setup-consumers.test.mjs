import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,cp,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
const root=new URL('../',import.meta.url);
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
