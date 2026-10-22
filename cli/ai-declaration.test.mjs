import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {portabilityFixture} from './fixtures/portability.mjs';

test('rer check reports the native declaration and refuses seed-supplied price authority',async t=>{
 const seed=await portabilityFixture(t,{generated:false});
 const ai={schema:1,provider:'cloudflare',transport:'native',binding:'AI',budgetBinding:'AI_BUDGET',imageBinding:'AI_IMAGES',textModels:['@cf/qwen/qwen3.8-27b'],imageModels:[],purposes:[{id:'site-read',kind:'text',model:'@cf/qwen/qwen3.8-27b'}],limits:{calls:0,units:0,microUsd:0},operations:{textCalls:2,maxInputBytes:10000,maxOutputTokens:1024,imageUnits:0,timeoutMs:20000}};
 const save=value=>writeFile(join(seed.root,'rer-packaging.json'),JSON.stringify({artifact:{specInputs:{ai:value}}}));
 await save(ai);
 const allowed=await seed.run(['check']);assert.ok(allowed.at(-1).clauses.some(c=>c.id.startsWith('delivery.ai.')&&c.ok));
 await save({...ai,prices:{version:'synthetic-cli-sentinel'}});
 const refused=await seed.run(['check'],1);assert.ok(refused.at(-1).clauses.some(c=>c.id.startsWith('delivery.ai.')&&!c.ok));
 assert.ok(!JSON.stringify(refused).includes('synthetic-cli-sentinel'));
 await save(ai);
 const owner=JSON.parse(await readFile(join(seed.root,'deploy.json'),'utf8'));
 await writeFile(join(seed.root,'deploy.json'),JSON.stringify({...owner,ai}));
 const owned=await seed.run(['check']);assert.ok(owned.at(-1).clauses.some(c=>c.id==='delivery.ai.deploy.json'&&c.ok));
});

test('native AI installation recovery is refused before archive or database mutation',async t=>{
 const seed=await portabilityFixture(t,{generated:false});
 await seed.run(['export','--output','exports/before-ai.rer']);
 const owner=JSON.parse(await readFile(join(seed.root,'deploy.json'),'utf8'));
 await writeFile(join(seed.root,'deploy.json'),JSON.stringify({...owner,ai:{schema:1}}));
 const result=await seed.run(['import','--input','exports/before-ai.rer','--yes'],4);
 assert.ok(JSON.stringify(result).includes('ai_reconciliation_required'));
});
