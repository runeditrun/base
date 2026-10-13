import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cloudflare, ownerTarget, ownerPlan, ownerDeploy } from '../index.mjs';
import { hash } from '../validation.mjs';
import { ownerProvider } from './owner-provider.mjs';

async function setup(t) {
  const provider = ownerProvider(); t.after(() => provider.close());
  const dir = await realpath(await mkdtemp(join(tmpdir(),'owner-first-health-')));
  t.after(() => rm(dir,{recursive:true,force:true}));
  const api = cloudflare(provider), target = await ownerTarget(api,{project:'runeditrun/healthprobe',environment:'staging'});
  const code = 'export default {}';
  const artifact = {version:1,source:{sha:hash(code).slice(0,40),tree:'6'.repeat(40)},run:{id:'0',attempt:'1'},main:'index.js',
    modules:[{path:'index.js',base64:Buffer.from(code).toString('base64'),sha256:hash(code)}],assets:[],migrations:[]};
  const plan = ownerPlan(target,{version:1,compatibilityDate:'2026-09-08'},artifact), statePath = join(dir,'state.json');
  let time = 0;
  return {provider,statePath,args:{api,target,plan,artifact,statePath,fetch:provider.fetch,
    readiness:{clock:() => time,sleep:async ms => {time += ms;}}},saved:async () => JSON.parse(await readFile(statePath,'utf8'))};
}

test('owner deploy persists each readiness attempt while preserving the reviewed state lock and upload identity',async t => {
  const {provider,statePath,args,saved} = await setup(t); let calls = 0;
  provider.state.healthOverride = async () => {
    calls++;
    await access(`${statePath}.lock`);
    if (calls > 1) assert.equal((await saved()).receipt.health.attempts.length,calls-1);
    if (calls <= 2) return new Response('not ready',{status:404});
    const vars = Object.fromEntries(provider.state.settings.bindings.filter(x => x.type === 'plain_text').map(x => [x.name,x.text]));
    return Response.json({ok:true,deployment:{sourceSha:vars.RER_DEPLOY_SOURCE,fingerprint:vars.RER_DEPLOY_FINGERPRINT,versionId:provider.state.version.id}});
  };
  const {receipt} = await ownerDeploy(args), state = await saved();
  assert.deepEqual(receipt.health.attempts.map(x => x.status),[404,404,200]);
  assert(receipt.health.attempts.every((x,i) => i===0 || x.offsetMs>receipt.health.attempts[i-1].offsetMs));
  assert.deepEqual(state.receipt,receipt); assert.equal(state.pendingUpload,undefined);
  await assert.rejects(access(`${statePath}.lock`),{code:'ENOENT'});
});

test('owner deploy retains a bounded health failure and releases its state lock',async t => {
  const {provider,statePath,args,saved} = await setup(t);
  provider.state.healthOverride = () => new Response('warming',{status:503}); let failure;
  await assert.rejects(ownerDeploy({...args,readiness:{...args.readiness,totalMs:5000}}),error => {
    failure = error; return /last-status-503/.test(error.message);
  });
  const state = await saved();
  assert.deepEqual(state.receipt.health,failure.receipt.health);
  assert.equal(state.receipt.health.ok,false); assert.equal(state.receipt.health.attempts.length,3);
  assert.equal(state.pendingUpload,undefined);
  await assert.rejects(access(`${statePath}.lock`),{code:'ENOENT'});
});
