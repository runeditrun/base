import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {deploymentSpec} from '../spec.mjs';
import {deliveryDeclarationClauses} from '../../../cli/delivery-declarations.mjs';
import {ownerPlan} from '../../deploy-kit/owner.mjs';
import {verifyBindings} from '../../deploy-kit/render.mjs';
import {nativeBindings} from '../../demo-host/native/config.mjs';
const ai={schema:1,provider:'cloudflare',transport:'native',binding:'AI',budgetBinding:'AI_BUDGET',imageBinding:'AI_IMAGES',textModels:['@cf/qwen/qwen3.8-27b'],imageModels:['@cf/black-forest-labs/flux-2-dev'],purposes:[{id:'site-read',kind:'text',model:'@cf/qwen/qwen3.8-27b'},{id:'house-style',kind:'image',model:'@cf/black-forest-labs/flux-2-dev'}],limits:{calls:10,units:1000000,microUsd:1000000},operations:{textCalls:2,maxInputBytes:10000,maxOutputTokens:1024,imageUnits:100,timeoutMs:1000}};

test('native AI packaging and rer check preserve strict capability requests without granting authority',async t=>{
 const root=await mkdtemp(join(tmpdir(),'ai-declaration-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(join(root,'dist/server'),{recursive:true});
 const config={compatibility_date:'2026-09-08',ai:{binding:'AI'},r2_buckets:[{binding:'AI_IMAGES'}],durable_objects:{bindings:[{name:'AI_BUDGET',class_name:'AiAuthority'}]},migrations:[{tag:'ai-v1',new_sqlite_classes:['AiAuthority']}]};
 const save=()=>writeFile(join(root,'dist/server/wrangler.json'),JSON.stringify(config));await save();
 const options={ai,recovery:'AI custody is not portable; disable until reconciled.'};
 const spec=await deploymentSpec(root,options);assert.deepEqual(spec.ai,ai);assert.equal(spec.resources[0].binding,'AI_IMAGES');
 await writeFile(join(root,'rer-packaging.json'),JSON.stringify({artifact:{specInputs:options}}));
 assert.ok((await deliveryDeclarationClauses(root)).some(c=>c.id.startsWith('delivery.ai.')&&c.ok));
 for(const change of [{...ai,prices:{}},{...ai,provider:'other'},{...ai,binding:'AI_IMAGES'},{...ai,textModels:['@app/alias']},{...ai,purposes:[{...ai.purposes[0],unknown:true}]}])await assert.rejects(deploymentSpec(root,{...options,ai:change}));
 await assert.rejects(deploymentSpec(root,{recovery:'None'}));
 config.ai.account_id='untrusted';await save();await assert.rejects(deploymentSpec(root,options));
 delete config.ai.account_id;config.durable_objects.bindings=[];await save();await assert.rejects(deploymentSpec(root,options));
});

test('unproved owner hosting, native demo and undeclared readback bindings are refused',()=>{
 assert.throws(()=>ownerPlan({project:'synthetic',worker:'synthetic-production',environment:'production'},{version:1,ai},{migrations:[]}),e=>e.code==='ai_hosting_unproven');
 assert.throws(()=>nativeBindings({ai:{binding:'AI'}}),/cannot bind ai/);
 assert.throws(()=>verifyBindings([{type:'ai',name:'AI'}],[]),/undeclared-native-ai-binding/);
});
