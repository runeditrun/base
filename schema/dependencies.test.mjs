import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {validateSetupManifest,validateDependencyGraph} from './setup-validation.mjs';
const schema=JSON.parse(await readFile(new URL('SETUP.schema.json',import.meta.url))),example=JSON.parse(await readFile(new URL('../default-seed/rer-setup.json',import.meta.url)));
test('dependency reader validates references, paths, interface lists and the complete optional transitive graph',()=>{
 assert.deepEqual(validateSetupManifest(schema,example),[]);
 for(const change of [m=>m.dependencies.push({...m.dependencies[0]}),m=>m.dependencies[0].address='NO_FIELD',m=>m.dependencies[0].paths=['//elsewhere/x'],m=>m.dependencies[0].paths=['/a/../callback'],m=>m.dependencies[0].paths=['/callback','/callback'],m=>m.dependencies='bad',m=>m.provides=['oidc-provider@1'],m=>m.provides=['error-sink@1','error-sink@1'],m=>m.dependencies[0].cardinality=2]){const m=structuredClone(example);change(m);assert.notEqual(validateSetupManifest(schema,m).length,0);}
 assert.doesNotThrow(()=>validateDependencyGraph([{id:'app',dependencies:['auth']},{id:'auth',dependencies:[]}]));
 assert.throws(()=>validateDependencyGraph([{id:'app',dependencies:['a']},{id:'a',dependencies:['b']},{id:'b',dependencies:['app']}]));
 assert.throws(()=>validateDependencyGraph([{id:'app',dependencies:['absent']}]));
 const idp=structuredClone(example);idp.steps=[{type:'owner-claim',mode:'idp',emailField:'OWNER_EMAIL',dependency:'oidc-provider@1',path:'/auth/owner-claim'}];assert.deepEqual(validateSetupManifest(schema,idp),[]);
 for(const edit of [s=>s.tokenField='SETUP_TOKEN',s=>s.dependency='error-sink@1',s=>s.path='/other']){const m=structuredClone(idp);edit(m.steps[0]);assert.notEqual(validateSetupManifest(schema,m).length,0);}
});
