import { namedSteps, caseRows } from '../../review-harness/tests/fold-steps.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,cp,writeFile,readFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {loadSetupManifest} from '../setup-manifest.mjs';
import {producePackage} from '../package.mjs';
test("setup consumers bind identical committed canonical manifest bytes and their digest", async t => {
  await caseRows(t, [["setup consumers bind identical committed canonical manifest bytes and their digest", async t => {
  const step = namedSteps(t);
  await step('root rer-setup.json must already use JSON.stringify(manifest, null, 2) plus newline',async t=>{
   const root=await mkdtemp(join(tmpdir(),'canonical-setup-'));t.after(()=>rm(root,{recursive:true,force:true}));
   const value=JSON.parse(await readFile(new URL('../../../schema/SETUP.example.json',import.meta.url)));
   await writeFile(join(root,'rer-setup.json'),JSON.stringify(value));
   await assert.rejects(loadSetupManifest(root,{manifestFile:'rer-setup.json'}),/rer-setup.json.*canonical.*JSON.stringify/);
   await writeFile(join(root,'other.json'),JSON.stringify(value));assert.deepEqual((await loadSetupManifest(root,{manifestFile:'other.json'})).manifest,value);
  });

  await step('default-seed installer and package bind identical committed manifest bytes',async t=>{
   const scratch=await mkdtemp(join(tmpdir(),'cross-consumer-'));t.after(()=>rm(scratch,{recursive:true,force:true}));
   const root=join(scratch,'default-seed');
   await cp(new URL('../../../default-seed/',import.meta.url),root,{recursive:true,filter:source=>!source.split('/').some(part=>['node_modules','.wrangler','dist'].includes(part))});
   await cp(new URL('../../../onboarding/',import.meta.url),join(scratch,'onboarding'),{recursive:true});
   const {createSeed}=await import(pathToFileURL(join(root,'scripts/installer/seed.mjs')).href);
   const {loadInstallerSeed}=await import('../../../onboarding/setup-manifest.mjs');
   const seed=await loadInstallerSeed(root,createSeed());
   const bytes=await readFile(join(root,'rer-setup.json'));
   assert.deepEqual(seed.manifestBytes,bytes,'the installer consumes the committed manifest bytes');
   await mkdir(join(root,'dist/server'),{recursive:true});await mkdir(join(root,'dist/client'),{recursive:true});
   await writeFile(join(root,'dist/server/wrangler.json'),'{"compatibility_date":"2026-09-08"}');await writeFile(join(root,'dist/server/index.js'),'export default {};');await writeFile(join(root,'dist/client/index.html'),'<main>Reference</main>');
   const config={schema:1,setup:{manifestFile:'rer-setup.json'},project:{schema:1,projectId:'publisher/app',name:'Reference',sourceRepository:'publisher/app',license:'MIT',deployment:{target:'cloudflare-workers',artifactFile:'reference.json'},operations:{build:'make build',verify:'make verify',artifact:'make artifact',recovery:'Restore retained data.'}},managed:{workflowRef:`publisher/delivery/.github/workflows/trusted-build.yml@${'a'.repeat(40)}`,artifactFile:'reference.json',buildProfile:'project',verificationProfiles:['full']},artifact:{specInputs:{recovery:'Restore retained data.',providerEffects:[],surfaces:{app:{path:'/',originVariable:'AUTH_ORIGIN'}},initialSetup:{path:'/setup-status',pendingStatus:409,completeStatus:200}}}};
   const output=await producePackage({root,config});assert.deepEqual(await readFile(output.setup),bytes);assert.deepEqual(await readFile(join(root,'rer-setup.json')),bytes);
   assert.equal(JSON.parse(await readFile(output.project)).setup.sha256,createHash('sha256').update(bytes).digest('hex'));
  });

  }]]);
})
