import { checkCases } from '../onboarding/test-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {validateSetupManifest} from './setup-validation.mjs';

test("extension-only setup supports safe local defaults without inventing owner inputs or secret literals", () => checkCases([
  ['extension-only setup needs no invented owner input and still needs a step', async () => {
 const schema = JSON.parse(await readFile(new URL('./SETUP.schema.json', import.meta.url)));
 const manifest = {schema:1,title:'Branding',groups:[],fields:[{name:'APP_NAME',label:'Name',kind:'text',required:true}],steps:[{type:'extension',id:'branding'}]};
 assert.deepEqual(validateSetupManifest(schema, manifest), []);
 assert.ok(validateSetupManifest(schema, {...manifest,steps:[]}).length);
 assert.ok(validateSetupManifest(schema, {...manifest,fields:[...manifest.fields,{name:'OWNER_EMAIL',label:'Owner',kind:'email',prefill:'account-email'}]}).length);
}],
  ['a local default is a public literal, a generated entered secret or the local origin, and never a secret literal', async () => {
 const schema = JSON.parse(await readFile(new URL('./SETUP.schema.json', import.meta.url)));
 const fields = [
  {name:'WORKSPACE_NAME',label:'Workspace',kind:'text',required:true,localDefault:'Local workspace'},
  {name:'WIDGET_ORIGIN',label:'Widget origin',kind:'url',required:true,localDefault:{from:'origin'}},
  {name:'OWNER_PASSWORD',label:'Password',kind:'secret',input:'entered',ownerVisible:true,required:true,localDefault:{generate:'hex'}},
 ];
 const manifest = field => ({schema:1,title:'Local defaults',groups:[],fields:[...fields,...(field ? [field] : [])],steps:[{type:'extension',id:'workspace'}]});
 assert.deepEqual(validateSetupManifest(schema, manifest()), []);
 for (const field of [
  {name:'TOKEN',label:'Token',kind:'secret',input:'entered',ownerVisible:true,required:true,localDefault:'literal-secret'},
  {name:'TITLE',label:'Title',kind:'text',localDefault:{generate:'hex'}},
  {name:'CONTACT',label:'Contact',kind:'email',localDefault:{from:'origin'}},
  {name:'SITE',label:'Site',kind:'url',localDefault:{from:'origin',generate:'hex'}},
  {name:'HOME_URL',label:'Home',kind:'url',localDefault:'not a url'},
  {name:'MODE',label:'Mode',kind:'text',localDefault:{from:'elsewhere'}},
 ]) assert.ok(validateSetupManifest(schema, manifest(field)).length, `refused: ${JSON.stringify(field.localDefault)} on ${field.kind}`);
}]
]));
