import { runCases } from './cases.mjs';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { runtime, SETUP, SECRET } from './runtime.mjs';
const post = (input, cookie, extra = {}) => ({ method: 'POST', input, cookie, ...extra });

test("auth HTTP issuance refuses untrusted or over-budget requests before writes and mail", async t => {
  const foldedCases = [];
foldedCases.push(['HTTP mutations reject host/origin/method failures without data writes, and input failures stay redacted', async (t) => {
  const r = await runtime();
  try {
    const setup = { token: SETUP, displayName: 'Owner' };
    assert.equal((await r.call('/auth/bootstrap', post(setup, undefined, { host: 'evil.test' }))).status, 403);
    assert.equal((await r.call('/auth/bootstrap', post(setup, undefined, { origin: 'https://evil.test' }))).status, 403);
    assert.equal((await r.call('/auth/bootstrap', post(setup, undefined, { headers: { 'Sec-Fetch-Site': 'cross-site' } }))).status, 403);
    assert.equal((await r.call('/auth/bootstrap')).status, 405);
    assert.equal((await r.call('/auth/bootstrap', { method: 'HEAD' })).status, 405);
    const db = await r.db;
    assert.equal((await db.prepare('SELECT count(*) AS n FROM oa_operators').first()).n, 0);
    const oversized = await r.call('/auth/bootstrap', post({ ...setup, junk: 'x'.repeat(9000) }));
    assert.equal(oversized.status, 413);
    assert.equal((await r.call('/auth/bootstrap', post({ ...setup, displayName: '' }))).status, 400);
    const owner = await r.bootstrap();
    await runCases(t, Array.from(['https://evil.test', '//evil.test', '/%2fevil.test', '/%5cevil.test'], (returnTo, rowIndex) => [`${t.name}: returnTo row ${rowIndex + 1}`, async t => {
      await r.call('/auth/magic-link', post({ email: 'owner@example.com', returnTo }));
      const token = (await r.link()).searchParams.get('token');
      const res = await r.call('/auth/confirm', post({ token, returnTo: 'https://evil.test' }));
      assert.equal(res.status, 303); assert.equal(res.headers.get('location'), '/app');
}]));
    assert.equal((await r.call('/auth/absent', { cookie: owner })).status, 404);
    const invalid = await r.call('/auth/magic-link', post({ email: 'bad\r\nbcc:other@example.com' }));
    assert.equal(invalid.status, 400); assert.deepEqual(await invalid.json(), { error: 'invalid_email' });
  } finally { await r.close(); }
}]);
foldedCases.push(['invitation rate limits precede mail side effects and reinvitation invalidates older links', async () => {
  const r = await runtime({ emailLimit: 2 }, { now: Date.now() });
  try {
    const owner = await r.bootstrap();
    const input = { email: 'staff@example.com', displayName: 'Staff' };
    for (let i = 0; i < 2; i++) assert.equal((await r.call('/auth/invite', post(input, owner))).status, 202);
    assert.equal((await r.call('/auth/invite', post(input, owner))).status, 429);
    assert.equal((await r.mails()).length, 2);
    assert.equal((await (await r.db).prepare('SELECT count(*) AS n FROM oa_tokens WHERE revoked_at IS NULL').first()).n, 1);
  } finally { await r.close(); }
}]);
  await runCases(t, foldedCases);
});



test('the development CLI sign-in proof never spends a person\'s sign-in budget, and only a local server honours it', async t => {

  const proof = createHmac('sha256', SECRET).update('local-cli\0sign-in').digest('hex');
  const cli = { 'x-rer-local-cli': proof };
  const owner = { email: 'owner@example.com' };
  const now = Date.now();
  await runCases(t, [
['local development proof budget', async t => { // Every request in this budget proof uses one rate window.
  const local = await runtime({ origin: 'http://127.0.0.1:8787', local: true, emailLimit: 2, ipLimit: 3 }, { now });
  try {
    for (let i = 0; i < 6; i++) assert.equal((await local.call('/auth/magic-link', post(owner, undefined, { headers: cli }))).status, 202);
    assert.equal((await local.call('/auth/magic-link', post(owner, undefined, { headers: { 'x-rer-local-cli': 'f'.repeat(64) } }))).status, 202);
    assert.equal((await local.call('/auth/magic-link', post(owner))).status, 202);
    assert.equal((await local.call('/auth/magic-link', post(owner))).status, 429);
  } finally { await local.close(); }
}],
['hosted server ignores development proof', async t => {
  const production = await runtime({ emailLimit: 2 }, { now });
  try {
    for (let i = 0; i < 2; i++) assert.equal((await production.call('/auth/magic-link', post(owner, undefined, { headers: cli }))).status, 202);
    assert.equal((await production.call('/auth/magic-link', post(owner, undefined, { headers: cli }))).status, 429);
  } finally { await production.close(); }
}]
  ]);
});
