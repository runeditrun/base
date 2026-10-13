import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudflare } from '../provider.mjs';
import { reconcileResources } from '../resources.mjs';

const accountId = 'a'.repeat(32);
const options = {field:'buckets', pagination:'r2-bounded'};
const buckets = count => Array.from({length:count}, (_, i) => ({name:`bucket-${i}`}));
const page = (rows, info) => ({success:true, result:{buckets:rows}, errors:[], messages:[], ...(info === undefined ? {} : {result_info:info})});
function fixture(pages, config = {}) {
  const calls = [];
  const api = cloudflare({accountId, token:'fixture', ...config, fetch:async (url, init) => {
    calls.push({url, method:init.method});
    assert.equal(init.method, 'GET');
    assert(calls.length <= pages.length, 'unexpected request or retry');
    return Response.json(pages[calls.length - 1]);
  }});
  return {api, calls, list:() => api.list('/r2/buckets', options)};
}

test('R2 bounded mode accepts absent or null metadata only on a short requested-limit page', async () => {
  for (const info of [undefined, null]) {
    for (const count of [0, 6, 999]) {
      const rows = buckets(count); const f = fixture([page(rows, info)]);
      assert.deepEqual(await f.list(), rows);
      assert.deepEqual(f.calls, [{url:`https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets?per_page=1000`, method:'GET'}]);
    }
    const f = fixture([page(buckets(1000), info)]);
    await assert.rejects(f.list(), /provider-incomplete-pagination/);
    assert.equal(f.calls.length, 1);
  }
});

test('R2 bounded mode rejects incorrect endpoints and fields before any request', async () => {
  const f = fixture([]);
  for (const [path, field] of [['/queues','buckets'], ['/r2/buckets/','buckets'], ['/r2/buckets?per_page=1','buckets'], ['/r2/buckets','other'], ['/r2/buckets',undefined]]) {
    await assert.rejects(f.api.list(path, {field, pagination:'r2-bounded'}), /invalid-r2-bounded-list/);
  }
  assert.equal(f.calls.length, 0);
});

test('R2 bounded mode follows encoded cursors through full pages and accepts a short terminal page', async () => {
  for (const terminal of [undefined, null, {per_page:1000}, {per_page:1000, cursor:''}]) {
    const rows = buckets(1000);
    const f = fixture([page(rows, {per_page:1000, cursor:'YWJj+/=='}), page([{name:'last'}], terminal)]);
    assert.deepEqual(await f.list(), [...rows, {name:'last'}]);
    assert.equal(f.calls.length, 2);
    assert(f.calls[1].url.endsWith('/r2/buckets?per_page=1000&cursor=YWJj%2B%2F%3D%3D'));
  }
});

test('R2 bounded mode respects a smaller reported page bound and follows a short page with a cursor', async () => {
  const f = fixture([page([{name:'first'}], {per_page:2, cursor:'next'}), page([], {per_page:2})]);
  assert.deepEqual(await f.list(), [{name:'first'}]);
  assert.equal(f.calls.length, 2);
  for (const info of [{per_page:1}, {per_page:1,cursor:''}]) {
    const full = fixture([page([{name:'first'}], info)]);
    await assert.rejects(full.list(), /provider-partial-list/);
  }
});

test('R2 bounded mode rejects malformed metadata, lists and oversized pages', async () => {
  for (const info of [{}, [], false, '', {per_page:0}, {per_page:-1}, {per_page:1.5}, {per_page:'1000'}, {per_page:1001}, {per_page:null}]) {
    const f = fixture([page([], info)]);
    await assert.rejects(f.list(), /provider-incomplete-pagination/);
    assert.equal(f.calls.length, 1);
  }
  for (const rows of [undefined, {}, null]) {
    await assert.rejects(fixture([page(rows)]).list(), /provider-invalid-list/);
  }
  for (const info of [undefined, null, {per_page:1000,cursor:'next'}]) {
    await assert.rejects(fixture([page(buckets(1001), info)]).list(), /provider-partial-list/);
  }
  await assert.rejects(fixture([page(buckets(2), {per_page:1,cursor:'next'})]).list(), /provider-partial-list/);
});

test('R2 bounded mode rejects invalid cursors and repeated continuation tokens', async () => {
  for (const cursor of [null, 0, false, {}, [], 'bad&cursor', 'white space']) {
    await assert.rejects(fixture([page([], {per_page:1000,cursor})]).list(), /provider-invalid-cursor/);
  }
  const f = fixture([page([], {per_page:1000,cursor:'same'}), page([], {per_page:1000,cursor:'same'})]);
  await assert.rejects(f.list(), /provider-invalid-cursor/);
  assert.equal(f.calls.length, 2);
});

test('R2 bounded mode validates optional totals and count evidence without hiding contradictions', async () => {
  const first = page([{name:'first'}], {per_page:2,cursor:'next',total_count:2,count:1});
  for (const terminal of [undefined, null, {per_page:2,total_count:2,count:1}]) {
    assert.equal((await fixture([first, page([{name:'last'}], terminal)]).list()).length, 2);
  }
  for (const info of [{per_page:2,total_count:0}, {per_page:2,total_count:2}, {per_page:2,count:0}, {per_page:2,count:'1'}, {per_page:2,total_count:1,cursor:'next'}]) {
    await assert.rejects(fixture([page([{name:'first'}], info)]).list(), /provider-partial-list/);
  }
  for (const total_count of [-1, null, '1', 1.5]) {
    await assert.rejects(fixture([page([], {per_page:1000,total_count})]).list(), /provider-incomplete-pagination/);
  }
  for (const terminal of [undefined, null, {per_page:2}]) {
    await assert.rejects(fixture([first, page([], terminal)]).list(), /provider-partial-list/);
  }
  await assert.rejects(fixture([first, page([{name:'last'}], {per_page:2,total_count:3})]).list(), /provider-pagination-changed/);
});

test('R2 bounded mode retains row, page and request budgets', async () => {
  const full = buckets(1000);
  const oversized = fixture(Array.from({length:11}, (_, i) => page(full, {per_page:1000,cursor:`next${i}`})));
  await assert.rejects(oversized.list(), /provider-list-too-large/);
  assert.equal(oversized.calls.length, 11);
  const endless = fixture(Array.from({length:100}, (_, i) => page([], {per_page:1000,cursor:`next${i}`})));
  await assert.rejects(endless.list(), /provider-pagination-limit/);
  assert.equal(endless.calls.length, 100);
  const limited = fixture([page([], {per_page:1000,cursor:'next'})], {maxRequests:1});
  await assert.rejects(limited.list(), /provider-request-budget/);
  assert.equal(limited.calls.length, 1);
});

test('resource reconciliation selects bounded R2 listing and completes read-only inspection', async () => {
  const rows = [{name:'owned-files'}];
  const f = fixture([page(rows), {success:true,result:rows[0]}]);
  const plan = {d1:[], queues:[], r2:[{binding:'FILES',name:'owned-files'}]};
  assert.deepEqual(await reconcileResources(f.api, plan, {create:false}), {d1:[],queues:[],r2:plan.r2});
  assert.equal(f.calls.length, 2);
  assert(f.calls[1].url.endsWith('/r2/buckets/owned-files'));
});

test('resource reconciliation stops before a create when bounded inventory is incomplete', async () => {
  const f = fixture([page(buckets(1000))]);
  await assert.rejects(reconcileResources(f.api, {d1:[],queues:[],r2:[{binding:'FILES',name:'new-files'}]}), /provider-incomplete-pagination/);
  assert.equal(f.calls.length, 1);
});
