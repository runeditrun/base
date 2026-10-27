import { caseRow, caseRows } from './fold-case.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../owner-cli.mjs';
import { ownerProvider } from './owner-provider.mjs';

async function fixture(t) {
  const provider=ownerProvider();t.after(()=>provider.close());
  const root=await realpath(await mkdtemp(join(tmpdir(),'owner-health-cli-')));t.after(()=>rm(root,{recursive:true,force:true}));
  for (const path of ['dist/server','dist/client','migrations/core']) await mkdir(join(root,path),{recursive:true});
  await writeFile(join(root,'dist/server/wrangler.json'),JSON.stringify({main:'index.js',no_bundle:true,rules:[{type:'ESModule',globs:['**/*.js','**/*.mjs']}]}));
  await writeFile(join(root,'dist/server/index.js'),'export default {}');
  await writeFile(join(root,'dist/client/index.html'),'<h1>Health fixture</h1>');
  await writeFile(join(root,'migrations/core/0001_fixture.sql'),'CREATE TABLE fixture(id TEXT PRIMARY KEY);');
  const declaration={version:1,project:'runeditrun/healthprobe',compatibilityDate:'2026-09-08',compatibilityFlags:['nodejs_compat'],d1:[{binding:'DB'}],r2:[],secrets:[{binding:'SESSION_SECRET',environment:'SESSION_SECRET'}],vars:{}};
  await writeFile(join(root,'deploy.json'),JSON.stringify(declaration));
  await writeFile(join(root,'.gitignore'),'dist/\n.rer/\n');
  const git=(...args)=>execFileSync('git',['-c','user.email=fixture@example.test','-c','user.name=Fixture','-c','commit.gpgsign=false',...args],{cwd:root,stdio:'pipe'});
  git('init','-q');git('add','.');git('commit','-qm','fixture');
  const env={CLOUDFLARE_ACCOUNT_ID:provider.accountId,CLOUDFLARE_API_TOKEN:provider.token,SESSION_SECRET:'fixture-session'},options={fetch:provider.fetch,cwd:root};
  const argv=['--declaration','deploy.json','--environment','staging'];
  const deployment=await main(['deploy',...argv],env,options),state=await readFile(deployment.state),writes=provider.state.writes.length;
  return {provider,root,env,options,argv,deployment,state,writes};
}

test('owner health CLI makes one request and preserves its state on transient failure',async t=>{
  const {provider,env,options,argv,deployment,state,writes}=await fixture(t);
  for (const status of [404,503,522,null]) {
    let calls=0;provider.state.healthOverride=()=>{calls++;if(status===null)throw new TypeError('fixture-only transport');return new Response('not ready',{status});};
    await assert.rejects(main(['health',...argv],env,options),/health-(http|transport)-failed-last-status-/);
    assert.equal(calls,1);assert.equal(provider.state.writes.length,writes);assert.deepEqual(await readFile(deployment.state),state);
  }
});


test('secret CLI readiness retries transient and stale versions, rejects wrong full identity, and preserves applied mutations', async t => {
  await caseRows(t, [['independent checks', async t => {
 const { provider, root, env, options, argv, deployment } = await fixture(t);
 await rm(join(root, 'dist'), { recursive: true });
 await writeFile(join(root, '.gitignore'), 'dirty source');
 let elapsed = 0;
 const readiness = { totalMs: 10000, clock: () => elapsed, sleep: async ms => { elapsed += ms; } };
 const run = (args) => main(['secret', ...argv, ...args], env, { ...options, healthOptions: { readiness } });
 const healthy = async () => {
  const override = provider.state.healthOverride; provider.state.healthOverride = null;
  try { return await provider.fetch(`${deployment.origin}/health`); } finally { provider.state.healthOverride = override; }
 };
 const stale = await (await healthy()).json();
 let calls = 0;
 provider.state.healthOverride = async () => {
  calls++;
  if (calls === 1) throw new TypeError('transient');
  if (calls === 2) return new Response('edge warming', { status: 522 });
  if (calls === 3) return Response.json(stale);
  return healthy();
 };
 const result = await run(['--set', 'SESSION_SECRET']);
 assert.equal(calls, 4); assert.equal(result.versionId, provider.state.version.id);
 assert.notEqual(result.versionId, stale.deployment.versionId);
 let rowAt62 = 0;
  for (const field of ['sourceSha', 'fingerprint']) {
    await caseRow(t, 'table at line 62 row ' + rowAt62++, async () => {

  calls = 0;
  provider.state.healthOverride = async () => {
   calls++; const body = await (await healthy()).json(); body.deployment[field] = 'wrong'; return Response.json(body);
  };
  await assert.rejects(run(['--set', 'SESSION_SECRET']), /health-identity-mismatch/);
  assert.equal(calls, 1, 'wrong identity on the expected version is terminal');
     });
  }
 provider.state.healthOverride = () => new Response('still unhealthy', { status: 503 });
 await caseRow(t, 'following assertion at line 71', async () => { await assert.rejects(run(['--unset', 'SESSION_SECRET']), error => error.status === 503 && error.secretChange?.present === false); });
 const state = JSON.parse(await readFile(deployment.state, 'utf8'));
 await caseRow(t, 'following assertion at line 73', async () => { assert.equal(state.receipt.provider.versionId, provider.state.version.id); });
 await caseRow(t, 'following assertion at line 74', async () => { assert.ok(state.retiredSecrets.includes('SESSION_SECRET')); }); await caseRow(t, 'following assertion at line 74', async () => { assert.equal(state.pendingSecret, undefined); });
 await caseRow(t, 'following assertion at line 75', async () => { assert.ok(!provider.state.secrets.some(item => item.name === 'SESSION_SECRET')); });
  }]]);
});
