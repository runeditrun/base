import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runtime, read, cookies, DEV_KEY, OWNER } from './dev-runtime.mjs';

async function fresh() {
  const r = await runtime([await read('../accounts/schema/operator-auth.sql')]);
  await r.db.prepare(`INSERT INTO oa_operators(id,email,display_name,role,status,created_at) VALUES('owner','${OWNER}','Owner','owner','active',1)`).run();
  return r;
}
const gateOnly = cookie => cookie.split('; ').filter(pair => pair.startsWith('rer_dev_gate_8787=')).join('; ');
const sessionOnly = cookie => cookie.split('; ').filter(pair => !pair.startsWith('rer_dev_gate_8787=')).join('; ');

test('dev sign-in, personas and the badge answer only behind the key gate, and a dev session counts only there', async () => {
  const r = await fresh();
  try {
    for (const path of ['/auth/dev/enter?as=owner', '/__dev/personas']) {
      assert.equal((await r.call(path)).status, 404, `${path} without the key`);
      assert.equal((await r.call(path, { key: DEV_KEY.replace(/.$/, 'x') })).status, 404, `${path} with a wrong key`);
    }
    assert.deepEqual(await (await r.call('/__dev/personas', { key: DEV_KEY })).json(),
      [{ as: 'owner', email: OWNER }, { as: 'admin', email: 'admin@dev.localhost', role: 'admin' }, { as: 'signed-out' }]);
    const entered = await r.call('/auth/dev/enter?as=owner', { key: DEV_KEY });
    assert.equal(entered.status, 303);
    assert.equal(entered.headers.get('location'), '/app');
    const gate = entered.headers.getSetCookie().find(line => line.startsWith('rer_dev_gate_8787='));
    assert.match(gate, /; Path=\/; HttpOnly; SameSite=Strict/);
    assert.doesNotMatch(gate, /Domain=/i, 'host-only');
    const both = cookies(entered);
    assert.equal((await r.call('/auth/session', { cookie: both })).status, 200);
    assert.equal((await r.call('/auth/session', { cookie: sessionOnly(both) })).status, 401, 'a dev session without the gate is refused');
    // The browser cookie alone passes the gate; reuse keeps the same session row.
    assert.equal((await r.call('/auth/dev/enter?as=owner', { cookie: both })).status, 303);
    assert.equal((await r.db.prepare("SELECT count(*) AS n FROM oa_sessions WHERE kind='dev'").first()).n, 1, 'reused');
    // The badge appears only with the gate, under the document's own CSP.
    const page = await r.call('/somewhere', { cookie: both });
    const html = await page.text();
    assert.match(html, /id="rer-dev-badge"/);
    assert.match(html, /Switch to admin/);
    assert.match(page.headers.get('content-security-policy'), /style-src 'sha256-/);
    assert.doesNotMatch(await (await r.call('/somewhere', { cookie: sessionOnly(both) })).text(), /rer-dev-badge/);
    // Persona: a real operator, created only here, behind version fences.
    const admin = await r.call('/auth/dev/enter?as=admin&returnTo=/app/team', { cookie: gateOnly(both) });
    assert.equal(admin.headers.get('location'), '/app/team');
    const adminCookie = [gateOnly(both), cookies(admin)].join('; ');
    assert.equal((await (await r.call('/auth/session', { cookie: adminCookie })).json()).operator.email, 'admin@dev.localhost');
    await r.db.prepare("UPDATE oa_operators SET role='member' WHERE email='admin@dev.localhost'").run();
    assert.equal((await r.call('/auth/session', { cookie: adminCookie })).status, 401, 'a role change fences the dev session');
    await r.db.prepare("UPDATE oa_operators SET status='inactive' WHERE email='admin@dev.localhost'").run();
    assert.equal((await r.call('/auth/dev/enter?as=admin', { cookie: adminCookie })).status, 403, 'a deactivated persona cannot sign in');
    // Signed-out revokes the current session.
    const out = await r.call('/auth/dev/enter?as=signed-out', { cookie: both });
    assert.equal(out.headers.get('location'), '/');
    assert.equal((await r.call('/auth/session', { cookie: both })).status, 401);
    assert.equal((await r.call('/auth/dev/enter?as=nobody', { cookie: both })).status, 404);
  } finally { await r.close(); }
});

test('a link minted while using a dev session is a dev credential: it needs the gate and yields a dev session', async () => {
  const r = await fresh();
  try {
    const owner = cookies(await r.call('/auth/dev/enter?as=owner', { key: DEV_KEY }));
    const invited = await r.call('/auth/invite', { method: 'POST', cookie: owner, input: { email: 'new@example.com', displayName: 'New', role: 'member' } });
    assert.equal(invited.status, 202);
    const token = await r.latestLink();
    assert.equal((await r.db.prepare("SELECT credential FROM oa_dev_credentials").first()).credential, 'oa_tokens');
    assert.equal((await r.call(`/auth/confirm?token=${token}`)).status, 400, 'without the gate the link is invalid');
    assert.equal((await r.call('/auth/confirm', { method: 'POST', input: { token } })).status, 400);
    const confirmed = await r.call('/auth/confirm', { method: 'POST', input: { token }, cookie: gateOnly(owner) });
    assert.equal(confirmed.status, 303);
    const session = await r.call('/auth/session', { cookie: [gateOnly(owner), cookies(confirmed)].join('; ') });
    assert.deepEqual([(await session.json()).kind, session.status], ['dev', 200]);
  } finally { await r.close(); }
});

test('dev sign-in obeys domain provider rules on issue and reuse, with an active owner exemption', async () => {
  const r = await runtime([await read('../accounts/schema/operator-auth.sql'), await read('../identity/oidc/schema/oidc.sql')], {
    OIDC_TRANSACTION_SECRET: 'test-only-dev-domain-transaction-secret',
    providers: [{ id: 'okta', preset: 'okta', issuer: 'https://corp.okta.example', clientId: 'dev-app', tokenAuthMethod: 'client_secret_post', clientSecret: 'test-only-okta-secret' }],
  });
  try {
    await r.db.prepare("INSERT INTO oa_operators(id,email,display_name,role,status,created_at) VALUES('owner',?,'Owner','owner','active',1)").bind(OWNER).run();
    await r.call('/auth/magic-link', { method: 'POST', input: { email: OWNER } });
    const owner = cookies(await r.call('/auth/confirm', { method: 'POST', input: { token: await r.latestLink() } }));
    const admin = cookies(await r.call('/auth/dev/enter?as=admin', { key: DEV_KEY }));
    assert.equal((await r.call('/auth/session', { cookie: admin })).status, 200);
    for (const domain of ['dev.localhost', 'example.com']) {
      assert.equal((await r.call('/auth/domain-rules', { method: 'POST', cookie: owner, input: { domain, provider: 'okta' } })).status, 200);
    }
    const count = async () => (await r.db.prepare("SELECT count(*) AS n FROM oa_sessions WHERE kind='dev'").first()).n;
    const n = await count();
    for (const context of [{ key: DEV_KEY }, { cookie: admin }]) {
      const refused = await r.call('/auth/dev/enter?as=admin', context);
      assert.equal(refused.status, 403);
      assert.ok(refused.headers.get('content-type').startsWith('text/plain'));
      assert.ok(!cookies(refused).includes('operator_session_local_8787='));
      assert.equal(await count(), n, 'no new dev session');
    }
    const entered = await r.call('/auth/dev/enter?as=owner', { key: DEV_KEY });
    assert.equal(entered.status, 303);
    const ownerDev = cookies(entered);
    assert.equal((await r.call('/auth/session', { cookie: ownerDev })).status, 200);
    assert.equal((await r.call('/auth/dev/enter?as=owner', { cookie: ownerDev })).status, 303);
    assert.equal(await count(), n + 1, 'owner session reused');
    await r.db.prepare("INSERT INTO oa_operators(id,email,display_name,role,status,created_at) VALUES('backup','backup@example.com','Backup','owner','active',1)").run();
    await r.db.prepare("UPDATE oa_operators SET status='inactive' WHERE id='owner'").run();
    // The setup owner has left: `owner` is now the remaining active owner, named and signed in.
    assert.equal((await (await r.call('/__dev/personas', { key: DEV_KEY })).json()).find(persona => persona.as === 'owner').email, 'backup@example.com');
    const remaining = await r.call('/auth/dev/enter?as=owner', { key: DEV_KEY });
    assert.equal(remaining.status, 303);
    assert.equal((await (await r.call('/auth/session', { cookie: cookies(remaining) })).json()).operator.email, 'backup@example.com');
  } finally { await r.close(); }
});
