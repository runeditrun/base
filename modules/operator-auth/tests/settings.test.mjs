import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runtime, presets } from '../identity/oidc/tests/fake-runtime.mjs';

const path = '/auth/settings/identity';
const html = { accept: 'text/html' };
const post = (cookie, input, form = false) => ({ method: 'POST', cookie, input, form, ...(form ? { headers: html } : {}) });
async function emailSession(r, email) {
  assert.equal((await r.call('/auth/magic-link', post(undefined, { email }))).status, 202);
  const confirmed = await r.call('/auth/confirm', post(undefined, { token: await r.link() }));
  assert.equal(confirmed.status, 303);
  return r.session(confirmed);
}

test('member settings navigation gets an actionable document while JSON clients retain typed authorization errors', async t => {
  const r = await runtime(t, { providers: [], fakes: [] });
  const owner = await r.bootstrap();
  assert.equal((await r.call('/auth/invite', post(owner, { email: 'member@example.com', displayName: 'Jordan', role: 'member' }))).status, 202);
  const joined = await r.call('/auth/confirm', post(undefined, { token: await r.link() }));
  const member = r.session(joined);
  for (const method of ['GET', 'HEAD']) {
    const response = await r.call(path, { method, cookie: member, headers: html });
    assert.equal(response.status, 403);
    assert.match(response.headers.get('content-type'), /text\/html/);
    const body = await response.text();
    if (method === 'HEAD') assert.equal(body, '');
    else { assert.match(body, /<main>.*<h1>[^<]+<\/h1><p>[^<]+<\/p>/); assert.match(body, /href="\/app"/); }
  }
  const json = await r.call(path, { cookie: member, headers: { accept: 'application/json' } });
  assert.equal(json.status, 403);
  assert.deepEqual(await json.json(), { error: 'owner_required' });
  const refused = await r.call(path, post(member, { idpSignIn: 'true' }, true));
  assert.equal(refused.status, 403);
  assert.match(refused.headers.get('content-type'), /text\/html/);
});

test('OA and native settings refuse provider enablement without a configured or linked provider and preserve the disabled policy', async t => {
  for (const native of [false, true]) {
    const r = await runtime(t, { providers: [], fakes: [], ...(native ? { native: {} } : {}) });
    const owner = native ? await emailSession(r, 'owner@example.com') : await r.bootstrap();
    assert.equal((await r.call(path, post(owner, { idpSignIn: false }))).status, 200);
    const page = await r.call(path, { cookie: owner, headers: html });
    assert.match(await page.text(), /<input[^>]*name="idpSignIn"[^>]*disabled/);
    for (const form of [false, true]) {
      const response = await r.call(path, post(owner, { idpSignIn: form ? 'true' : true }, form));
      assert.equal(response.status, 409);
      if (form) { assert.match(response.headers.get('content-type'), /text\/html/); assert.match(await response.text(), /role="alert"/); }
      else assert.deepEqual(await response.json(), { error: 'provider_unlinked' });
    }
    const settings = await (await r.call(path, { cookie: owner })).json();
    assert.equal(settings.idpSignIn, false);
    assert.equal(settings.providerSetup.canEnable, false);
    await r.restart();
    assert.equal((await (await r.call(path, { cookie: owner })).json()).idpSignIn, false);
  }
});

test('configured providers retain first-use setup, saved form settings persist, and an explicit unlink blocks re-enabling', async t => {
  const setup = presets();
  const r = await runtime(t, { providers: [setup.providers[0]], fakes: [setup.fakes[0]] });
  const owner = await r.bootstrap();
  assert.equal((await r.call(path, post(owner, { idpSignIn: true }))).status, 200, 'static providers still pin on first use');
  assert.equal((await r.stepUp(owner, 'providers:relink')).status, 303);
  assert.equal((await r.call('/auth/providers/relink', post(owner, { provider: 'auth' }))).status, 200);
  const saved = await r.call(path, post(owner, {}, true));
  assert.equal(saved.status, 303);
  const confirmation = await r.call(saved.headers.get('location'), { cookie: owner, headers: html });
  assert.match(await confirmation.text(), /role="status"/);
  await r.restart();
  const settings = await (await r.call(path, { cookie: owner })).json();
  assert.equal(settings.idpSignIn, false);
  assert.equal(settings.providerSetup.canEnable, true);
  assert.equal(settings.providerSetup.providers[0].state, 'linked');
  assert.equal((await r.stepUp(owner, 'providers:unlink')).status, 303);
  assert.equal((await r.call('/auth/providers/unlink', post(owner, { provider: 'auth' }))).status, 200);
  const refused = await r.call(path, post(owner, { idpSignIn: true }));
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), { error: 'provider_unlinked' });
  assert.equal((await (await r.call(path, { cookie: owner })).json()).providerSetup.canEnable, false);
});
