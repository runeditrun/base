import { runCases, type Case } from '../cases.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { IntegrationsRepository, TokenService } from '../../core/index.ts';
import type { SqlDatabase, SqlStatement } from '../../core/database.ts';
import type { TokenAuthority } from '../../core/types.ts';
import { SqliteDatabase } from '../../core/sqlite.ts';
import { database } from './support.ts';
import { installIssuer, nativeAuthority, owner } from './token-authority-fixture.ts';

// Hold the unchanged issuance batch immediately before the actual database transaction,
// allowing another real connection to commit a native authority change first.
function pausedInsert(db: SqlDatabase) {
  const reached = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
  const batches: SqlStatement[][] = [];
  return {
    reached: reached.promise, resume: () => resume.resolve(), batches,
    sql: { async batch(statements: SqlStatement[]) {
      if (statements[0]?.sql.startsWith('INSERT INTO integration_tokens(')) {
        batches.push(statements); reached.resolve(); await resume.promise;
      }
      return db.batch(statements);
    } } satisfies SqlDatabase,
  };
}

test("token issuance commits only current native grants and atomic audit evidence", async t => {
  const foldedCases: Case[] = [];
for (const change of [
  { name: 'issuer removal', sql: 'UPDATE issuers SET active=0,revision=revision+1 WHERE namespace=? AND id=?' },
  { name: 'grant ceiling reduction', sql: `UPDATE issuers SET scopes='[]',revision=revision+1 WHERE namespace=? AND id=?` },
  { name: 'issuer deletion', sql: 'DELETE FROM issuers WHERE namespace=? AND id=?' },
]) foldedCases.push([`issuance observes ${change.name} committed on another connection before its SQL transaction`, async () => {
  const store = await database(), second = new SqliteDatabase(store.path);
  const paused = pausedInsert(store.db);
  try {
    await installIssuer(store.db);
    const tokens = new TokenService(new IntegrationsRepository(paused.sql, 'tenant'), nativeAuthority(store.db));
    const issue = tokens.issue(owner, { name: 'app', scopes: ['read'] });
    const rejected = assert.rejects(issue, /authority changed/);
    await paused.reached;
    await second.batch([{ sql: change.sql, params: ['tenant', 'owner'] }]);
    paused.resume(); await rejected;
    assert.equal(paused.batches.length, 1);
    assert.equal(paused.batches[0]!.length, 2, 'fixed statement count, no conditional JS transaction continuation');
    assert.equal((await store.repo().query('SELECT * FROM integration_tokens WHERE namespace=?')).length, 0);
    assert.equal((await store.repo().query('SELECT * FROM integration_token_events WHERE namespace=?')).length, 0);
  } finally { paused.resume(); second.close(); await store.close(); }
}]);
foldedCases.push(['unchanged native grant issues atomically; audit failure rolls back token; audit survives credential deletion', async () => {
  const store = await database();
  try {
    await installIssuer(store.db);
    const tokens = new TokenService(store.repo(), nativeAuthority(store.db));
    store.db.migrate("CREATE TRIGGER fail_token_audit BEFORE INSERT ON integration_token_events BEGIN SELECT RAISE(ABORT,'audit unavailable'); END;");
    await assert.rejects(tokens.issue(owner, { name: 'app', scopes: ['read'] }), /audit unavailable/);
    assert.equal((await tokens.list(owner)).length, 0);
    store.db.migrate('DROP TRIGGER fail_token_audit');
    const issued = await tokens.issue(owner, { name: 'app', scopes: ['read'] });
    assert.equal((await tokens.list(owner))[0]!.id, issued.credential.id);
    const events = await store.repo().query('SELECT * FROM integration_token_events WHERE namespace=?');
    assert.equal(events.length, 1); assert.equal(events[0]!.action, 'issued');
    await tokens.revoke(owner, issued.credential.id);
    await store.repo().query('DELETE FROM integration_tokens WHERE namespace=?');
    assert.equal((await store.repo().query('SELECT * FROM integration_token_events WHERE namespace=?')).length, 2);
  } finally { await store.close(); }
}]);
foldedCases.push(['no legacy or absent commit guard can issue a token', async () => {
  const store = await database();
  try {
    for (const grant of [['read'], { scopes: ['read'] }, { scopes: ['read'], commitGuard: { sql: '', params: [] } }]) {
      const authority = { grant: async () => grant, administer: async () => {} } as unknown as TokenAuthority<unknown>;
      await assert.rejects(new TokenService(store.repo(), authority).issue(owner, { name: 'app', scopes: ['read'] }), /commit guard required/);
    }
    assert.equal((await store.repo().query('SELECT * FROM integration_tokens WHERE namespace=?')).length, 0);
    assert.equal((await store.repo().query('SELECT * FROM integration_token_events WHERE namespace=?')).length, 0);
  } finally { await store.close(); }
}]);
  await runCases(t, foldedCases);
});
