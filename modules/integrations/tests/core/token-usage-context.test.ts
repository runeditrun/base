import { runCases, type Case } from '../cases.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { TokenService } from '../../core/index.ts';
import type { TokenRequestContext } from '../../core/types.ts';
import { database } from './support.ts';
import { installIssuer, nativeAuthority, owner } from './token-authority-fixture.ts';

const context = (requestId: string, resource = 'tickets/42') => ({ requestId, resource });
test("token usage durably binds exact request and resource context under current authorization", async t => {
  const foldedCases: Case[] = [];
foldedCases.push(['allowed and denied usage binds caller request/resource across restart, scope changes, expiry and revocation', async (t) => {
  const store = await database(); let now = 1700000000000;
  try {
    await installIssuer(store.db);
    let tokens = new TokenService(store.repo(), nativeAuthority(store.db), () => now);
    const { token, credential } = await tokens.issue(owner, { name: 'app', scopes: ['read', 'read'], expiresAt: now + 1000 });
    assert.match(token, /^int_[a-f0-9]{64}$/); assert.deepEqual(credential.scopes, ['read']);
    await assert.rejects(tokens.issue(owner, { name: 'app', scopes: ['admin'] }), /rejected/);
    await assert.rejects(tokens.issue({ principal: 'visitor' }, { name: 'app', scopes: ['read'] }), /Forbidden/);
    assert.equal((await tokens.authorize(token, ['read'], context('allow')))!.id, credential.id);
    assert.equal(await tokens.authorize(token, ['write'], context('scope-denied', 'tickets/43')), null);
    assert.equal(await tokens.authorize('unknown', ['read'], context('unknown')), null);
    const otherTenant = new TokenService(store.repo('other'), nativeAuthority(store.db, 'other'), () => now);
    assert.equal(await otherTenant.authorize(token, ['read'], context('other')), null);
    const otherRows = await store.repo('other').query('SELECT * FROM integration_token_usage WHERE namespace=?');
    assert.equal(otherRows[0]!.token_id, null); assert.equal(otherRows[0]!.request_id, 'other');
    await runCases(t, Array.from([() => tokens.list({ principal: 'visitor' }), () => tokens.usage({ principal: 'visitor' }), () => tokens.revoke({ principal: 'visitor' }, credential.id)], (operation, rowIndex) => [`${t.name}: operation row ${rowIndex + 1}`, async t => {
await assert.rejects(operation(), /Forbidden/);
}]));
    store.restart(); tokens = new TokenService(store.repo(), nativeAuthority(store.db), () => now);
    assert.equal((await tokens.authorize(token, ['read'], context('restarted')))!.id, credential.id);
    await store.repo().query("UPDATE integration_tokens SET scopes='[]' WHERE namespace=? AND id=?", [credential.id]);
    assert.equal(await tokens.authorize(token, ['read'], context('scope-removed')), null);
    await tokens.revoke(owner, credential.id);
    assert.equal(await tokens.authorize(token, [], context('revoked')), null);
    const expiring = await tokens.issue(owner, { name: 'expiring', scopes: ['read'], expiresAt: now + 1 }); now++;
    assert.equal(await tokens.authorize(expiring.token, ['read'], context('expired')), null);
    const usage = await tokens.usage(owner), byRequest = new Map(usage.map(row => [row.requestId, row]));
    assert.equal(usage.length, 7);
    for (const request of ['allow', 'restarted']) assert.equal(byRequest.get(request)!.allowed, true);
    for (const request of ['scope-denied', 'unknown', 'scope-removed', 'revoked', 'expired']) assert.equal(byRequest.get(request)!.allowed, false);
    assert.equal(byRequest.get('unknown')!.tokenId, null);
    assert.equal(byRequest.get('scope-denied')!.resource, 'tickets/43');
    for (const row of usage.filter(row => row.requestId !== 'scope-denied')) assert.equal(row.resource, 'tickets/42');
    await store.repo().query('DELETE FROM integration_tokens WHERE namespace=?');
    assert.deepEqual(await tokens.usage(owner), usage, 'usage is retained after credential deletion');
    assert.equal((await readFile(store.path)).includes(Buffer.from(token)), false);
    assert.equal(JSON.stringify(usage).includes(token), false);
  } finally { await store.close(); }
}]);
foldedCases.push(['missing or unsafe request context rejects; valid context is snapshotted before hashing and never defaulted', async (t) => {
  const store = await database();
  try {
    await installIssuer(store.db);
    const tokens = new TokenService(store.repo(), nativeAuthority(store.db));
    const issued = await tokens.issue(owner, { name: 'app', scopes: ['read'] });
    await runCases(t, Array.from([undefined, null, {}, { requestId: 'r' }, { resource: 'tickets' }, context(''), context('a'.repeat(201)), context('bad\nrequest'), context('ok', 'tickets?token=secret'), context('ok', '/relative'), context('ok', '含义')], (invalid, rowIndex) => [`${t.name}: invalid row ${rowIndex + 1}`, async t => {
      await assert.rejects(tokens.authorize(issued.token, ['read'], invalid as TokenRequestContext), /Invalid/);
}]));
    assert.deepEqual(await tokens.usage(owner), []);
    const supplied = context('request-original', 'tickets/42'), pending = tokens.authorize(issued.token, ['read'], supplied);
    supplied.requestId = 'request-mutated'; supplied.resource = 'tickets/99'; await pending;
    const row = (await tokens.usage(owner))[0]!;
    assert.equal(row.requestId, 'request-original'); assert.equal(row.resource, 'tickets/42');
  } finally { await store.close(); }
}]);
foldedCases.push(['usage failure denies visibly with no partial receipt; concurrent issuance retains random hash-only credentials', async () => {
  const store = await database();
  try {
    await installIssuer(store.db);
    const tokens = new TokenService(store.repo(), nativeAuthority(store.db));
    const issued = await Promise.all(Array.from({ length: 100 }, (_, i) => tokens.issue(owner, { name: `app-${i}`, scopes: ['read'] })));
    assert.equal(new Set(issued.map(i => i.token)).size, 100);
    const rows = await store.repo().query('SELECT * FROM integration_tokens WHERE namespace=?');
    assert.equal(rows.length, 100);
    for (const row of rows) assert.match(String(row.token_hash), /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(await tokens.list(owner)).includes('token_hash'), false);
    store.db.migrate("CREATE TRIGGER fail_usage_v2 BEFORE INSERT ON integration_token_usage BEGIN SELECT RAISE(ABORT,'usage unavailable'); END;");
    await assert.rejects(tokens.authorize(issued[0]!.token, ['read'], context('failed-allowed')), /usage unavailable/);
    await assert.rejects(tokens.authorize('invalid', ['read'], context('failed-denied')), /usage unavailable/);
    assert.deepEqual(await tokens.usage(owner), []);
  } finally { await store.close(); }
}]);
foldedCases.push(['usage-context expansion preserves pre-v2 receipts without inventing request provenance', async () => {
  const store = await database();
  try {
    await installIssuer(store.db);
    store.db.migrate(`DROP TABLE integration_token_usage;
      CREATE TABLE integration_token_usage(namespace TEXT NOT NULL,id TEXT NOT NULL,token_id TEXT,at INTEGER NOT NULL,required_scopes TEXT NOT NULL,allowed INTEGER NOT NULL,PRIMARY KEY(namespace,id));
      INSERT INTO integration_token_usage VALUES('tenant','old',NULL,1,'["read"]',0);`);
    store.db.migrate(await readFile(new URL('../../core/upgrade-token-usage-context.sql', import.meta.url), 'utf8'));
    const tokens = new TokenService(store.repo(), nativeAuthority(store.db));
    const historical = (await tokens.usage(owner))[0]!;
    assert.equal(historical.id, 'old'); assert.equal(historical.requestId, null); assert.equal(historical.resource, null);
    await tokens.authorize('invalid', ['read'], context('new-after-upgrade'));
    const current = (await tokens.usage(owner))[1]!;
    assert.equal(current.requestId, 'new-after-upgrade'); assert.equal(current.resource, 'tickets/42');
  } finally { await store.close(); }
}]);
  await runCases(t, foldedCases);
});
