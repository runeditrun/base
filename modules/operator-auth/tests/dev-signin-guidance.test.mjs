import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runtime, read, cookies, cookieFor, sessionHash, DEV_KEY, OWNER } from './dev-runtime.mjs';

const INVITEE = 'priya@example.com';
const gateOnly = cookie => cookie.split('; ').filter(pair => pair.startsWith('rer_dev_gate_8787=')).join('; ');
const invite = (r, cookie, email = INVITEE) => r.call('/auth/invite', { method: 'POST', cookie, input: { email, displayName: 'Priya', role: 'member' } });

async function fresh(bindings = {}, extraConfig = {}) {
  const r = await runtime([await read('../accounts/schema/operator-auth.sql')], extraConfig, 'dev-worker.mjs', bindings);
  await r.db.prepare(`INSERT INTO oa_operators(id,email,display_name,role,status,created_at) VALUES('owner','${OWNER}','Owner','owner','active',1)`).run();
  return r;
}

test('a visitor without the key reaches plain guidance and nothing else', async () => {
  const r = await fresh();
  try {
    const signin = await r.call('/signin');
    assert.equal(signin.status, 303);
    assert.equal(signin.headers.get('location'), '/__dev/key');
    const page = await r.call('/__dev/key');
    assert.equal(page.status, 200);
    const text = await page.text();
    assert.match(text, /rer dev --as owner/, 'names the command');
    assert.match(text, /rer dev --as<\/code> followed by their email/, 'names the invited person\'s command');
    assert.doesNotMatch(text, /RER_OPEN|RER_DEV_KEY/, 'no internal names');
    assert.ok(!text.includes(DEV_KEY), 'no key');
    assert.ok(!text.includes(DEV_KEY.slice(0, 12)), 'no part of the key');
    // Every gated surface still refuses a request without the key or its cookie.
    for (const path of ['/auth/dev/enter?as=owner', '/__dev/personas', '/auth/one-click?as=' + OWNER])
      assert.equal((await r.call(path)).status, 404, `${path} without the key`);
    assert.equal((await r.call('/auth/dev/enter?as=owner', { key: DEV_KEY.replace(/.$/, 'x') })).status, 404, 'a wrong key');
  } finally { await r.close(); }
});

test('a development mail provider sends nothing: the invitation says so and the key-gated owner can open it', async () => {
  const r = await fresh({ TEST_MAIL_STATUS: 'development' });
  try {
    const owner = cookies(await r.call('/auth/dev/enter?as=owner', { key: DEV_KEY }));
    const invited = await invite(r, owner);
    assert.equal(invited.status, 202);
    const body = await invited.json();
    assert.equal(body.delivery, 'none');
    assert.match(body.signInUrl, /^\/auth\/one-click\?as=priya%40example\.com/);
    const serialized = JSON.stringify(body), token = await r.latestLink();
    assert.ok(!serialized.includes(DEV_KEY) && !serialized.includes(token), 'neither the key nor the invitation token is in the response');

    // Without the key the link opens nothing; with it the invited person is signed in through the existing acceptance.
    assert.equal((await r.call(body.signInUrl)).status, 404, 'no key, no sign-in');
    assert.equal((await r.call(`/auth/confirm?token=${token}`)).status, 400, 'the dev-minted token still needs the key');
    const entered = await r.call(body.signInUrl, { cookie: gateOnly(owner) });
    assert.equal(entered.status, 303);
    const session = await (await r.call('/auth/session', { cookie: [gateOnly(owner), cookies(entered)].join('; ') })).json();
    assert.deepEqual([session.operator.email, session.operator.status, session.operator.role], [INVITEE, 'active', 'member']);
    assert.ok((await r.db.prepare('SELECT consumed_at FROM oa_tokens WHERE kind=\'invite\'').first()).consumed_at, 'the invitation is spent once accepted');
  } finally { await r.close(); }
});

test('the invitation link goes only to an owner holding the key; a delivered invitation is unchanged', async () => {
  const r = await fresh({ TEST_MAIL_STATUS: 'development' });
  try {
    const owner = cookies(await r.call('/auth/dev/enter?as=owner', { key: DEV_KEY }));
    // An admin session (a persona) sees that nothing was sent, but no link.
    assert.equal((await invite(r, owner, 'ada@example.com')).status, 202);
    const admin = [gateOnly(owner), cookies(await r.call('/auth/dev/enter?as=admin', { cookie: owner }))].join('; ');
    const byAdmin = await (await invite(r, admin, 'bo@example.com')).json();
    assert.deepEqual(byAdmin, { status: 'accepted', delivery: 'none' });
    // An owner session that did not come through the key gate gets no link either.
    await r.db.prepare("INSERT INTO oa_sessions(id,token_hash,operator_id,operator_version,kind,created_at,expires_at) SELECT 'native-owner',?,id,version,'native',?,? FROM oa_operators WHERE id='owner'")
      .bind(await sessionHash('N'.repeat(43)), Date.now(), Date.now() + 3600_000).run();
    const nativeOwner = await (await invite(r, cookieFor('N'.repeat(43)), 'cy@example.com')).json();
    assert.deepEqual(nativeOwner, { status: 'accepted', delivery: 'none' });
  } finally { await r.close(); }
  const delivered = await fresh();
  try {
    const owner = cookies(await delivered.call('/auth/dev/enter?as=owner', { key: DEV_KEY }));
    assert.deepEqual(await (await invite(delivered, owner)).json(), { status: 'accepted' }, 'a mail provider that accepted the message changes nothing');
  } finally { await delivered.close(); }
});

test('a deployed runtime has neither the gate nor the local guidance', async () => {
  const r = await fresh({ RER_DEV_KEY: '', AUTH_LOCAL: 'false', TEST_MAIL_STATUS: 'development' }, { local: false, origin: 'https://app.example.com' });
  try {
    for (const path of ['/__dev/key', '/__dev/personas', '/auth/dev/enter?as=owner']) {
      const response = await r.call(path, { key: DEV_KEY });
      assert.equal(response.status, 404, path);
      assert.doesNotMatch(await response.text(), /rer dev/);
    }
    const signin = await r.call('/signin');
    assert.notEqual(signin.headers.get('location'), '/__dev/key', 'the dev gate never takes /signin');
    assert.equal((await r.call('/auth/one-click?as=' + OWNER)).status, 404);
  } finally { await r.close(); }
});
