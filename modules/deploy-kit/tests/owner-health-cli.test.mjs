import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../owner-cli.mjs';
import { ownerProvider } from './owner-provider.mjs';

test('owner health CLI makes one request and preserves its state on transient failure',async t=>{
  const provider=ownerProvider();t.after(()=>provider.close());
  const root=await realpath(await mkdtemp(join(tmpdir(),'owner-health-cli-')));t.after(()=>rm(root,{recursive:true,force:true}));
  for (const path of ['dist/server','dist/client','migrations/core']) await mkdir(join(root,path),{recursive:true});
  await writeFile(join(root,'dist/server/wrangler.json'),JSON.stringify({main:'index.js',no_bundle:true,rules:[{type:'ESModule',globs:['**/*.js','**/*.mjs']}]}));
  await writeFile(join(root,'dist/server/index.js'),'export default {}');
  await writeFile(join(root,'dist/client/index.html'),'<h1>Health fixture</h1>');
  await writeFile(join(root,'migrations/core/0001_fixture.sql'),'CREATE TABLE fixture(id TEXT PRIMARY KEY);');
  const declaration={version:1,project:'runeditrun/healthprobe',compatibilityDate:'2026-09-08',compatibilityFlags:['nodejs_compat'],d1:[{binding:'DB'}],r2:[],secrets:[],vars:{}};
  await writeFile(join(root,'deploy.json'),JSON.stringify(declaration));
  await writeFile(join(root,'.gitignore'),'dist/\n.rer/\n');
  const git=(...args)=>execFileSync('git',['-c','user.email=fixture@example.test','-c','user.name=Fixture','-c','commit.gpgsign=false',...args],{cwd:root,stdio:'pipe'});
  git('init','-q');git('add','.');git('commit','-qm','fixture');
  const env={CLOUDFLARE_ACCOUNT_ID:provider.accountId,CLOUDFLARE_API_TOKEN:provider.token},options={fetch:provider.fetch,cwd:root};
  const argv=['--declaration','deploy.json','--environment','staging'];
  const deployment=await main(['deploy',...argv],env,options),state=await readFile(deployment.state),writes=provider.state.writes.length;
  for (const status of [404,503,522,null]) {
    let calls=0;provider.state.healthOverride=()=>{calls++;if(status===null)throw new TypeError('fixture-only transport');return new Response('not ready',{status});};
    await assert.rejects(main(['health',...argv],env,options),/health-(http|transport)-failed-last-status-/);
    assert.equal(calls,1);assert.equal(provider.state.writes.length,writes);assert.deepEqual(await readFile(deployment.state),state);
  }
});
