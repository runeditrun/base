import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {deploymentSpec,validateCandidateSpec} from '../spec.mjs';
import {deliveryDeclarationClauses} from '../../../cli/delivery-declarations.mjs';
import {ownerPlan} from '../../deploy-kit/owner.mjs';
import {verifyBindings} from '../../deploy-kit/render.mjs';
import {nativeBindings} from '../../demo-host/native/config.mjs';
const ai={schema:1,provider:'cloudflare',transport:'native',binding:'AI',budgetBinding:'AI_BUDGET',imageBinding:'AI_IMAGES',textModels:['@cf/qwen/qwen3.8-27b'],imageModels:['@cf/black-forest-labs/flux-2-dev'],purposes:[{id:'site-read',kind:'text',model:'@cf/qwen/qwen3.8-27b'},{id:'house-style',kind:'image',model:'@cf/black-forest-labs/flux-2-dev'}],limits:{calls:10,units:1000000,microUsd:1000000},operations:{textCalls:2,maxInputBytes:10000,maxOutputTokens:1024,imageUnits:100,timeoutMs:1000}};

test('a delivery package, its declarations and rer check refuse native AI before producing anything',async t=>{
 const root=await mkdtemp(join(tmpdir(),'ai-declaration-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(join(root,'dist/server'),{recursive:true});
 const config={compatibility_date:'2026-09-08',r2_buckets:[{binding:'AI_IMAGES'}],durable_objects:{bindings:[{name:'AI_BUDGET',class_name:'AiAuthority'}]},migrations:[{tag:'ai-v1',new_sqlite_classes:['AiAuthority']}]};
 const save=()=>writeFile(join(root,'dist/server/wrangler.json'),JSON.stringify(config));await save();
 const recovery='AI custody is not portable; disable until reconciled.';
 await assert.rejects(deploymentSpec(root,{ai,recovery}),e=>e.code==='ai_hosting_unproven');
 const spec=await deploymentSpec(root,{recovery});
 assert.throws(()=>validateCandidateSpec({...spec,ai}),e=>e.code==='ai_hosting_unproven');
 await writeFile(join(root,'rer-packaging.json'),JSON.stringify({artifact:{specInputs:{ai,recovery}}}));
 assert.ok((await deliveryDeclarationClauses(root)).some(c=>c.id==='delivery.declarations.rer-packaging.json'&&!c.ok&&/ai_hosting_unproven/.test(c.message)));
 // A raw Wrangler AI binding stays an unsupported binding.
 config.ai={binding:'AI'};await save();await assert.rejects(deploymentSpec(root,{recovery}),/Unsupported deployment binding: ai/);
});

test('unproved owner hosting, native demo and undeclared readback bindings are refused',()=>{
 assert.throws(()=>ownerPlan({project:'synthetic',worker:'synthetic-production',environment:'production'},{version:1,ai},{migrations:[]}),e=>e.code==='ai_hosting_unproven');
 assert.throws(()=>nativeBindings({ai:{binding:'AI'}}),/cannot bind ai/);
 assert.throws(()=>verifyBindings([{type:'ai',name:'AI'}],[]),/undeclared-native-ai-binding/);
});
