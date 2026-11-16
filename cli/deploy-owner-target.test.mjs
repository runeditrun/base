import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, access } from 'node:fs/promises';
import { namedOwnerDeploy } from './fixtures/named-owner-deploy.mjs';

test('public deploy claims, signs in, redeploys and removes the native uploader recorded Worker', async t => {
 for (const prefix of ['synthetic-lamp-copy',undefined]) await t.test(prefix??'unprefixed',async t => {
  const f=await namedOwnerDeploy(t,prefix);
  const deployed=await f.run();
  assert.equal(deployed.code,0,deployed.text);
  assert.equal(deployed.result.owner,'claimed');
  const state=JSON.parse(await readFile(f.statePath,'utf8'));
  assert.equal(state.worker,f.worker);
  assert.equal(state.ownerClaim.outcome,'claimed');
  const db=f.provider.state.databases[0].db;
  assert.equal(db.prepare("SELECT email FROM oa_operators WHERE role='owner'").get().email,'owner@example.test');
  assert.ok(!f.provider.state.secrets.some(item=>item.name==='SETUP_TOKEN'));
  const signin=await f.run('signin');
  assert.equal(signin.code,0,signin.text);
  assert.equal(signin.result.owner,'owner@example.test');
  assert.equal(new URL(signin.result.link).hostname,`${f.worker}.fixture-account.workers.dev`);
  const used=await fetch(new URL('/auth/owner-signin',signin.result.link),{method:'POST',headers:{Origin:new URL(signin.result.link).origin,'Content-Type':'application/json'},body:JSON.stringify({token:new URL(signin.result.link).searchParams.get('token')})});
  assert.equal(used.status,303,await used.text());
  const repeated=await f.run();
  assert.equal(repeated.code,0,repeated.text);
  assert.equal(repeated.result.owner,'kept');
  const removed=await f.run('deploy','--remove','--yes');
  assert.equal(removed.code,0,removed.text);
  assert.ok(f.requests.some(item=>item.method==='DELETE'&&item.worker===f.worker));
  assert.ok(!f.requests.some(item=>item.worker&&item.worker!==f.worker),'never targets a derived sibling Worker');
  assert.equal(f.provider.state.settings,null);
  assert.equal(f.provider.state.databases.length,0);
  await assert.rejects(access(f.statePath),{code:'ENOENT'});
 });
});

test('public deploy and remove retain foreign ownership refusals and name recorded and requested Workers',async t => {
 const f=await namedOwnerDeploy(t,'synthetic-lamp-copy');
 const first=await f.run();
 assert.equal(first.code,0,first.text);
 const record=await readFile(f.statePath,'utf8');
 const foreign={...JSON.parse(record),project:'tests/foreign',worker:'foreign-production'};
 await writeFile(f.statePath,JSON.stringify(foreign));
 const writes=f.provider.state.writes.length;
 for (const flags of [[],['--remove','--yes']]) {
  const result=await f.run('deploy',...flags);
  assert.notEqual(result.code,0);
  assert.match(result.text,/owner-state-target-mismatch/);
  assert.ok(result.text.includes('foreign-production'),result.text);
  assert.ok(result.text.includes('fixture-production'),result.text);
  assert.match(result.text,/checkout|environment/);
  assert.equal(f.provider.state.writes.length,writes);
 }
 await writeFile(f.statePath,record);
 process.env.LAMP_RESOURCE_PREFIX='synthetic-lamp-moved';
 const moved=await f.run();
 assert.notEqual(moved.code,0);
 assert.match(moved.text,/owner-state-target-mismatch/);
 for (const worker of [f.worker,'synthetic-lamp-moved-production']) assert.ok(moved.text.includes(worker),moved.text);
 assert.equal(f.provider.state.writes.length,writes);
 process.env.LAMP_RESOURCE_PREFIX='synthetic-lamp-copy';
 f.provider.foreign.replaceWorker();
 for (const flags of [[],['--remove','--yes']]) {
  const result=await f.run('deploy',...flags);
  assert.notEqual(result.code,0);
  assert.match(result.text,/owned-resource-replaced/);
  assert.equal(f.provider.state.writes.length,writes);
 }
});
