import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { expiryDeploy, deploymentSummary } from './fixtures/deploy-expiry.mjs';

// One public journey, with checkpoints through the same deploy lifecycle.
test('rer deploy resumes expired grant runs to the uninterrupted resource, owner and version state',{timeout:180000},async t=>{
 const uninterrupted=await expiryDeploy(t), first=await uninterrupted.run();
 assert.equal(first.code,0,first.stdout+first.stderr);
 const expected=deploymentSummary(uninterrupted.provider);
 for (const point of ['before-upload','after-d1','mid-upload','accepted-upload']) {
  const f=await expiryDeploy(t), stopped=await f.run(point);
  assert.equal(stopped.reached,true,`${point}: ${stopped.stdout}\n${stopped.stderr}`);
  assert.equal(stopped.signal,'SIGKILL',stopped.stdout+stopped.stderr);
  assert.match(stopped.stderr,/credential expired.*run it again to resume/i);
  assert.match(stopped.stderr,/exit status: 137/i);
  assert.match(stopped.stderr,/cleanup: revoked/);
  const partial=JSON.parse(await readFile(f.statePath,'utf8'));
  assert.equal(partial.owned.d1['fixture-production-db'].status,'created');
  if(point==='accepted-upload') assert.ok(partial.pendingUpload && !partial.pendingUpload.provider);
  const ids={d1:f.provider.state.databases[0].uuid,r2:f.provider.state.buckets[0]?.creation_date,kv:f.provider.state.kv[0]?.id,queue:f.provider.state.queues[0]?.queue_id};
  const version=f.provider.state.version?.id;
  const finished=await f.run();
  assert.equal(finished.code,0,`${point}: ${finished.stdout}\n${finished.stderr}`);
  assert.deepEqual(deploymentSummary(f.provider),expected,point);
  assert.equal(f.provider.state.databases[0].uuid,ids.d1);
  if(ids.r2) assert.equal(f.provider.state.buckets[0].creation_date,ids.r2);
  if(ids.kv) assert.equal(f.provider.state.kv[0].id,ids.kv);
  if(ids.queue) assert.equal(f.provider.state.queues[0].queue_id,ids.queue);
  if(version) assert.equal(f.provider.state.versions.at(-1).id,version,'accepted upload was completed without another code version');
  const saved=JSON.parse(await readFile(f.statePath,'utf8'));
  assert.equal(saved.ownerClaim.outcome,'claimed');assert.equal(saved.pendingUpload,undefined);assert.equal(saved.pendingSecret,undefined);
  await assert.rejects(access(`${f.statePath}.lock`),{code:'ENOENT'});
  const writes=f.provider.state.writes.length, bytes=await readFile(f.statePath,'utf8');
  const repeated=await f.run();assert.equal(repeated.code,0,repeated.stdout+repeated.stderr);
  assert.equal(f.provider.state.writes.length,writes,'completed repeat is read-only');
  assert.equal(await readFile(f.statePath,'utf8'),bytes);
  assert.equal(new Set(f.business.state.credentials.values()).size,3,'each invocation uses a fresh child');
  assert.equal(f.business.state.revocations,3);
  for(const credential of f.business.state.credentials.values()) assert.ok(![stopped,finished,repeated].some(result=>(result.stdout+result.stderr).includes(credential)));
  assert.equal(new Set(f.authorities).size,3,'provider saw each new child authority');
 }
});
