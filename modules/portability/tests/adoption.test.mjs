import { runCases } from './cases.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile,cp,mkdir,writeFile,mkdtemp,rm } from 'node:fs/promises';
import { resolve,dirname,join } from 'node:path';
import { tmpdir } from 'node:os';
import { cliJourney } from './cli-journey.mjs';
import { fixturePolicy } from './fixture-policy.mjs';
test('README runtime list copies a self-contained module into a fixture seed with real Worker and CLI round trip',async t=>{
  await runCases(t, [['independent journey rows', async t => {

  const readme=await readFile(new URL('../README.md',import.meta.url),'utf8'),section=readme.split('## Adopting\n')[1];
  const listed=section.match(/```text\n([\s\S]*?)\n```/)[1].split('\n');assert.ok(listed.length>10);
  const directory=await mkdtemp(join(tmpdir(),'portable-seed-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const root=new URL('../../../',import.meta.url).pathname,copied=join(directory,'vendor/base/modules/portability');
  await runCases(t, Array.from(listed, (file, rowIndex) => [`copy runtime file row ${rowIndex + 1}`, async t => {
const target=join(directory,'vendor/base',file);
    try {
      assert.ok(['modules/portability/','modules/d1-transport/'].some(prefix=>file.startsWith(prefix)) && !file.includes('/tests/'));
    } finally { await mkdir(dirname(target),{recursive:true});await cp(join(root,file),target); }
    assert.deepEqual(await readFile(target),await readFile(join(root,file)));
}]));
  await runCases(t, Array.from(listed.filter(x=>x.endsWith('.mjs')), (file, rowIndex) => [`inspect copied file row ${rowIndex + 1}`, async t => {

    const text=await readFile(join(directory,'vendor/base',file),'utf8');
    const dependencies = Array.from(text.matchAll(/(?:^\s*(?:import|export)\b[^\n]*?\bfrom\s*|\bimport\s*\()\s*['"]([^'"]+)['"]/gm));
    if (dependencies.length) await runCases(t, Array.from(dependencies, (match, rowIndex) => [`copied dependency row ${rowIndex + 1}`, async t => {

      const dependency=match[1];if(dependency.startsWith('node:')){assert.ok(file.includes('/cli'));return;}
      assert.ok(dependency.startsWith('.'),'runtime has no package dependency');const path=resolve(dirname(join(directory,'vendor/base',file)),dependency);
      const vendor=join(directory,'vendor/base');
      assert.ok(path.startsWith(vendor+'/modules/'),'import stays inside copied runtime');await readFile(path);
      assert.ok(listed.includes(path.slice(vendor.length+1)),'needed runtime is listed');

}]));

}]));
  const worker=join(directory,'worker.mjs'),policy=JSON.stringify({...fixturePolicy,exportRow:undefined});
  await writeFile(worker,`import {createPortabilityHandler} from './vendor/base/modules/portability/index.mjs';\nconst policy=${policy};policy.exportRow=(table,row)=>{if(table==='effects'){row.enabled=0;if(row.delivery==='queued')row.delivery='review';}return row;};\nexport default {async fetch(request,env){const handler=await createPortabilityHandler({db:env.DB,buckets:{FILES:env.FILES},policy,appOrigin:new URL(request.url).origin,authorize:req=>req.headers.get('Cookie')===env.TEST_COOKIE?'owner':null});return await handler(request)??new Response('missing',{status:404});}};`);
  await cliJourney(t,join(copied,'cli.mjs'),worker);

  }]]);
});
