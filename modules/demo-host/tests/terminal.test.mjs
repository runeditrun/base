import test from 'node:test';
import assert from 'node:assert/strict';
import { front, cookieHeader } from './front.mjs';

test('terminal starts leave every unused place available while live visitors keep theirs', async () => {
  const max = 5, failures = ['exit', 'stopped', 'timeout'];
  let failing = false;
  const { mf, start, fetch } = await front({ max, startMs: 800, probeMs: 100,
    health: demo => {
      demo.failure ??= failing ? failures.shift() : 'none';
      return new Response(null, { status: { exit: 599, stopped: 598, timeout: 503, none: 200 }[demo.failure] });
    } });
  try {
    const live = await Promise.all([start(), start({ ip: '203.0.113.2' })]);
    assert.deepEqual(live.map(response => response.status), [303, 303]);
    failing = true;
    const failed = await Promise.all(Array.from({ length: max - live.length }, (_, i) => start({ ip: `203.0.113.${10 + i}`, headers: { accept: 'application/json' } })));
    assert.deepEqual(failed.map(response => response.status), [502, 502, 502]);
    for (const response of failed) {
      assert.ok(response.headers.get('x-rer-demo-correlation'));
      assert.ok((await response.json()).notice);
    }
    failing = false;
    const replacements = await Promise.all(Array.from({ length: max - live.length }, (_, i) => start({ ip: `203.0.113.${20 + i}` })));
    assert.deepEqual(replacements.map(response => response.status), [303, 303, 303]);
    for (const response of [...live, ...replacements]) {
      const page = await fetch('/app', { headers: { cookie: cookieHeader(response) } });
      assert.equal(page.status, 200);
    }
    assert.equal((await start({ ip: '203.0.113.30' })).status, 503, 'capacity refuses only when all five places have live visitors');
  } finally { await mf.dispose(); }
});
