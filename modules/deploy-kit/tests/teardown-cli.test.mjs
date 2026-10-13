import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { main } from '../cli.mjs';
import { hash } from '../validation.mjs';
test('verify-teardown CLI lists a default disposable stage without writes',async t=>{
  const directory=await realpath(await mkdtemp(join(tmpdir(),'teardown-cli-')));t.after(()=>rm(directory,{recursive:true,force:true}));
  const code='export default {}';
  const artifact={version:1,source:{sha:'1'.repeat(40),tree:'2'.repeat(40)},run:{id:'17',attempt:'1'},main:'index.js',modules:[{path:'index.js',base64:Buffer.from(code).toString('base64'),sha256:hash(code)}],assets:[],migrations:[]};
  const bytes=JSON.stringify(artifact),accountId='a'.repeat(32);
  const receipt={version:1,worker:'rer-base-stage-17',accountId,source:artifact.source,run:artifact.run,artifactSha256:hash(bytes),resources:{d1:[],r2:[],queues:[]},durableObjects:[]};
  await writeFile(join(directory,'artifact.json'),bytes,{mode:0o600});await writeFile(join(directory,'receipt.json'),JSON.stringify(receipt),{mode:0o600});
  const fetch=globalThis.fetch,log=console.log;const calls=[],output=[];
  t.after(()=>{globalThis.fetch=fetch;console.log=log;});
  globalThis.fetch=async(input,init)=>{
    assert.equal(init.method,'GET');const url=new URL(input);assert(url.pathname.startsWith(`/client/v4/accounts/${accountId}/`));calls.push(url.pathname);
    return Response.json({success:true,errors:[],result:url.pathname.endsWith('/r2/buckets')?{buckets:[]}:[],...(url.pathname.endsWith('/workers/scripts')?{}:{result_info:url.pathname.endsWith('/r2/buckets')?null:{page:1,total_count:0,total_pages:1}})});
  };
  console.log=x=>output.push(JSON.parse(x));
  const result=await main(['verify-teardown'],{RER_DEPLOY_ARTIFACT:join(directory,'artifact.json'),RER_DEPLOY_RECEIPT:join(directory,'receipt.json'),RER_DEPLOY_ARTIFACT_SHA256:hash(bytes),RER_DEPLOY_SOURCE_SHA:artifact.source.sha,RER_DEPLOY_RUN_ID:'17',RER_DEPLOY_RUN_ATTEMPT:'1',CF_THROWAWAY_ACCOUNT_ID:accountId,CF_THROWAWAY_API_TOKEN:'fixture-only'});
  assert.equal(result.ok,true);assert.equal(calls.length,5);assert.equal(output.length,1);assert.deepEqual(result.listing,{workers:[],d1:[],r2:[],queues:[],consumers:[],durableObjects:[]});
});
