import { runCases, type Case } from '../cases.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { TokenService } from '../../core/index.ts';
import { database } from './support.ts';
import { installIssuer, nativeAuthority } from './token-authority-fixture.ts';
const owner = { principal: 'owner' }, denied = { principal: 'visitor' };
test("token credentials reveal once and enforce current scope, expiry, revocation and usage evidence", async t => {
  const foldedCases: Case[] = [];
foldedCases.push(['tokens reveal once, hash-only persistence, live scopes/expiry/revocation and durable usage across restart', async (t) => {
  const store = await database(); let now = 1700000000000;
  try {
    await installIssuer(store.db);
    const authority = nativeAuthority({ batch: statements => store.db.batch(statements) });
    let tokens = new TokenService(store.repo(), authority, () => now);
    await runCases(t, [
    ["issuance refusal inputs: case 1", async t => {
      await assert.rejects(tokens.issue(denied, { name: 'app', scopes: ['read'] }), /Forbidden/);
    }],
    ["issuance refusal inputs: case 2", async t => {
      await assert.rejects(tokens.issue(owner, { name: 'app', scopes: ['admin'] }), /rejected/);
    }]
  ]);
    const { token, credential } = await tokens.issue(owner, { name: 'app', scopes: ['read', 'read'], expiresAt: now + 1000 });
    assert.match(token, /^int_[a-f0-9]{64}$/); assert.deepEqual(credential.scopes, ['read']);
    await runCases(t, [
    ["authorization contexts: case 1", async t => {
      assert.equal((await tokens.authorize(token, ['read'], { requestId: 'token-test-1', resource: 'integration-test/resource' }))!.id, credential.id);
    }],
    ["authorization contexts: case 2", async t => {
      assert.equal(await tokens.authorize(token, ['write'], { requestId: 'token-test-2', resource: 'integration-test/resource' }), null);
    }],
    ["authorization contexts: case 3", async t => {
      assert.equal(await tokens.authorize('invalid', ['read'], { requestId: 'token-test-3', resource: 'integration-test/resource' }), null);
    }]
  ]);
    await runCases(t, [
    ["administration refusals: case 1", async t => {
      await assert.rejects(tokens.list(denied));
    }],
    ["administration refusals: case 2", async t => {
      await assert.rejects(tokens.usage(denied));
    }],
    ["administration refusals: case 3", async t => {
      await assert.rejects(tokens.revoke(denied, credential.id));
    }]
  ]);
    await runCases(t, [['authorization contexts: tenant boundary', async t => {
    const otherTenant = new TokenService(store.repo('other'), authority, () => now);
    assert.equal(await otherTenant.authorize(token, ['read'], { requestId: 'token-test-4', resource: 'integration-test/resource' }), null);
    }]]);
    assert.equal((await tokens.usage(owner)).length, 3);
    store.restart(); tokens = new TokenService(store.repo(), authority, () => now);
    assert.equal((await tokens.authorize(token, ['read'], { requestId: 'token-test-5', resource: 'integration-test/resource' }))!.id, credential.id);
    // Actual policy persistence changes are observed on the next use, never cached.
    await store.repo().query("UPDATE integration_tokens SET scopes='[]' WHERE namespace=? AND id=?", [credential.id]);
    assert.equal(await tokens.authorize(token, ['read'], { requestId: 'token-test-6', resource: 'integration-test/resource' }), null);
    await tokens.revoke(owner, credential.id);
    assert.equal(await tokens.authorize(token, [], { requestId: 'token-test-7', resource: 'integration-test/resource' }), null);
    assert.equal((await tokens.list(owner))[0]!.revokedAt, now);
    const expiring = await tokens.issue(owner, { name: 'expiring', scopes: ['read'], expiresAt: now + 1 }); now++;
    assert.equal(await tokens.authorize(expiring.token, ['read'], { requestId: 'token-test-8', resource: 'integration-test/resource' }), null);
    const rows = await store.repo().query('SELECT * FROM integration_tokens WHERE namespace=?');
    assert.match(String(rows[0]!.token_hash), /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(rows).includes(token), false);
    const listing = JSON.stringify(await tokens.list(owner)); assert.equal(listing.includes('token_hash'), false); assert.equal(listing.includes(token), false);
    assert.equal((await tokens.usage(owner)).length, 7);
    assert.equal((await readFile(store.path)).includes(Buffer.from(token)), false);
  } finally { await store.close(); }
}]);
foldedCases.push(['usage write failure denies authorization visibly; 100 concurrent tokens are distinct', async () => {
  const store = await database();
  try {
    await installIssuer(store.db);
    const authority = nativeAuthority({ batch: statements => store.db.batch(statements) });
    const tokens = new TokenService(store.repo(), authority);
    const issued = await Promise.all(Array.from({ length: 100 }, (_, i) => tokens.issue(owner, { name: `app-${i}`, scopes: ['read'] })));
    assert.equal(new Set(issued.map(i => i.token)).size, 100);
    store.db.migrate("CREATE TRIGGER fail_usage BEFORE INSERT ON integration_token_usage BEGIN SELECT RAISE(ABORT,'usage unavailable'); END;");
    await assert.rejects(tokens.authorize(issued[0]!.token, ['read'], { requestId: 'token-test-9', resource: 'integration-test/resource' }), /usage unavailable/);
    assert.equal((await tokens.usage(owner)).length, 0);
  } finally { await store.close(); }
}]);
  await runCases(t, foldedCases);
});
