import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cloudflare } from '../provider.mjs';
import { readOwnerState, writeOwnerState } from '../owner.mjs';
import { nativeUpload, nativeWorkerCheck } from '../native-upload.mjs';
import { ownerRemove } from '../owner-remove.mjs';
import { ownerProvider } from './owner-provider.mjs';

// A native adapter (Lamp's Wrangler run) on a faked Cloudflare edge: it records D1, R2 and a
// queue in rer's ownership record, then uploads the Worker itself. Cloudflare answers the queue
// step after the upload with 10500, as it did for a stranger's first Lamp 1.11.35 deploy.
const commands = {deploy:'pnpm run deploy:cloudflare -- --environment production', remove:'pnpm run remove:cloudflare -- --environment production --yes'};
const fingerprint = 'f'.repeat(64), next = 'e'.repeat(64);

async function setup(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(),'deploy-kit-native-upload-')));
  t.after(() => rm(dir,{recursive:true,force:true}));
  const provider = ownerProvider({creationDates:true});
  t.after(() => provider.close());
  const api = cloudflare(provider);
  const target = {accountId:api.accountId,project:'tests/lamp',environment:'production',worker:'lamp-production',origin:'https://status.example.test'};
  const statePath = join(dir,'production.json');
  const state = await readOwnerState(statePath,target);
  const d1 = await api.request('/d1/database',{method:'POST',body:{name:'lamp-production-db'}});
  const r2 = await api.request('/r2/buckets',{method:'POST',body:{name:'lamp-production-files'}});
  const queue = await api.request('/queues',{method:'POST',body:{queue_name:'lamp-production-jobs'}});
  state.owned.d1['lamp-production-db'] = {status:'created',id:d1.uuid};
  state.owned.r2['lamp-production-files'] = {status:'created',id:r2.creation_date};
  state.owned.queues['lamp-production-jobs'] = {status:'created',id:queue.queue_id};
  await writeOwnerState(statePath,state);
  provider.state.objects.set('lamp-production-files',new Map(Array.from({length:1500},(_,i) => [`objects/${String(i).padStart(4,'0')}`,Buffer.from('x')])));
  // What `wrangler deploy --var RER_DEPLOY_FINGERPRINT:<fp> --message rer-deploy:<fp>` sends.
  const wrangler = (build, {message = true, queueFails = false} = {}) => async () => {
    const data = new FormData();
    data.set('metadata',new Blob([JSON.stringify({main_module:'index.js',compatibility_date:'2026-09-08',
      bindings:[{type:'plain_text',name:'RER_DEPLOY_FINGERPRINT',text:build}],...(message ? {annotations:{'workers/message':`rer-deploy:${build}`}} : {})})],{type:'application/json'}));
    data.set('index.js',new Blob([`export default {fetch(){return new Response(${JSON.stringify(build)})}}`],{type:'application/javascript+module'}),'index.js');
    await api.request('/workers/scripts/lamp-production',{method:'PUT',body:data});
    if (queueFails) throw new Error('A request to the Cloudflare API (/queues) failed. Internal authentication error [code: 10500]');
  };
  const run = (build, options) => nativeUpload({api,target,statePath,fingerprint:build,receipt:{origin:target.origin,source:{sha:'1'.repeat(40)}},upload:wrangler(build,options),commands});
  const saved = async () => JSON.parse(await readFile(statePath,'utf8'));
  return {...provider,api,target,statePath,run,saved,remove:() => ownerRemove({api,target,statePath,expectedResources:{d1:['lamp-production-db'],r2:['lamp-production-files'],queues:['lamp-production-jobs']}})};
}

test('a native upload that fails after the Worker upload is adopted by the retry and removed with its data', async t => {
  await t.test('failure after upload, retry adopts and completes, remove cleans', async t => {
    const f = await setup(t);
    await assert.rejects(f.run(fingerprint,{queueFails:true}),error => {
      assert.equal(error.code,'native-upload-incomplete');
      assert.equal(error.uploadRecorded,true);
      assert.match(error.message,/10500[\s\S]*recorded as this deployment's own[\s\S]*pnpm run deploy:cloudflare/);
      return true;
    });
    const failed = await f.saved();
    assert.deepEqual(failed.owned.worker,{status:'created'});
    assert.equal(failed.pendingUpload.provider.versionId,f.state.version.id);
    assert.equal(failed.receipt,null);
    // The retry (possibly of a changed checkout) verifies the recorded upload, then uploads again.
    const receipt = await f.run(next);
    assert.equal(receipt.fingerprint,next);
    assert.equal(receipt.provider.versionId,f.state.version.id);
    assert.equal((await f.saved()).pendingUpload,undefined);
    const removed = await f.remove();
    assert.deepEqual(removed.removed.sort(),['d1:lamp-production-db','queues:lamp-production-jobs','r2:lamp-production-files','worker:lamp-production']);
    assert.equal(f.state.settings,null);
    assert.deepEqual([f.state.databases.length,f.state.buckets.length,f.state.queues.length],[0,0,0]);
    // One provider bulk purge job, not 1,500 object deletions.
    assert.equal(f.state.writes.filter(w => w.method === 'POST' && w.path.endsWith('/jobs')).length,1);
    assert.equal(f.state.writes.filter(w => w.method === 'DELETE' && w.path.includes('/objects/')).length,0);
    await assert.rejects(access(f.statePath),{code:'ENOENT'});
    // Running the removal again finds nothing recorded and nothing left under the expected names.
    await assert.rejects(f.remove(),{message:'nothing-to-remove'});
    f.foreign.queues('lamp-production-jobs');
    await assert.rejects(f.remove(),{message:'unrecorded-resource',resource:'queues:lamp-production-jobs'});
  });

  await t.test('a record left pending by a killed uploader is proven by the retry check and by remove', async t => {
    const f = await setup(t);
    await f.run(fingerprint,{queueFails:true}).catch(() => {});
    // The Lamp 1.11.35 record: pending Worker, fingerprint saved, provider identity never read back.
    const state = await f.saved();
    delete state.pendingUpload.provider; state.owned.worker = {status:'pending'};
    await writeOwnerState(f.statePath,state);
    const live = await nativeWorkerCheck({api:f.api,target:f.target,statePath:f.statePath,commands});
    assert.equal(live.versionId,f.state.version.id);
    assert.equal((await f.saved()).pendingUpload.provider.versionId,f.state.version.id);
    delete state.pendingUpload.provider;
    await writeOwnerState(f.statePath,state);
    await f.remove();
    assert.equal(f.state.settings,null);
    assert.deepEqual([f.state.databases.length,f.state.buckets.length,f.state.queues.length],[0,0,0]);
  });
});

test('an unproven or replaced Worker is still refused by the retry and by remove, with the next step named', async t => {
  for (const scenario of ['replaced','unmarked']) await t.test(scenario, async t => {
    const f = await setup(t);
    await f.run(fingerprint,{queueFails:true,message:scenario !== 'unmarked'}).catch(error => assert.equal(error.uploadRecorded,scenario !== 'unmarked'));
    if (scenario === 'replaced') f.foreign.replaceWorker();
    const settings = structuredClone(f.state.settings), before = await readFile(f.statePath);
    await assert.rejects(f.run(fingerprint),error => {
      assert.equal(error.code,scenario === 'replaced' ? 'owned-resource-replaced' : 'uncertain-resource-create');
      assert.match(error.message,scenario === 'replaced' ? /deployed by someone else/ : /lacks the message rer-deploy:f{64}[\s\S]*delete that one Worker[\s\S]*pnpm run deploy:cloudflare/);
      return true;
    });
    await assert.rejects(f.remove(),{message:scenario === 'replaced' ? 'owned-resource-replaced' : 'uncertain-resource-create'});
    assert.deepEqual(f.state.settings,settings);
    assert.deepEqual([f.state.databases.length,f.state.buckets.length,f.state.queues.length],[1,1,1]);
    assert.deepEqual(await readFile(f.statePath),before);
  });
});
