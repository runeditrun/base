import test from 'node:test';
import assert from 'node:assert/strict';
import { claimHostedOwner } from './deploy-owner.mjs';
import { runtime, ORIGIN, SETUP } from '../modules/operator-auth/identity/oidc/tests/fake-runtime.mjs';

test('deploy claims leave no live session, normal sign-in works, and browser claims still sign in', async t => {
 for (const native of [false, true]) await t.test(native ? 'native accounts' : 'Base accounts', async t => {
  const fresh = async () => {
   const r = await runtime(t, { providers: [], fakes: [], ...(native ? { native: { bootstrap: true } } : {}) });
   if (native) await r.db.prepare('DELETE FROM people').run();
   return r;
  };
  const r = await fresh(), table = native ? 'sessions' : 'oa_sessions';
  const live = async app => (await app.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE revoked_at IS NULL AND expires_at>?`).bind(Date.now()).first()).n;
  let bootstrapCookie, refuseSignout = false, app = r;
  const claim = () => claimHostedOwner({
   hook: {}, declaration: { secrets: [{ binding: 'SETUP_TOKEN', environment: 'SETUP_TOKEN' }] },
   deployed: { origin: ORIGIN }, env: { SETUP_TOKEN: SETUP }, addSecret() {},
   fetch: async (input, init) => {
    const url = new URL(input);
    assert.equal(url.origin, ORIGIN);
    if (refuseSignout && url.pathname === '/auth/signout') return new Response(null, { status: 503 });
    const headers = new Headers(init.headers);
    const response = await app.call(url.pathname, { method: init.method, input: JSON.parse(init.body), cookie: headers.get('cookie'), headers: { Origin: headers.get('origin') } });
    if (url.pathname === '/auth/bootstrap') bootstrapCookie = app.session(response);
    return response;
   },
  });
  assert.equal(await claim(), 'claimed');
  assert.equal(await live(r), 0, 'rer must retire the session returned by the actual bootstrap route');
  assert.equal((await r.call('/auth/session', { cookie: bootstrapCookie })).status, 401);
  assert.equal(await claim(), 'kept', 'a repeated deploy preserves the claimed owner');
  assert.equal(await live(r), 0);
  assert.equal((await r.call('/auth/magic-link', { method: 'POST', input: { email: 'owner@example.com' } })).status, 202);
  const signedIn = await r.call('/auth/confirm', { method: 'POST', input: { token: await r.link() } });
  assert.equal(signedIn.status, 303);
  const session = await r.call('/auth/session', { cookie: r.session(signedIn) });
  assert.equal(session.status, 200);
  assert.equal((await session.json()).operator.email, 'owner@example.com');
  assert.equal(await live(r), 1, 'the owner has only the session they just signed in with');

  const browser = await fresh();
  const claimed = await browser.call('/auth/bootstrap', { method: 'POST', form: true, input: { token: SETUP, displayName: 'Morgan Lee', returnTo: '/app' } });
  assert.equal(claimed.status, 303);
  assert.equal((await browser.call('/auth/session', { cookie: browser.session(claimed) })).status, 200);
  assert.equal(await live(browser), 1, 'browser bootstrap still signs the person in');

  // A refused sign-out must prevent deploy from reporting a successful claim.
  app = await fresh();
  refuseSignout = true;
  await assert.rejects(claim(), { message: 'owner-claim-failed' });
 });
});
