import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { main } from '../cli.mjs';
import { cloudflare, deploy, defaultStagePlan } from '../index.mjs';
import { hash } from '../validation.mjs';
import { providerFixture } from './provider-fixture.mjs';

test('standalone health CLI makes exactly one request on transient failures',async t=>{
  const fixture=providerFixture();t.after(()=>fixture.close());
  const directory=await realpath(await mkdtemp(join(tmpdir(),'health-cli-')));t.after(()=>rm(directory,{recursive:true,force:true}));
  const code='export default {scheduled() {}}';
  const artifact={version:1,source:{sha:'1'.repeat(40),tree:'2'.repeat(40)},run:{id:'17',attempt:'1'},main:'index.js',modules:[{path:'index.js',base64:Buffer.from(code).toString('base64'),sha256:hash(code)}],assets:[],migrations:[]};
  const bytes=JSON.stringify(artifact),artifactSha256=hash(bytes);
  const receipt=await deploy({api:cloudflare(fixture),plan:defaultStagePlan(artifact),artifact,artifactSha256,fetch:fixture.fetch});
  await writeFile(join(directory,'artifact.json'),bytes,{mode:0o600});await writeFile(join(directory,'receipt.json'),JSON.stringify(receipt),{mode:0o600});
  const fetch=globalThis.fetch;t.after(()=>{globalThis.fetch=fetch;});globalThis.fetch=fixture.fetch;
  const env={RER_DEPLOY_ARTIFACT:join(directory,'artifact.json'),RER_DEPLOY_RECEIPT:join(directory,'receipt.json'),RER_DEPLOY_ARTIFACT_SHA256:artifactSha256,RER_DEPLOY_SOURCE_SHA:artifact.source.sha,RER_DEPLOY_RUN_ID:'17',RER_DEPLOY_RUN_ATTEMPT:'1',CF_THROWAWAY_ACCOUNT_ID:fixture.accountId,CF_THROWAWAY_API_TOKEN:fixture.token};
  for (const status of [404,503,522,null]) {
    let calls=0;fixture.state.healthOverride=()=>{calls++;if(status===null)throw new TypeError('fixture-only transport');return new Response('not ready',{status});};
    await assert.rejects(main(['health'],env),/health-(http|transport)-failed-last-status-/);
    assert.equal(calls,1);
  }
});
