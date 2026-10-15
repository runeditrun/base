import { test } from 'node:test';
import assert from 'node:assert/strict';
import { front, demoCookie, cookieHeader } from './front.mjs';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('a slow start answers progress, a retry resumes it, and a stuck copy frees its place without another visit', async () => {
  let healthy = false;
  const { mf, demos, begin, start, fetch } = await front({ max: 1, startMs: 800, probeMs: 100,
    health: () => healthy ? Response.json({ ok: true }) : new Promise(resolve => setTimeout(() => resolve(new Response(null, { status: 503 })), 1000)) });
  try {
    const pending = await begin({ headers: { accept: 'application/json' } });
    assert.equal(pending.status, 202);
    assert.deepEqual(await pending.json(), { pending: true });
    const cookie = cookieHeader(pending);
    assert.ok(!cookie.includes('operator_session'));
    const refreshed = await fetch('/', { headers: { cookie } });
    assert.equal(refreshed.status, 202);
    assert.equal(cookieHeader(refreshed), cookie);
    const retry = await begin({ headers: { accept: 'application/json', cookie } });
    assert.equal(retry.status, 202);
    assert.equal(cookieHeader(retry), cookie);
    assert.equal((await fetch('/__demo/status', { headers: { accept: 'application/json', cookie } })).status, 202);
    // Stop polling: the object must still finish cleanup and release capacity.
    for (let i = 0; i < 60 && ![...demos.values()].some(demo => demo.destroyed); i++) await sleep(50);
    assert.equal(demos.size, 1);
    assert.ok([...demos.values()].every(demo => demo.destroyed));
    assert.equal((await fetch('/__demo/status', { headers: { accept: 'application/json', cookie } })).status, 502);
    healthy = true;
    assert.equal((await start({ ip: '203.0.113.24' })).status, 303);
  } finally { await mf.dispose(); }
});

test('a fresh host admits N concurrent visitors, refuses the next, and reuses released places', async () => {
  const max = 10;
  const { mf, demos, start, fetch } = await front({ max });
  try {
    const visitors = await Promise.all(Array.from({ length: max }, (_, i) => start({ ip: `203.0.113.${30 + i}` })));
    assert.deepEqual(visitors.map(response => response.status), Array(max).fill(303));
    assert.equal(new Set(visitors.map(cookieHeader)).size, max);
    assert.equal((await start({ ip: '203.0.113.60' })).status, 503);
    for (const visitor of visitors.slice(0, 2)) {
      const cookie = cookieHeader(visitor), id = /^rer_demo=([0-9a-f]{64});/.exec(demoCookie(visitor))[1];
      demos.get(id).stop = true;
      assert.equal((await fetch('/app', { headers: { cookie } })).status, 410);
    }
    for (let i = 0; i < 2; i++) assert.equal((await start({ ip: `203.0.113.${70 + i}` })).status, 303);
    assert.equal([...demos.values()].filter(demo => !demo.destroyed && !demo.stop).length, max);
    assert.equal((await start({ ip: '203.0.113.80' })).status, 503);
  } finally { await mf.dispose(); }
});

test('an unresponsive human-check service returns the retry state without reserving a container', async () => {
  const { mf, demos, begin } = await front({ siteverify: () => new Promise(resolve => setTimeout(() => resolve(Response.json({ success: true })), 7000)) });
  try {
    const before = Date.now(), response = await begin({ headers: { accept: 'application/json' } });
    assert.equal(response.status, 502);
    assert.ok((await response.json()).notice);
    assert.ok(Date.now() - before < 6500, 'the network edge cannot silently hold the start');
    assert.equal(demos.size, 0);
  } finally { await mf.dispose(); }
});
