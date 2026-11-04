import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setImmediate as turn } from 'node:timers/promises';
import { siteProvider } from '../modules/deploy-kit/tests/site-provider.mjs';
import { main } from './main.mjs';
import { deployProviderFixture } from './fixtures/deploy-provider.mjs';

// These are response-shape reproductions, not recorded stranger payloads: that
// journey retained only CLI errors, without the failing HTTP exchanges.
test('rer deploy accepts terminal Cloudflare list shapes and follows advertised pages', async t => {
 for (const shape of ['absent', 'null', 'empty-cursor', 'absent-cursor', 'total-pages', 'next-page', 'next-cursor']) await t.test(shape, async t => {
  const f = await deployProviderFixture(t, { d1: [{binding:'DB'}], queues: [{binding:'JOBS', consumer:{batch_size:10,max_retries:3}}] });
  const fetch = f.provider.fetch;
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
   const response = await fetch(input, init), url = new URL(input);
   if ((init.method ?? 'GET') !== 'GET' || !['/d1/database','/r2/buckets','/queues'].some(path => url.pathname.endsWith(path))) return response;
   const body = await response.json();
   const rows = Array.isArray(body.result) ? body.result : body.result.buckets;
   if (shape === 'absent') delete body.result_info;
   if (shape === 'null') body.result_info = null;
   if (shape === 'empty-cursor') body.result_info = {per_page:rows.length || 1, cursor:''};
   if (shape === 'absent-cursor') body.result_info = {per_page:rows.length || 1};
   if (shape === 'total-pages') body.result_info = {page:1,total_pages:1};
   if (shape.startsWith('next-')) {
    const second = url.searchParams.get('page') === '2' || url.searchParams.has('cursor');
    body.result_info = shape === 'next-page' ? {page:second?2:1,total_pages:2} : {cursor:second?'':'test-next'};
    if (!second) { if (Array.isArray(body.result)) body.result = []; else body.result.buckets = []; }
   }
   return Response.json(body);
  });
  assert.equal(await f.run(), 0);
  if (shape.startsWith('next-')) assert.ok(f.provider.state.calls.some(call => /page=2|cursor=test-next/.test(call.search)));
 });
});

test('rer deploy refuses an explicitly truncated provider list without a usable continuation', async t => {
 const f = await deployProviderFixture(t);
 t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
  const response = await f.provider.fetch(input, init);
  if (new URL(input).pathname.endsWith('/r2/buckets') && (init.method ?? 'GET') === 'GET') {
   const body = await response.json(); body.result_info = {is_truncated:true}; return Response.json(body);
  }
  return response;
 });
 assert.equal(await f.run(), 1);
 assert.equal(f.provider.state.writes.length, 0);
});

test('rer deploy --remove --yes detaches every owned queue consumer, deletes once and reads back absence', async t => {
 const f = await deployProviderFixture(t, {r2:[],queues:[{binding:'JOBS',consumer:{batch_size:10,max_retries:3}}]});
 assert.equal(await f.run(), 0);
 const queue = f.provider.state.queues[0];
 // Real consumer responses may use script rather than script_name; a queue can
 // also have a pull consumer. Neither may be left attached at queue deletion.
 queue.consumers = [{consumer_id:'b'.repeat(32),type:'worker',script:'fixture-production'}, {consumer_id:'c'.repeat(32),type:'http_pull'}];
 const fetch = f.provider.fetch;
 let stale = 1;
 t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
  if (new URL(input).pathname.endsWith(`/queues/${queue.queue_id}`) && init.method === 'DELETE' && queue.consumers.length) return Response.json({success:false,errors:[{code:10000,message:'Queue still has consumers'}]}, {status:409});
  const response = await fetch(input,init);
  if (new URL(input).pathname.endsWith('/queues') && (init.method ?? 'GET') === 'GET' && !f.provider.state.queues.length && stale-- > 0) return Response.json({success:true,result:[queue],result_info:{page:1,total_pages:1,total_count:1}});
  return response;
 });
 const start = f.provider.state.calls.length;
 assert.equal(await f.run('--remove','--yes'), 0);
 assert.equal(f.provider.state.queues.length, 0);
 const calls = f.provider.state.calls.slice(start);
 const deleted = calls.findIndex(call => call.method === 'DELETE' && call.path === `/queues/${queue.queue_id}`);
 assert.equal(calls.slice(0,deleted).filter(call => call.method === 'DELETE' && call.path.includes('/consumers/')).length, 2);
 assert.equal(calls.filter(call => call.method === 'DELETE' && call.path === `/queues/${queue.queue_id}`).length, 1);
 assert.ok(calls.slice(deleted+1).some(call => call.method === 'GET' && call.path === '/queues'));
});

// Use the public CLI and its real site build. Only Cloudflare's network edge and
// time are controlled; the provider's paginator and all deploy decisions run.
async function siteListingFixture(t) {
 const {root} = await deployProviderFixture(t);
 const provider = siteProvider({domain:'run-fixture.example.test'});
 t.after(() => provider.close());
 Object.assign(process.env, {CLOUDFLARE_ACCOUNT_ID:provider.accountId,CLOUDFLARE_API_TOKEN:provider.token});
 const adapter = join(root,'adapter.mjs');
 await writeFile(adapter,(await readFile(adapter,'utf8')).replace('...lifecycle,deploy:', "...lifecycle,settings:[],site:{entry:'site.mjs',output:'dist/site',declaration:'deploy-site.json'},deploy:"));
 await writeFile(join(root,'site.mjs'), `export const sitePages = () => ({pages:[{path:'/',html:'<a href="/run">Run</a>'},{path:'/run',html:'<h1>Run</h1>'}],assets:[]});`);
 await writeFile(join(root,'deploy-site.json'), JSON.stringify({version:1,domain:'run-fixture.example.test'}));
 await symlink(resolve(import.meta.dirname,'../default-seed/node_modules'),join(root,'node_modules'),'dir');
 const output = [], errors = [];
 const stdout = process.stdout.write.bind(process.stdout), stderr = process.stderr.write.bind(process.stderr);
 t.mock.method(process.stdout,'write',(...args) => {if (typeof args[0] === 'string') output.push(args[0]);return stdout(...args);});
 t.mock.method(process.stderr,'write',(...args) => {if (typeof args[0] === 'string') errors.push(args[0]);return stderr(...args);});
 let done = false;
 const run = async () => {try {return await main(['deploy','--site','--cwd',root,'--json','--no-queue']);} finally {done=true;}};
 return {root,provider,run,output,errors,get done(){return done;}};
}

async function drain() { for (let i=0;i<10;i++) await turn(); }

// Timer mocking begins at the first provider response, after the real site
// build. Stepping just short of each delay proves reads cannot resume early.
function listingEdge(t, f, {path='/zones',failure='partial',failures=1,later=false,realTime=false} = {}) {
 let attempts = 0, failuresLeft = failures, clockStarted = false, observed = false;
 const pages = [], started = [], query = [];
 t.mock.method(globalThis,'fetch',async (input,init = {}) => {
  const url = new URL(input), method = init.method ?? 'GET';
  const response = await f.provider.fetch(input,init);
  const base = url.pathname.replace(`/client/v4/accounts/${f.provider.accountId}`,'').replace('/client/v4','');
  if (method !== 'GET' || base !== path) return response;
  if (!clockStarted && !realTime) {t.mock.timers.enable({apis:['setTimeout']});clockStarted=true;}
  const page = Number(url.searchParams.get('page') ?? 1);
  pages.push(page);query.push(url.search);
  if (page === 1) {attempts++;started.push(performance.now());}
  if (failuresLeft <= 0) return response;
  const body = await response.json();
  if (later && page === 1) {
   // A foreign hostname in the discarded snapshot must never poison the new
   // snapshot's collision check (or be combined with its second page).
   body.result = [{hostname:'run-fixture.example.test',service:'foreign-worker'}];
   body.result_info = {page:1,total_pages:2,total_count:2};
  } else {
   failuresLeft--;observed=true;
   if (failure === '403' || failure === '503') return Response.json({success:false,errors:[{code:10000,message:'Synthetic provider refusal'}]},{status:Number(failure)});
   if (failure === 'truncated') return Response.json({success:true,result:body.result,result_info:{is_truncated:true}});
   if (failure === 'malformed') return Response.json({success:true,result:{}});
   body.result_info = failure === 'changed' ? {page,total_pages:2,total_count:3} : later ? {page,total_pages:2,total_count:2} : {page,total_pages:1,total_count:0};
  }
  return Response.json(body);
 });
 return {pages,query,started,get attempts(){return attempts;},get observed(){return observed;},
  async waitForFailure() {
   // Real I/O (the CLI build) finishes before timers become controlled.
   const until = performance.now()+30000;
   while (!observed && !f.done && performance.now()<until) await turn();
   assert.ok(observed, f.output.join('')+f.errors.join(''));
   await drain();
  },
  async retry() {
   const count = pages.length;
   assert.equal(f.done,false,'the failed read waits instead of refusing');
   t.mock.timers.tick(19999);await drain();assert.equal(pages.length,count,'no read before 20 seconds');
   assert.equal(f.done,false,'the command remains pending during backoff');
   t.mock.timers.tick(1);await drain();
  }};
}

const uploads = f => f.provider.state.writes.filter(call => call.method === 'PUT' && /\/workers\/scripts\/[^/]+$/.test(call.path));

test('rer deploy --site restarts inconsistent lists and never replays writes', async t => {
 for (const scenario of [
  {path:'/zones',failures:2},
  {path:'/workers/domains',failure:'partial',later:true},
  {path:'/workers/domains',failure:'changed',later:true},
  {path:'/workers/scripts/fixture-production--site/versions',afterUpload:true},
  {path:'/workers/scripts/fixture-production--site/deployments',afterUpload:true},
 ]) await t.test(`${scenario.path} ${scenario.failure ?? 'partial'}`,async t => {
  const f = await siteListingFixture(t);
  // Worker version and deployment lists are first read after upload on a new site.
  const edge = listingEdge(t,f,scenario), pending = f.run();
  await edge.waitForFailure();
  assert.equal(uploads(f).length,scenario.afterUpload?1:0);
  for (let i=0;i<(scenario.failures ?? 1);i++) await edge.retry();
  assert.equal(await pending,0,f.output.join('')+f.errors.join(''));
  assert.equal(edge.attempts,3);
  assert.deepEqual(edge.pages.slice(0,scenario.later?3:2),scenario.later?[1,2,1]:[1,1]);
  if (scenario.path === '/zones') assert.ok(edge.query.every(query=>query.includes('name=run-fixture.example.test')&&query.includes('account.id=')));
  if (scenario.path === '/workers/domains') assert.ok(edge.query.every(query=>query.includes('zone_id=')));
  assert.equal(uploads(f).length,1,'one Worker upload despite failed list');
  assert.equal(f.provider.state.domains.length,2);
  assert.equal(f.provider.state.writes.filter(call=>call.path === '/workers/domains').length,2,'each hostname attached once');
  const receipt = JSON.parse(await readFile(join(f.root,'.rer/deploy/site-production.json'),'utf8'));
  assert.equal(receipt.domain,'run-fixture.example.test');
 });
});

test('rer deploy --site exhausts three inconsistent preflight reads without deploying', async t => {
 for (const scenario of [{path:'/zones'}, {path:'/workers/domains',failure:'changed',later:true}]) await t.test(`${scenario.path} ${scenario.failure ?? 'partial'}`,async t => {
  const f = await siteListingFixture(t), edge = listingEdge(t,f,{...scenario,failures:Infinity}), pending = f.run();
  await edge.waitForFailure();
  await edge.retry();await edge.retry();
  assert.equal(await pending,1,f.output.join('')+f.errors.join(''));
  assert.equal(edge.attempts,3);
  assert.deepEqual(edge.pages,scenario.later?[1,2,1,2,1,2]:[1,1,1]);
  assert.equal(f.provider.state.writes.length,0);
  const output = f.output.join('');
  assert.match(output,scenario.later?/provider-pagination-changed/:/provider-partial-list/);
  assert.ok(output.includes(`GET ${scenario.path}`),'the original pagination diagnostic survives exhaustion');
  await assert.rejects(readFile(join(f.root,'.rer/deploy/site-production.json')),{code:'ENOENT'});
 });
});

test('rer deploy --site refuses ordinary provider errors immediately and cancels a settling wait', async t => {
 for (const failure of ['403','503','malformed','truncated','cancel']) await t.test(failure,async t => {
  const f = await siteListingFixture(t), edge = listingEdge(t,f,{failure:failure === 'cancel'?'partial':failure}), pending = f.run();
  await edge.waitForFailure();
  if (failure === 'cancel') {assert.equal(f.done,false,'cancellation interrupts the wait');process.emit('SIGINT');}
  const code = await pending;
  assert.equal(code,failure === 'cancel'?130:1,f.output.join('')+f.errors.join(''));
  t.mock.timers.tick(60000);await drain();
  assert.equal(edge.attempts,1);
  assert.equal(f.provider.state.writes.length,0);
  assert.match(f.output.join(''),failure === 'cancel'?/cancelled/:failure === 'malformed'?/provider-invalid-list/:failure === 'truncated'?/provider-incomplete-pagination/:new RegExp(`provider-http-${failure}`));
 });
});

test('rer deploy --site preserves stable deployment and repeat behaviour', async t => {
 const f = await siteListingFixture(t);
 t.mock.method(globalThis,'fetch',f.provider.fetch);
 assert.equal(await f.run(),0,f.output.join('')+f.errors.join(''));
 assert.equal(uploads(f).length,1);
 assert.equal(f.provider.state.domains.length,2);
 const writes = f.provider.state.writes.length;
 assert.equal(await f.run(),0,f.output.join('')+f.errors.join(''));
 assert.equal(uploads(f).length,2);
 assert.equal(f.provider.state.writes.slice(writes).filter(call=>call.path === '/workers/domains').length,0);
});


test('rer deploy --site waits a real 20 seconds before restarting a partial zone read', async t => {
 const f = await siteListingFixture(t), edge = listingEdge(t,f,{realTime:true}), pending = f.run();
 await edge.waitForFailure();
 assert.equal(f.done,false);
 assert.equal(f.provider.state.writes.length,0);
 assert.equal(await pending,0,f.output.join('')+f.errors.join(''));
 assert.equal(edge.attempts,2);
 assert.ok(edge.started[1]-edge.started[0] >= 20000,'the real backoff is at least 20 seconds');
 assert.equal(uploads(f).length,1);
});
