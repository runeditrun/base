import test from 'node:test';
import assert from 'node:assert/strict';
import { front, ORIGIN, cookieHeader, demoCookie } from './front.mjs';

test('Try again destroys an abandoned start immediately and late readiness cannot take its replacement place', async () => {
  let healthy = false, releaseHealth;
  const observed = Promise.withResolvers();
  const { mf, demos, fetch, begin, start } = await front({ max: 1, startMs: 20_000, probeMs: 10_000,
    health: () => healthy ? Response.json({ ok: true }) : new Promise(resolve => { releaseHealth = resolve; observed.resolve(); }) });
  try {
    const pending = await begin({ headers: { accept: 'application/json' } });
    assert.equal(pending.status, 202);
    const cookie = cookieHeader(pending), firstId = /^rer_demo=([0-9a-f]{64});/.exec(demoCookie(pending))[1];
    await observed.promise;
    const cancelled = await fetch('/__demo/cancel', { method: 'POST', headers: { origin: ORIGIN, cookie } });
    assert.equal(cancelled.status, 204);
    assert.equal(demos.get(firstId).destroyed, true, 'release waits for destruction, not startup completion or idle expiry');
    assert.ok(cancelled.headers.getSetCookie().some(value => value.startsWith('rer_demo=;') && value.includes('Max-Age=0')));
    healthy = true;
    const replacement = await start({ ip: '203.0.113.2' });
    assert.equal(replacement.status, 303, 'the single place is available immediately');
    assert.notEqual(demoCookie(replacement), demoCookie(pending));
    releaseHealth(Response.json({ ok: true }));
    const ended = await fetch('/app', { headers: { cookie } });
    assert.equal(ended.status, 410);
    const foreign = await fetch('/__demo/cancel', { method: 'POST', headers: { origin: 'https://elsewhere.example', cookie: cookieHeader(replacement) } });
    assert.equal(foreign.status, 403);
    assert.equal((await fetch('/app', { headers: { cookie: cookieHeader(replacement) } })).status, 200);
    assert.equal((await start({ ip: '203.0.113.3' })).status, 503, 'only the replacement holds the place');
  } finally { releaseHealth?.(Response.json({ ok: true })); await mf.dispose(); }
});
