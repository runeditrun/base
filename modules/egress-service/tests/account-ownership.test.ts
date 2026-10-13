import test from 'node:test';
import assert from 'node:assert/strict';
import { readAccountOwnership } from '../account-ownership.mjs';
const account = 'a'.repeat(32), token = 'test-network-edge-token';
const target = { accountId: account, worker: 'egress-probe', origin: 'https://egress-probe.owner.workers.dev' };
const row = (n: number) => ({ id: n.toString(16).padStart(32, '0'), name: `zone${n}.example`, account: { id: account } });
const page = (n: number, total: number) => ({ success: true, result: Array.from({ length: Math.min(50, total - (n - 1) * 50) }, (_, i) => row((n - 1) * 50 + i)), result_info: { page: n, per_page: 50, count: Math.min(50, total - (n - 1) * 50), total_count: total, total_pages: Math.max(1, Math.ceil(total / 50)) } });

test('probe obtains the complete selected-account ownership inventory before deployment', async () => {
  const requests: string[] = [];
  const vars = await readAccountOwnership({ account, token, target, fetch: async (url: string, init: RequestInit) => {
    requests.push(url);
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error');
    assert.deepEqual(init.headers, { Authorization: `Bearer ${token}` });
    return Response.json(page(requests.length, 51));
  } });
  assert.deepEqual(requests, [1, 2].map(n => `https://api.cloudflare.com/client/v4/zones?account.id=${account}&page=${n}&per_page=50`));
  assert.deepEqual(JSON.parse(vars.EGRESS_OWNED_ZONES), Array.from({ length: 51 }, (_, i) => row(i).name).sort());
  assert.equal(vars.EGRESS_WORKERS_SUFFIX, 'owner.workers.dev');
  const empty = await readAccountOwnership({ account, token, target, fetch: async () => Response.json(page(1, 0)) });
  assert.deepEqual(JSON.parse(empty.EGRESS_OWNED_ZONES), []);
  const zeroPages = page(1, 0); zeroPages.result_info.total_pages = 0;
  assert.deepEqual(JSON.parse((await readAccountOwnership({ account, token, target, fetch: async () => Response.json(zeroPages) })).EGRESS_OWNED_ZONES), []);
});

test('probe refuses ownership inventories with wrong accounts, incomplete or drifting pages, invalid zones and provider failure', async () => {
  const mutations = [
    (p: any) => { p.result[0].account.id = 'b'.repeat(32); },
    (p: any) => { delete p.result_info; },
    (p: any) => { p.result_info.total_count++; },
    (p: any) => { p.result_info.page = 2; },
    (p: any) => { p.result_info.count--; },
    (p: any) => { p.result_info.total_pages++; },
    (p: any) => { p.result[0].name = '*.example.com'; },
    (p: any) => { p.result[1] = p.result[0]; },
    (p: any) => { p.result.pop(); },
    (p: any) => { p.success = false; },
  ];
  for (const mutate of mutations) await assert.rejects(readAccountOwnership({ account, token, target, fetch: async () => {
    const p = page(1, 51); mutate(p); return Response.json(p);
  } }), { message: 'egress-account-ownership-unverified' });
  let pages = 0;
  await assert.rejects(readAccountOwnership({ account, token, target, fetch: async () => {
    const p = page(++pages, 100);
    p.result = p.result.map(zone => ({ ...zone, name: `very-long-account-owned-zone-label-for-variable-budget-check.${zone.name}` }));
    return Response.json(p);
  } }), { message: 'egress-account-ownership-too-large' });
  for (const mode of ['drift', 'duplicate', 'http', 'json']) {
    let calls = 0;
    await assert.rejects(readAccountOwnership({ account, token, target, fetch: async () => {
      calls++;
      if (mode === 'http') return new Response(null, { status: 403 });
      if (mode === 'json') return new Response('{');
      const p = page(calls, calls === 2 && mode === 'drift' ? 52 : 51);
      if (calls === 2 && mode === 'duplicate') p.result[0] = row(0);
      return Response.json(p);
    } }), { message: 'egress-account-ownership-unverified' });
  }
});
