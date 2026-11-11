import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runtime, presets } from '../../identity/oidc/tests/fake-runtime.mjs';

const key = 'fixture-only-one-click-local-key-0000000000000000';
const cookies = response => response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
const crossSite = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };

test('local one-click entry and custom sign-in choices refuse cookie-only cross-site navigation without consuming invitations', async t => {
  const origin = 'http://127.0.0.1:8787';
  const r = await runtime(t, { ...presets(origin), devKey: key,
    core: { origin, local: true, branding: { productName: 'Workspace', signInPath: '/login' } } });
  await r.bootstrap();
  const owner = cookies(await r.call('/auth/dev/enter?as=owner', { headers: { 'x-rer-dev-key': key } }));
  const gate = owner.split('; ').filter(pair => pair.startsWith('rer_dev_gate_')).join('; ');
  for (const email of ['priya@example.com', 'sam@example.com']) {
    assert.equal((await r.call('/auth/invite', { method: 'POST', cookie: owner,
      input: { email, displayName: email.split('@')[0], role: 'member' } })).status, 202);
  }
  const state = async () => ({
    sessions: (await r.db.prepare('SELECT count(*) AS n FROM oa_sessions').first()).n,
    consumed: (await r.db.prepare("SELECT count(*) AS n FROM oa_tokens WHERE kind='invite' AND consumed_at IS NOT NULL").first()).n,
  });
  const before = await state();
  for (const email of ['owner@example.com', 'priya@example.com']) {
    for (const headers of [crossSite, { ...crossSite, 'x-rer-dev-key': 'wrong' }]) {
      const refused = await r.call(`/auth/one-click?as=${encodeURIComponent(email)}`, { cookie: gate, headers });
      assert.equal(refused.status, 404);
      assert.equal(cookies(refused), '', 'no session issued');
    }
  }
  assert.deepEqual(await state(), before, 'no sessions or invitations changed');
  assert.equal((await r.db.prepare("SELECT status FROM oa_operators WHERE email='priya@example.com'").first()).status, 'invited');
  const choices = async headers => (await r.call('/login', { cookie: gate, headers })).text();
  assert.doesNotMatch(await choices(crossSite), /href="\/auth\/one-click/);
  assert.match(await choices({ 'sec-fetch-site': 'same-origin' }), /href="\/auth\/one-click/);
  assert.match(await choices({ ...crossSite, 'x-rer-dev-key': key }), /href="\/auth\/one-click/);
  for (const [email, headers, cookie] of [
    ['priya@example.com', { 'sec-fetch-site': 'same-origin' }, gate],
    ['sam@example.com', { ...crossSite, 'x-rer-dev-key': key }, undefined],
  ]) {
    const entered = await r.call(`/auth/one-click?as=${encodeURIComponent(email)}`, { cookie, headers });
    assert.equal(entered.status, 303);
    const session = await r.call('/auth/session', { cookie: `${gate}; ${cookies(entered)}`, headers: crossSite });
    assert.equal(session.status, 200, 'dev session remains admitted on an OAuth return');
    assert.equal((await session.json()).operator.email, email);
  }
  assert.equal((await state()).consumed, before.consumed + 2);
  const started = await r.call('/auth/oidc/auth/start', { method: 'POST', cookie: owner, input: { returnTo: '/app/queue' } });
  assert.equal(started.status, 303);
  const location = started.headers.get('location');
  const { code, state: oauthState } = await (await r.call('/__fake/authorize', { method: 'POST', input: { location, claims: {} } })).json();
  const callback = new URL(new URL(location).searchParams.get('redirect_uri'));
  const returned = await r.call(`${callback.pathname}?code=${code}&state=${oauthState}`, {
    cookie: `${owner}; ${cookies(started)}`, headers: crossSite,
  });
  assert.equal(returned.status, 303, 'OAuth callback with Lax cookies needs no key header');
  assert.equal(returned.headers.get('location'), '/app/queue');
  assert.equal((await r.call('/auth/session', { cookie: `${gate}; ${cookies(returned)}` })).status, 200);
});

test('ordinary hosted runtime keeps one-click entry unavailable even with a local key header', async t => {
  const r = await runtime(t);
  await r.bootstrap();
  const response = await r.call('/auth/one-click?as=owner%40example.com', { headers: { ...crossSite, 'x-rer-dev-key': key } });
  assert.equal(response.status, 404);
  assert.equal(cookies(response), '');
});
