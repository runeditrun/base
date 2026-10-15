import test from 'node:test';
import assert from 'node:assert/strict';
import { front, cookieHeader, demoCookie } from './front.mjs';

test('closed-page demos survive object restarts for the full idle window and enforce idle and absolute ends', async () => {
  const { mf, demos, fetch, start } = await front({ max: 2, destroyFailures: 1 });
  try {
    const a = await start(), b = await start({ ip: '203.0.113.2' });
    assert.equal(a.status, 303); assert.equal(b.status, 303);
    const id = response => /^rer_demo=([0-9a-f]{64});/.exec(demoCookie(response))[1];
    const namespace = await mf.getDurableObjectNamespace('DEMO');
    const advance = async (response, minutes, options) => {
      const stub = namespace.get(namespace.idFromString(id(response)));
      if (options?.restart) {
        const previous = await stub.incarnation();
        // Aborting the instance also aborts this RPC. Its transport error
        // varies across Node versions; prove reconstruction independently.
        await assert.rejects(stub.advance(minutes * 60_000, options));
        const recovered = namespace.get(namespace.idFromString(id(response)));
        assert.notEqual(await recovered.incarnation(), previous);
      } else await stub.advance(minutes * 60_000, options);
    };
    const visit = response => fetch('/app', { headers: { cookie: cookieHeader(response) } });
    // No page, request, or polling occurs in these virtual fourteen-minute gaps.
    // Repeated object reconstruction also exercises reapplying the platform timeout.
    for (let visitNumber = 0; visitNumber < 4; visitNumber++) {
      await advance(a, 14, { restart: true });
      const alive = await visit(a);
      assert.equal(alive.status, 200);
      assert.equal(await alive.text(), `${id(a)} /app`);
      assert.equal(demos.get(id(a)).evicted, undefined);
    }
    // The alarm can arrive late; a visitor must never revive an expired session.
    await advance(b, 15 + 1 / 60, { restart: true });
    const idleEnded = await visit(b);
    assert.equal(idleEnded.status, 410);
    assert.match(await idleEnded.text(), /This demo has ended/);
    assert.ok(idleEnded.headers.getSetCookie().some(value => value.startsWith('rer_demo=;') && value.includes('Max-Age=0')));
    assert.equal((await start({ ip: '203.0.113.3' })).status, 303, 'idle expiry immediately frees a place');
    // Activity refreshed the idle deadline, but never the absolute hour.
    await advance(a, 4);
    const absoluteEnded = await visit(a);
    assert.equal(absoluteEnded.status, 410);
    assert.equal(demos.get(id(a)).destroyed, false, 'a cleanup failure still shows the ended page');
    assert.equal((await start({ ip: '203.0.113.4' })).status, 503, 'unconfirmed destruction retains its place');
    assert.equal((await visit(a)).status, 410);
    assert.equal(demos.get(id(a)).destroyed, true);
    assert.equal((await start({ ip: '203.0.113.5' })).status, 303, 'absolute expiry frees its place after cleanup');
  } finally { await mf.dispose(); }
});
