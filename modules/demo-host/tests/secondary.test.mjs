import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ORIGIN, front, cookieHeader, demoCookie } from './front.mjs';

const SECONDARY = ORIGIN.replace('://', '://page.');
test('declared secondary hosts keep each visitor in their own demo and preserve the public host', async () => {
  const { mf, demos, fetch, start } = await front({ secondary: [SECONDARY] });
  try {
    const first = await start(), second = await start({ ip: '203.0.113.2' });
    const id = response => /^rer_demo=([0-9a-f]{64});/.exec(demoCookie(response))[1];
    const one = id(first), two = id(second);
    assert.notEqual(one, two);
    assert.deepEqual(JSON.parse(demos.get(one).env.RER_INGRESS_ORIGINS), [ORIGIN, SECONDARY]);
    for (const [response, expected] of [[first, one], [second, two]]) {
      // Browsers send the domain demo cookie to the page host, but never the
      // primary host's __Host owner cookie. The seed sees its secondary host.
      const cookie = demoCookie(response).split(';')[0];
      const page = await fetch(SECONDARY + '/published', { headers: { cookie, 'x-rer-ingress-origin': 'https://unrelated.example' } });
      assert.equal(page.status, 200);
      assert.equal(await page.text(), `${expected} /published`);
      const forwarded = demos.get(expected).forwarded.at(-1);
      assert.equal(forwarded.origin, SECONDARY);
      assert.equal(forwarded.cookie, cookie);
      assert.equal(new URL(forwarded.url).protocol, 'http:');
    }
    const primary = await fetch('/app', { headers: { cookie: cookieHeader(first) } });
    assert.equal(primary.status, 200);
    assert.equal(demos.get(one).forwarded.at(-1).origin, ORIGIN);
    for (const cookie of ['', 'rer_demo=forged']) {
      const anonymous = await fetch(SECONDARY + '/published', { headers: { cookie } });
      assert.equal(anonymous.status, 303);
      assert.equal(anonymous.headers.get('location'), ORIGIN + '/');
    }
    assert.equal((await fetch(SECONDARY + '/published', { method: 'POST' })).status, 403);
    for (const path of ['/__demo/start', '/__demo/cancel', '/__demo/status', '/__demo/operator/anything']) {
      assert.equal((await fetch(SECONDARY + path, { method: 'POST', headers: { cookie: cookieHeader(first), origin: ORIGIN } })).status, 403);
    }
    assert.equal((await fetch('https://unlisted.demo.run-test.example/published', { headers: { cookie: cookieHeader(first) } })).status, 404);
    demos.get(one).stop = true;
    const ended = await fetch(SECONDARY + '/published', { headers: { cookie: demoCookie(first).split(';')[0] } });
    assert.equal(ended.status, 410);
    assert.ok((await ended.text()).includes(`href="${ORIGIN}/"`));
    assert.ok(ended.headers.getSetCookie().some(cookie => cookie.startsWith('rer_demo=;') && cookie.includes('Max-Age=0')));
    assert.equal((await fetch(SECONDARY + '/published', { headers: { cookie: demoCookie(second).split(';')[0] } })).status, 200);
  } finally { await mf.dispose(); }
});
