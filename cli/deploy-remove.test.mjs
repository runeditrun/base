import test from 'node:test';
import https from 'node:https';
import assert from 'node:assert/strict';
import { writeFile, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { deployProviderFixture as removalFixture } from './fixtures/deploy-provider.mjs';

// Public CLI dispatcher, flag parser and deploy kit; only Cloudflare's network edge is fake.
test('rer deploy --remove --yes empties its created bucket and refuses unproved ownership', async t => {
 const {root, provider, run} = await removalFixture(t, {queues:[{binding:'JOBS'}]});
 const objectDeletes = t.mock.method(https, 'request', () => { throw new Error('unexpected-object-delete'); });
 assert.equal(await run(), 0);
 const path = join(root, '.rer/deploy/production.json'), name = 'fixture-production-files';
 const original = JSON.parse(await readFile(path, 'utf8'));
 assert.equal(original.owned.r2[name].status, 'created');
 assert.equal(original.owned.r2[name].id, provider.state.buckets[0].creation_date);
 const keys = ['folder/a b?#%é.txt', 'folder/double//slash', "quotes/'(!)*.txt", 'dot/../literal', './leading', '../relative', 'trailing/.', '.', '..', '/leading slash', 'literal%2F', ...Array.from({length:1003}, (_, i) => `file-${String(i).padStart(3,'0')}`)];
 provider.state.objects.set(name, new Map(keys.map(key => [key, Buffer.from(`data:${key}`)])));
 provider.foreign.r2('unrelated-bucket');
 provider.state.objects.set('unrelated-bucket', new Map([['keep', Buffer.from('untouched')]]));
 assert.equal(await run('--remove', '--yes'), 0);
 assert.deepEqual(provider.state.buckets.map(row => row.name), ['unrelated-bucket']);
 assert.equal(provider.state.queues.length,0);
 assert.equal(provider.state.objects.get(name)?.size ?? 0, 0);
 assert.equal(provider.state.objects.get('unrelated-bucket').get('keep').toString(), 'untouched');
 await assert.rejects(access(path), {code:'ENOENT'});
 assert.equal(objectDeletes.mock.callCount(),0, 'no per-object network calls for a bucket spanning multiple list pages');
 const jobs = provider.state.r2Jobs.get(name);
 assert.equal(jobs.size,1);
 assert.equal([...jobs.values()][0].prefixDelete.deletedObjects,keys.length);
 assert.equal(await run(), 0);
 Object.assign(original, JSON.parse(await readFile(path, 'utf8')));
 provider.state.objects.set(name, new Map(keys.map(key => [key, Buffer.from(`data:${key}`)])));
 // These are altered copies of genuine saved creation state, never fabricated ownership.
 for (const mode of ['pending', 'pending-empty', 'unknown', 'unknown-empty', 'unowned', 'replaced']) {
  const state = structuredClone(original);
  if (mode.startsWith('pending')) state.owned.r2[name] = {status:'pending'};
  if (mode.startsWith('unknown')) delete state.owned.r2[name].id;
  if (mode === 'unowned') { state.owned = {worker:null, d1:{}, r2:{}, kv:{}, queues:{}}; state.receipt = null; }
  if (mode === 'replaced') state.owned.r2[name].id = '2000-01-01T00:00:00.000Z';
  const kept = mode.endsWith('-empty') ? [] : keys;
  provider.state.objects.set(name, new Map(kept.map(key => [key, Buffer.from(`data:${key}`)])));
  await writeFile(path, JSON.stringify(state));
  const writes = provider.state.writes.length;
  assert.equal(await run('--remove', '--yes'), 1, `${mode} removal must fail`);
  assert.equal(provider.state.writes.length, writes, `${mode} refuses before destructive effects`);
  assert.deepEqual([...provider.state.objects.get(name).keys()], kept);
 }
 await writeFile(path, JSON.stringify(original));

});

test('rer deploy --remove resumes an R2 job whose creation response was lost', async t => {
 const {root, provider, run} = await removalFixture(t, {queues:[{binding:'JOBS'}]});
 const objectDeletes = t.mock.method(https, 'request', () => { throw new Error('unexpected-object-delete'); });
 assert.equal(await run(),0);
 const name = 'fixture-production-files', path = join(root,'.rer/deploy/production.json');
 const saved = JSON.parse(await readFile(path,'utf8'));
 const objects = new Map(Array.from({length:645}, (_, i) => [`files/${i}`, Buffer.from('stored data')]));
 provider.state.objects.set(name,objects);
 provider.fail('POST', /\/r2\/buckets\/[^/]+\/jobs$/, {afterApply:true});

 assert.equal(await run('--remove','--yes'),1);
 const jobs = provider.state.r2Jobs.get(name);
 assert.equal(jobs.size,1, 'the lost POST response did not replay the write');
 assert.equal(objects.size,645);
 assert.equal(provider.state.buckets.some(row => row.name === name),true);
 assert.equal(provider.state.queues.length,0);
 const retained = JSON.parse(await readFile(path,'utf8'));
 assert.deepEqual(retained.owned.r2,saved.owned.r2);
 assert.equal(retained.owned.worker,null);

 assert.equal(await run('--remove','--yes'),0);
 assert.equal(jobs.size,1, 'the second removal waited for the active job');
 assert.equal(objects.size,0);
 assert.equal(objectDeletes.mock.callCount(),0);
 assert.equal(provider.state.buckets.length,0);
 await assert.rejects(access(path),{code:'ENOENT'});
});

test('rer deploy --remove refuses ambiguous full pages and malformed R2 pagination, accepting terminal empty pages', async t => {
 for (const metadata of ['absent', 'null', 'malformed']) await t.test(metadata, async t => {
  const {root, provider, run} = await removalFixture(t);
  assert.equal(await run(), 0);
  const path = join(root, '.rer/deploy/production.json'), name = 'fixture-production-files';
  const original = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(original.owned.r2[name].status, 'created');
  assert.equal(original.owned.r2[name].id, provider.state.buckets[0].creation_date);
  provider.foreign.r2('unrelated-bucket');
  provider.state.objects.set('unrelated-bucket', new Map([['keep', Buffer.from('untouched')]]));
  provider.foreign.kv('unrelated-cache');
  provider.foreign.queues('unrelated-jobs');
  const unrelatedSnapshot = () => structuredClone({bucket:provider.state.buckets.find(row => row.name === 'unrelated-bucket'), objects:[...provider.state.objects.get('unrelated-bucket')].map(([key, value]) => [key, value.toString()]), kv:provider.state.kv, queues:provider.state.queues});
  const unrelated = unrelatedSnapshot();
  const assertUnrelated = () => assert.deepEqual(unrelatedSnapshot(), unrelated);
  const objectDeletes = t.mock.method(https, 'request', () => { throw new Error('unexpected-object-delete'); });
  let info = metadata === 'null' ? null : undefined;
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
   const response = await provider.fetch(input, init);
   if ((init.method ?? 'GET') !== 'GET' || !new URL(input).pathname.endsWith(`/r2/buckets/${name}/objects`)) return response;
   const body = await response.json();
   if (info === undefined) delete body.result_info;
   else body.result_info = info;
   return Response.json(body);
  });
  const objects = new Map();
  provider.state.objects.set(name, objects);
  const refuse = async () => {
   const writes = provider.state.writes.length;
   assert.equal(await run('--remove', '--yes'), 1);
   assert.equal(objectDeletes.mock.callCount(), 0, 'refuses before requesting an object delete');
   assert.equal(provider.state.writes.slice(writes).some(call => call.path.startsWith('/r2/')), false, 'no bucket or object delete without pagination evidence');
   assert.equal(provider.state.buckets.find(row => row.name === name).creation_date, original.owned.r2[name].id);
   assert.deepEqual((JSON.parse(await readFile(path, 'utf8'))).owned.r2, original.owned.r2, 'remaining bucket retains its real ownership proof');
   assertUnrelated();
  };
  if (metadata === 'malformed') {
   // An empty result must not hide explicit invalid or contradictory metadata.
   for (info of [false, {is_truncated:'false'}, {is_truncated:true,cursor:'next'}, {is_truncated:false,delimited:['prefix/']}]) await refuse();
  } else {
   for (let index = 0; index < 1000; index++) objects.set(`keep-owned-${index}`, Buffer.from('owned data'));
   const retained = [...objects];
   await refuse();
   assert.deepEqual([...objects], retained, 'a full ambiguous page preserves its objects');
   objects.clear();
   const writes = provider.state.writes.length, calls = provider.state.calls.length;
   assert.equal(await run('--remove', '--yes'), 0, `${metadata} metadata completes empty removal`);
   assert.deepEqual(provider.state.writes.slice(writes).map(({method, path}) => ({method, path})), [{method:'DELETE',path:`/r2/buckets/${name}`}]);
   assert.equal(provider.state.calls.slice(calls).some(call => call.path.includes('/jobs')), false, 'empty removal needs no bucket job');
   assert.equal(objectDeletes.mock.callCount(), 0);
   assert.equal(provider.state.buckets.some(row => row.name === name), false);
   assert.equal(objects.size, 0);
   await assert.rejects(access(path), {code:'ENOENT'});
   assertUnrelated();
  }
 });
});


test('standard removal retries safe gateway failures and reports only unconfirmed resources through the CLI', async t => {
 for (const scenario of ['read-once','delete-applied','worker-delete-applied','worker-cleanup-forbidden','kv-delete-applied-forbidden','kv-delete-forbidden','preflight-gateway','preflight-forbidden','worker-delete','partial-delete','readback']) await t.test(scenario, async t => {
  const {root,provider,run} = await removalFixture(t,{d1:[{binding:'DB'}],kv:[{binding:'CACHE'}],queues:[{binding:'JOBS'}]});
  assert.equal(await run(),0);
  const path = join(root,'.rer/deploy/production.json');
  const original = JSON.parse(await readFile(path,'utf8'));
  const all = ['worker:fixture-production','d1:fixture-production-db','r2:fixture-production-files','kv:fixture-production-cache','queues:fixture-production-jobs'];
  let hits = 0, deleted = false;
  t.mock.method(globalThis,'fetch',async (input,init = {}) => {
   const url = new URL(input), method = init.method ?? 'GET';
   const workerSettings = method === 'GET' && url.pathname.endsWith('/workers/scripts/fixture-production/settings');
   const workerDelete = method === 'DELETE' && url.pathname.endsWith('/workers/scripts/fixture-production');
   const bucketDelete = method === 'DELETE' && url.pathname.endsWith('/r2/buckets/fixture-production-files');
   const kvDelete = method === 'DELETE' && url.pathname.includes('/storage/kv/namespaces/');
   const databaseList = method === 'GET' && url.pathname.endsWith('/d1/database');
   const selected = scenario === 'read-once' || scenario.startsWith('preflight-') ? workerSettings
    : scenario.startsWith('worker-') ? workerDelete
    : scenario.startsWith('kv-delete') ? kvDelete
    : scenario === 'partial-delete' || scenario === 'delete-applied' ? bucketDelete
    : scenario === 'readback' && deleted && databaseList;
   if (selected) {
    hits++;
    if ((scenario.includes('applied') || scenario === 'worker-cleanup-forbidden') && hits === 1) { await provider.fetch(input,init); deleted = true; }
    if (!['read-once','delete-applied'].includes(scenario) || hits === 1) return new Response(scenario === 'worker-cleanup-forbidden' ? 'KV cleanup not authorized' : 'provider unavailable',{status:scenario.includes('forbidden') ? 403 : 502});
   }
   const response = await provider.fetch(input,init);
   if (method === 'DELETE') deleted = true;
   return response;
  });
  const output = [];
  const capture = t.mock.method(process.stdout,'write',chunk => { output.push(String(chunk)); return true; });
  const result = await run('--remove','--yes');
  capture.mock.restore();
  if (['read-once','delete-applied','worker-delete-applied','worker-cleanup-forbidden','kv-delete-applied-forbidden'].includes(scenario)) {
   assert.equal(result,0);
   if (scenario === 'read-once') assert.ok(hits > 1, 'the read was retried');
   else assert.equal(hits, 1, 'a missing or already-applied target receives no second write');
   const message = output.flatMap(text => text.trim().split('\n')).map(text => JSON.parse(text)).filter(event => event.event === 'progress').map(event => event.message).join('\n');
   // The result must count a delete proved by readback even if its response failed.
   const resultEvent = output.flatMap(text => text.trim().split('\n')).map(text => JSON.parse(text)).find(event => event.event === 'result');
   assert.deepEqual([...resultEvent.removed].sort(), [...all].sort(), message);
   await assert.rejects(access(path),{code:'ENOENT'});
   assert.equal(provider.state.settings,null);
   assert.deepEqual([provider.state.databases.length,provider.state.buckets.length,provider.state.kv.length,provider.state.queues.length],[0,0,0,0]);
  } else {
   assert.equal(result,1);
   assert.equal(hits,scenario.includes('forbidden') ? 1 : 3);
   const message = output.flatMap(text => text.trim().split('\n')).map(text => JSON.parse(text)).find(event => event.event === 'error').message;
   const remaining = scenario === 'partial-delete' ? [all[2]] : scenario === 'readback' ? [all[1]] : scenario === 'kv-delete-forbidden' ? [all[3]] : all;
   assert.match(message,new RegExp(`${remaining.length} resources remain`));
   for (const name of remaining) assert.ok(message.includes(name),message);
   assert.match(message,/run ~\/\.local\/bin\/rer deploy .*--remove --yes again/);
   assert.doesNotMatch(message,/Deploy failed|Resources created this attempt/);
   assert.doesNotMatch(message,/remove-incomplete/);
   assert.match(message,/Removed /);
   const saved = JSON.parse(await readFile(path,'utf8'));
   for (const kind of ['d1','r2','kv','queues']) {
    const expected = Object.fromEntries(Object.entries(original.owned[kind]).filter(([name]) => remaining.includes(`${kind}:${name}`)));
    assert.deepEqual(saved.owned[kind],expected,'retain exactly the unconfirmed ownership proofs');
   }
   assert.equal(Boolean(saved.owned.worker),remaining.includes(all[0]));
   if (scenario.startsWith('preflight-')) assert.equal(provider.state.settings !== null,true);
   // An actual later command finishes with the saved proof and no recreation.
   t.mock.method(globalThis,'fetch',provider.fetch);
   assert.equal(await run('--remove','--yes'),0);
   await assert.rejects(access(path),{code:'ENOENT'});
  }
 });
});

test('rer deploy --remove refuses a Worker replaced while preparing its delete', async t => {
 for (const hasCron of [false, true]) await t.test(hasCron ? 'after clearing Cron' : 'without Cron', async t => {
  const queue = hasCron ? {binding:'JOBS'} : {binding:'JOBS',consumer:{batch_size:10}};
  const {root, provider, run} = await removalFixture(t, {d1:[{binding:'DB'}], queues:[queue]});
  assert.equal(await run(), 0);
  const path = join(root, '.rer/deploy/production.json');
  const record = await readFile(path), writes = provider.state.writes.length;
  if (hasCron) provider.state.schedules = [{cron:'*/5 * * * *'}];
  let replacement;
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
   const response = await provider.fetch(input, init);
   if (!replacement && init.method === 'GET' && new URL(input).pathname.endsWith('/fixture-production/schedules') && !provider.state.schedules.length) {
    provider.foreign.replaceWorker();
    replacement = provider.state.version.id;
   }
   return response;
  });
  assert.equal(await run('--remove', '--yes'), 1);
  assert.ok(replacement);
  assert.equal(provider.state.version?.id, replacement);
  assert.equal(provider.state.writes.slice(writes).filter(write => write.method === 'DELETE').length, 0);
  if (!hasCron) assert.equal(provider.state.writes.length, writes);
  assert.deepEqual(await readFile(path), record);
  assert.equal(provider.state.queues[0].consumers.length, hasCron ? 0 : 1);
 });
});

test('rer deploy --remove deletes an unchanged Worker and re-proves a named target before any retry', async t => {
 for (const kind of ['unchanged', 'worker', 'bucket']) await t.test(kind, async t => {
  const {root, provider, run} = await removalFixture(t);
  assert.equal(await run(), 0);
  const path = join(root, '.rer/deploy/production.json');
  const target = kind === 'worker' ? '/workers/scripts/fixture-production' : '/r2/buckets/fixture-production-files';
  let attempts = 0, replacement;
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
   if (kind !== 'unchanged' && init.method === 'DELETE' && new URL(input).pathname.endsWith(target) && ++attempts === 1) {
    if (kind === 'worker') {
     provider.foreign.replaceWorker();
     replacement = provider.state.version;
    } else {
     provider.state.buckets.length = 0;
     provider.foreign.r2('fixture-production-files');
     replacement = provider.state.buckets[0];
    }
    return new Response('provider unavailable', {status:502});
   }
   return provider.fetch(input, init);
  });
  assert.equal(await run('--remove', '--yes'), kind === 'unchanged' ? 0 : 1);
  if (kind === 'unchanged') {
   assert.equal(provider.state.settings, null);
   assert.equal(provider.state.buckets.length, 0);
   await assert.rejects(access(path), {code:'ENOENT'});
  } else {
   assert.equal(attempts, 1);
   assert.ok(replacement);
   assert.deepEqual(kind === 'worker' ? provider.state.version : provider.state.buckets[0], replacement);
   await access(path);
  }
 });
});
