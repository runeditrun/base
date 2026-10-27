import test from 'node:test';
import { caseRows } from './fold-case.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cloudflare } from '../provider.mjs';
import { ownerTarget, ownerPlan, ownerDeploy } from '../owner.mjs';
import { ownerRemove } from '../owner-remove.mjs';
import { hash } from '../validation.mjs';
import { ownerProvider } from './owner-provider.mjs';

async function fixture(t) {
 const provider = ownerProvider({creationDates:true}), directory = await realpath(await mkdtemp(join(tmpdir(),'owned-r2-remove-')));
 t.after(async () => { provider.close(); await rm(directory,{recursive:true,force:true}); });
 let intercept = () => {};
 const request = async (input,init) => await intercept(input,init) ?? provider.fetch(input,init);
 const api = cloudflare({...provider, fetch:request, objectDelete:(path, options) => request(`https://api.cloudflare.com${path}`, {...options,method:'DELETE'})});
 const target = await ownerTarget(api,{project:'tests/remove',environment:'production'});
 const source = 'export default {fetch(){}}';
 const artifact = {version:1,source:{sha:hash(source).slice(0,40),tree:'6'.repeat(40)},run:{id:'0',attempt:'1'},main:'index.js',modules:[{path:'index.js',base64:Buffer.from(source).toString('base64'),sha256:hash(source)}],assets:[],migrations:[]};
 const plan = ownerPlan(target,{version:1,project:'tests/remove',compatibilityDate:'2026-09-08',r2:[{binding:'FILES'}]},artifact);
 const statePath = join(directory,'production.json');
 await ownerDeploy({api,target,plan,artifact,statePath,env:{},fetch:provider.fetch});
 const name = plan.r2[0].name, objects = new Map([['a first',Buffer.from('first')],['z last',Buffer.from('last')]]);
 provider.state.objects.set(name, objects);
 const saved = JSON.parse(await readFile(statePath,'utf8'));
 return {...provider,api,target,statePath,name,objects,saved,intercept: fn => {intercept=fn;},remove: () => ownerRemove({api,target,statePath})};
}

test('owned R2 removal retains proof on interrupted purge and refuses replacements and incomplete readback', async t => {
 await caseRows(t, await (async () => {
    const rows = [];
    for (const scenario of ['replacement-after-preflight','replacement-during-purge','partial-delete','bucket-remains','incomplete-pagination']) rows.push([scenario, async t => {
  const f = await fixture(t);
  let replaced = false;
  f.intercept(async (input, init = {}) => {
   const url = new URL(input), method = init.method ?? 'GET';
   if (!replaced && ((scenario === 'replacement-after-preflight' && method === 'DELETE' && url.pathname.endsWith('/workers/scripts/remove-production')) || (scenario === 'replacement-during-purge' && method === 'DELETE' && url.pathname.includes('/objects/')))) {
    const response = await f.fetch(input,init);
    f.state.buckets[0].creation_date = '2030-01-01T00:00:00.000Z'; replaced = true;
    f.objects.set('replacement-data',Buffer.from('foreign'));
    return response;
   }
   if (scenario === 'bucket-remains' && method === 'DELETE' && url.pathname.endsWith(`/r2/buckets/${f.name}`)) return Response.json({success:true,result:{}});
   if (scenario === 'incomplete-pagination' && url.pathname.endsWith('/objects')) return Response.json({success:true,result:[{key:'a first'}],result_info:{is_truncated:true}});
  });
  if (scenario === 'partial-delete') f.fail('DELETE', /\/objects\/z%20last$/, {status:403});
  await assert.rejects(f.remove(), error => {
   assert.equal(error.message,'remove-incomplete');
   assert.deepEqual(error.remaining,[`r2:${f.name}`]);
   if (scenario.startsWith('replacement')) assert.equal(error.failed[0].code,'owned-resource-replaced');
   if (scenario === 'partial-delete') assert.equal(error.failed[0].code,'token-scope-missing-r2');
   if (scenario === 'incomplete-pagination') assert.equal(error.failed[0].code,'provider-incomplete-pagination');
   if (scenario === 'bucket-remains') assert.deepEqual(error.removed,['worker:remove-production']);
   return true;
  });
  const state = JSON.parse(await readFile(f.statePath,'utf8'));
  assert.deepEqual(state.owned.r2, f.saved.owned.r2);
  assert.equal(state.owned.worker,null);
  assert.equal(f.state.buckets.length,1);
  if (scenario === 'replacement-after-preflight') assert.equal(f.objects.size,3, 'replacement detected before any object deletion');
  if (scenario === 'replacement-during-purge') assert.equal(f.objects.get('replacement-data').toString(),'foreign');
  if (scenario === 'partial-delete') {
   assert.deepEqual([...f.objects.keys()],['z last']);
   await f.remove();
   assert.equal(f.state.buckets.length,0);
  }
  if (scenario === 'incomplete-pagination') assert.equal(f.objects.size,2);
 }]);
    return rows;
  })());
});

test('owned R2 removal purges short object listings without metadata and refuses ambiguous pages', async t => {
 const keys = [
  'issues/01M4Z5M6QSXHVE57A0H79TGRRM/01M4Z5N128HB91117VG46N6FV0',
  'issues/01M4Z5M6QSXHVE57A0H79TGRRM/01M4Z5N3F64S7RZ5R15555HF88',
 ];
 await caseRows(t, await (async () => {
    const rows = [];
    for (const scenario of ['absent','null','cursor','full-absent','full-null','missing-cursor','terminal-cursor','duplicate']) rows.push([scenario, async t => {
  const f = await fixture(t), listed = [];
  f.objects.clear();
  for (const key of keys) f.objects.set(key, Buffer.from('stored data'));
  f.intercept((input, init = {}) => {
   const url = new URL(input);
   if (url.pathname.endsWith('/objects')) {
    listed.push(url);
    let rows = [...f.objects.keys()].map(key => ({key, size:f.objects.get(key).length})), info;
    if (scenario === 'null' || scenario === 'full-null') info = null;
    if (scenario.startsWith('full-')) rows = Array.from({length:Number(url.searchParams.get('per_page'))}, (_, i) => ({key:`object-${i}`}));
    if (scenario === 'missing-cursor') info = {is_truncated:true};
    if (scenario === 'terminal-cursor') info = {is_truncated:false,cursor:'unexpected'};
    if (scenario === 'duplicate') rows = [rows[0],rows[0]];
    if (scenario === 'cursor') {
     if (listed.length === 1) { rows = rows.slice(0,1); info = {is_truncated:true,cursor:'next+/='}; }
     else assert.equal(url.searchParams.get('cursor'), 'next+/=');
    }
    return Response.json({success:true,errors:[],messages:[],result:rows,...(info === undefined ? {} : {result_info:info})});
   }
  });
  if (['absent','null','cursor'].includes(scenario)) {
   const result = await f.remove();
   assert.deepEqual(result.remaining, []);
   assert.equal(f.objects.size,0);
   assert.equal(f.state.buckets.length,0);
   await assert.rejects(readFile(f.statePath), {code:'ENOENT'});
   assert.equal(listed.length,scenario === 'cursor' ? 2 : 1);
  } else {
   await assert.rejects(f.remove(), error => {
    assert.equal(error.message,'remove-incomplete');
    assert.deepEqual(error.remaining,[`r2:${f.name}`]);
    assert.equal(error.failed[0].code,scenario.startsWith('full-') ? 'provider-incomplete-pagination' : scenario === 'duplicate' ? 'invalid-r2-object-list' : scenario === 'missing-cursor' ? 'provider-incomplete-pagination' : 'provider-invalid-cursor');
    return true;
   });
   assert.deepEqual([...f.objects.keys()],keys);
   assert.equal(f.state.buckets.length,1);
   assert.deepEqual(JSON.parse(await readFile(f.statePath,'utf8')).owned.r2,f.saved.owned.r2);
  }
 }]);
    return rows;
  })());
});
