import test from 'node:test';
import assert from 'node:assert/strict';
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
