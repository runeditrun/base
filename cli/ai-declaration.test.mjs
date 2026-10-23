import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {portabilityFixture} from './fixtures/portability.mjs';

test('rer check leaves the owner declaration to rer deploy and refuses native AI in a delivery declaration',async t=>{
 const seed=await portabilityFixture(t,{generated:false});
 const ai={schema:1,provider:'cloudflare',transport:'native',binding:'AI',budgetBinding:'AI_BUDGET',imageBinding:'AI_IMAGES',textModels:['@cf/qwen/qwen3.8-27b'],imageModels:[],purposes:[{id:'site-read',kind:'text',model:'@cf/qwen/qwen3.8-27b'}],limits:{calls:0,units:0,microUsd:0},operations:{textCalls:2,maxInputBytes:10000,maxOutputTokens:1024,imageUnits:0,timeoutMs:20000}};
 const owner=JSON.parse(await readFile(join(seed.root,'deploy.json'),'utf8'));
 await writeFile(join(seed.root,'deploy.json'),JSON.stringify({...owner,ai}));
 await seed.run(['check']);
 await writeFile(join(seed.root,'rer-packaging.json'),JSON.stringify({artifact:{specInputs:{ai:{...ai,prices:{version:'synthetic-cli-sentinel'}}}}}));
 const refused=await seed.run(['check'],1);
 assert.ok(refused.at(-1).clauses.some(c=>c.id==='delivery.declarations.rer-packaging.json'&&!c.ok&&/ai_hosting_unproven/.test(c.message)));
 assert.ok(!JSON.stringify(refused).includes('synthetic-cli-sentinel'));
});

test('native AI installation recovery is refused before archive or database mutation',async t=>{
 const seed=await portabilityFixture(t,{generated:false});
 await seed.run(['export','--output','exports/before-ai.rer']);
 const owner=JSON.parse(await readFile(join(seed.root,'deploy.json'),'utf8'));
 await writeFile(join(seed.root,'deploy.json'),JSON.stringify({...owner,ai:{schema:1}}));
 const result=await seed.run(['import','--input','exports/before-ai.rer','--yes'],4);
 assert.ok(JSON.stringify(result).includes('ai_reconciliation_required'));
});
