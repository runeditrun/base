import test from 'node:test';
import https from 'node:https';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { main } from './main.mjs';
import { ownerProvider } from '../modules/deploy-kit/tests/owner-provider.mjs';

async function removalFixture(t, { allResources = false } = {}) {
 const root = await realpath(await mkdtemp(join(tmpdir(), 'rer-remove-')));
 const provider = ownerProvider({ creationDates: true });
 const saved = { ...process.env };
 t.after(async () => { provider.close(); for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); await rm(root, { recursive: true, force: true }); });
 Object.assign(process.env, { CI: 'true', CLOUDFLARE_ACCOUNT_ID: provider.accountId, CLOUDFLARE_API_TOKEN: provider.token });
 t.mock.method(globalThis, 'fetch', provider.fetch);
 for (const path of ['dist/server', 'dist/client', 'migrations/core']) await mkdir(join(root, path), { recursive: true });
 await writeFile(join(root, 'dist/server/wrangler.json'), JSON.stringify({ main: 'index.js', no_bundle: true, rules: [{ type: 'ESModule', globs: ['**/*.js', '**/*.mjs'] }] }));
 await writeFile(join(root, 'dist/server/index.js'), 'export default {fetch(){}}');
 await writeFile(join(root, 'dist/client/index.html'), 'app');
 await writeFile(join(root, 'deploy.json'), JSON.stringify({ version: 1, project: 'tests/fixture', compatibilityDate: '2026-09-08', r2: [{ binding: 'FILES' }], ...(allResources ? {d1:[{binding:'DB'}],kv:[{binding:'CACHE'}],queues:[{binding:'JOBS'}]} : {}) }));
 await writeFile(join(root, '.node-version'), process.versions.node + '\n');
 await writeFile(join(root, 'package.json'), JSON.stringify({engines:{node:process.versions.node},packageManager:'pnpm@10.12.4'}));
 await writeFile(join(root, '.gitignore'), 'dist/\n.rer/\n.seed/\n');
 await writeFile(join(root, 'adapter.mjs'), `import {ownerDeploy} from ${JSON.stringify(new URL('./deploy.mjs', import.meta.url).href)};
 const lifecycle = {run:async()=>{},settings:{},hooks:{}};
 export const commandAdapter = {...lifecycle,deploy:ownerDeploy('deploy.json',lifecycle)};`);
 await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify({version:2,project:'tests/fixture',runtime:{requirements:[]},requiredEnvironment:[],seedContract:{version:1,profile:'first-party',adapter:'adapter.mjs'},commands:{deploy:{argv:['node','adapter.mjs'],inputs:['adapter.mjs','deploy.json'],effects:'Deploy or remove the fixture in the fake Cloudflare account.'}}}));
 const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', ...args], { cwd: root, stdio: 'pipe' });
 git('init', '-q'); git('add', '.'); git('commit', '-qm', 'fixture');
 const run = (...flags) => main(['deploy', '--cwd', root, '--json', ...flags]);
 return {root, provider, run};
}

// Public CLI dispatcher, flag parser and deploy kit; only Cloudflare's network edge is fake.
test('rer deploy --remove --yes empties its created bucket and refuses unproved ownership', async t => {
 const {root, provider, run} = await removalFixture(t);
 // The production HTTPS transport uses its real HTTP client against a local
 // provider edge. req.url proves dot segments and encoded keys survive the wire.
 const endpoint = createServer(async (request, response) => {
  const result = await provider.objectDelete(request.url, {headers:{Authorization:request.headers.authorization}});
  response.writeHead(result.status, Object.fromEntries(result.headers));
  response.end(Buffer.from(await result.arrayBuffer()));
 });
 await new Promise(resolve => endpoint.listen(0, '127.0.0.1', resolve));
 t.after(async () => { endpoint.closeAllConnections(); await new Promise(resolve => endpoint.close(resolve)); });
 const nativeRequest = https.request;
 t.mock.method(https, 'request', (options, respond) => {
  assert.equal(options.hostname, 'api.cloudflare.com');
  assert.equal(options.method, 'DELETE');
  assert.ok(options.path.startsWith(`/client/v4/accounts/${provider.accountId}/r2/buckets/fixture-production-files/objects/`));
  return nativeRequest({...options, createConnection:() => connect(endpoint.address().port, '127.0.0.1')}, respond);
 });
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
 assert.equal(provider.state.objects.get(name)?.size ?? 0, 0);
 assert.equal(provider.state.objects.get('unrelated-bucket').get('keep').toString(), 'untouched');
 await assert.rejects(access(path), {code:'ENOENT'});
 assert.ok(provider.state.calls.some(call => call.path.endsWith('/objects') && call.search.includes('cursor=')), 'followed provider object pagination');
 assert.equal(provider.state.writes.filter(call => call.method === 'DELETE' && call.path.includes('/objects/')).length, keys.length);
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
   for (info of [{}, false, {is_truncated:'false'}, {is_truncated:true,cursor:'next'}, {is_truncated:false,delimited:['prefix/']}]) await refuse();
  } else {
   for (let index = 0; index < 1000; index++) objects.set(`keep-owned-${index}`, Buffer.from('owned data'));
   const retained = [...objects];
   await refuse();
   assert.deepEqual([...objects], retained, 'a full ambiguous page preserves its objects');
   objects.clear();
   const writes = provider.state.writes.length;
   assert.equal(await run('--remove', '--yes'), 0, `${metadata} metadata completes empty removal`);
   assert.deepEqual(provider.state.writes.slice(writes).map(({method, path}) => ({method, path})), [{method:'DELETE',path:`/r2/buckets/${name}`}]);
   assert.equal(objectDeletes.mock.callCount(), 0);
   assert.equal(provider.state.buckets.some(row => row.name === name), false);
   assert.equal(objects.size, 0);
   await assert.rejects(access(path), {code:'ENOENT'});
   assertUnrelated();
  }
 });
});


test('standard removal retries safe gateway failures and reports only unconfirmed resources through the CLI', async t => {
 for (const scenario of ['read-once','delete-applied','preflight-gateway','preflight-forbidden','worker-delete','partial-delete','readback']) await t.test(scenario, async t => {
  const {root,provider,run} = await removalFixture(t,{allResources:true});
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
   const databaseList = method === 'GET' && url.pathname.endsWith('/d1/database');
   const selected = scenario === 'read-once' || scenario.startsWith('preflight-') ? workerSettings
    : scenario === 'worker-delete' ? workerDelete
    : scenario === 'partial-delete' || scenario === 'delete-applied' ? bucketDelete
    : scenario === 'readback' && deleted && databaseList;
   if (selected) {
    hits++;
    if (scenario === 'delete-applied' && hits === 1) await provider.fetch(input,init);
    if (!['read-once','delete-applied'].includes(scenario) || hits === 1) return new Response('provider unavailable',{status:scenario === 'preflight-forbidden' ? 403 : 502});
   }
   const response = await provider.fetch(input,init);
   if (method === 'DELETE') deleted = true;
   return response;
  });
  const output = [];
  const capture = t.mock.method(process.stdout,'write',chunk => { output.push(String(chunk)); return true; });
  const result = await run('--remove','--yes');
  capture.mock.restore();
  if (['read-once','delete-applied'].includes(scenario)) {
   assert.equal(result,0);
   assert.equal(hits,scenario === 'read-once' ? 4 : 2); // preflight retry, identity check, final settings read
   await assert.rejects(access(path),{code:'ENOENT'});
   assert.equal(provider.state.settings,null);
   assert.deepEqual([provider.state.databases.length,provider.state.buckets.length,provider.state.kv.length,provider.state.queues.length],[0,0,0,0]);
  } else {
   assert.equal(result,1);
   assert.equal(hits,scenario === 'preflight-forbidden' ? 1 : 3);
   const message = output.flatMap(text => text.trim().split('\n')).map(text => JSON.parse(text)).find(event => event.event === 'error').message;
   const remaining = scenario === 'partial-delete' ? [all[2]] : scenario === 'readback' ? [all[1]] : all;
   assert.match(message,new RegExp(`${remaining.length} resources remain`));
   for (const name of remaining) assert.ok(message.includes(name),message);
   assert.match(message,/run rer deploy .*--remove --yes again/);
   assert.doesNotMatch(message,/Deploy failed|Resources created this attempt/);
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
