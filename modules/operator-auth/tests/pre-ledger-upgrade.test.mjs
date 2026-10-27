import { runCases } from './cases.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runtime, post } from './pre-ledger-runtime.mjs';
import { credentials, oldCookie, SETUP, NOW } from './fixtures/pre-ledger/owner-state.mjs';
import { oldTables, snapshot, authoritySnapshot, operator, owner, invite, error, session, deniedLink, conflict, accept } from './pre-ledger-assertions.mjs';

test('static populated pre-ledger store upgrades without rewriting any old table and retains usable authority', async (t) => {
  await runCases(t, [['independent input groups', async t => {
  await runCases(t, [['independent journey rows', async t => {
  const r = await runtime();
  try {
    const db = await r.db;
    const tables = (await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'oa_%' ORDER BY name").all()).results.map(row => row.name);
    assert.deepEqual(tables, oldTables, 'Cover every old core and optional OIDC table');
    const before = await snapshot(r);
    await runCases(t, Array.from(oldTables, (table, rowIndex) => [`${t.name}: prior row table row ${rowIndex + 1}`, async t => {
assert.ok(before[table].length, `${table} has preservation evidence`);
}]));
    assert.deepEqual(before.oa_operators.map(row => [row.id, row.status, row.version]), [
      ['active', 'active', 2], ['cancelled', 'inactive', 2], ['expired', 'invited', 1],
      ['guarded', 'invited', 1], ['inactive', 'inactive', 3], ['owner', 'active', 1], ['pending', 'invited', 1],
    ]);
    await runCases(t, Array.from(['active', 'inactive'], (name, rowIndex) => [`${t.name}: name row ${rowIndex + 1}`, async t => {
      const token = before.oa_tokens.find(row => row.operator_id === name);
      const persisted = before.oa_sessions.find(row => row.operator_id === name);
      assert.equal(token.operator_version, 1);
      assert.ok(token.consumed_at < NOW);
      assert.equal(persisted.source_token_id, token.id);
      assert.equal(persisted.operator_version, 2);
}]));
    assert.equal(before.oa_tokens.find(row => row.operator_id === 'cancelled').consumed_at, null);
    const migration = await r.migrate();
    assert.ok(migration.statementCount > 0, 'The shipped migration contains statements');
    assert.equal(migration.appliedStatements, migration.statementCount, 'The entire shipped migration was applied');
    assert.deepEqual(await snapshot(r), before);
    assert.deepEqual((await (await r.db).prepare('SELECT * FROM oa_invitation_cancellations').all()).results, [], 'No inferred cancellation markers');
    await r.restart();
    assert.deepEqual(await snapshot(r), before, 'Every old row persists across runtime restart');
    assert.deepEqual((await (await r.db).prepare('SELECT * FROM oa_invitation_cancellations').all()).results, []);
    await runCases(t, [
    ["upgraded session inputs: case 1", async t => {
      await session(r, owner, 'owner', 1);
    }],
    ["upgraded session inputs: case 2", async t => {
      await session(r, oldCookie('active'), 'active', 2);
    }],
    ["upgraded session inputs: case 3", async t => {
      await error(await r.call('/auth/session', { cookie: oldCookie('inactive') }), 401, 'unauthenticated');
    }]
  ]);
    const authBefore = await authoritySnapshot(r);
    await error(await r.call('/auth/bootstrap', post({ token: SETUP, displayName: 'Replacement owner' })), 409, 'already_initialized');
    assert.deepEqual(await authoritySnapshot(r), authBefore);
    await runCases(t, Array.from(['active', 'inactive', 'cancelled'], (name, rowIndex) => [`legacy identity row ${rowIndex + 1}`, async t => {

      await conflict(r, name);
      await deniedLink(t, r, credentials[`${name}Link`]);

}]));
    const accepted = [];
    await runCases(t, Array.from(['pending', 'expired'], (name, rowIndex) => [`${t.name}: name row ${rowIndex + 1}`, async t => {
      const old = await operator(r, name);
      const returnTo = before.oa_tokens.find(row => row.operator_id === name).return_to;
      if (name === 'expired') await deniedLink(t, r, credentials.expiredLink);
      else assert.equal((await r.call(`/auth/confirm?token=${credentials.pendingLink}`)).status, 200);
      await conflict(r, name, 'admin');
      assert.equal((await invite(r, name, 'member', returnTo)).status, 202);
      const reissued = await operator(r, name);
      assert.deepEqual(reissued, old, 'Pending resend retains the complete identity including id and created_at');
      await deniedLink(t, r, credentials[`${name}Link`]);
      const token = await r.latestLink();
      accepted.push([name, await accept(t, r, token, name, 2, returnTo)]);
}]));
    await r.restart();
    await runCases(t, Array.from(accepted, ([name, cookie], rowIndex) => [`accepted session row ${rowIndex + 1}`, async t => {

      await session(r, cookie, name, 2);
      await deniedLink(t, r, credentials[`${name}Link`]);

}]));
    await runCases(t, [
    ["restarted session inputs: case 1", async t => {
      await session(r, owner, 'owner', 1);
    }],
    ["restarted session inputs: case 2", async t => {
      await session(r, oldCookie('active'), 'active', 2);
    }],
    ["restarted session inputs: case 3", async t => {
      await error(await r.call('/auth/session', { cookie: oldCookie('inactive') }), 401, 'unauthenticated');
    }]
  ]);
    assert.deepEqual((await snapshot(r)).oa_bootstrap, before.oa_bootstrap);
  } finally { await r.close(); }

  }]]);

  }]]);
});
