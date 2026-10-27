import { runCases } from '../cases.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { TokenService } from '../../index.ts';
import type { TokenAuthority, TokenGrant } from '../../index.ts';
import { store } from './support.ts';

test('public tokens: native SQL grant ceiling, commit-time authority, current revocation and durable usage', async t => {
  await runCases(t, [['independent input groups', async t => {
  const db = await store(t);
  db.sql.migrate(`CREATE TABLE native_issuers(namespace TEXT, id TEXT, revision INTEGER, active INTEGER, scopes TEXT, PRIMARY KEY(namespace,id));
    INSERT INTO native_issuers VALUES('installation','operator-1',1,1,'["incidents:read","incidents:write"]');`);
  // Test session identity stands in for the consumer's authenticated server context.
  const session = Object.freeze({ principal: 'operator-1' });
  let invalidateBeforeCommit = false;
  const authority: TokenAuthority<typeof session> = {
    async grant(context): Promise<TokenGrant> {
      if (context !== session) throw new Error('Unauthenticated context');
      const [rows] = await db.sql.batch([{ sql: 'SELECT * FROM native_issuers WHERE namespace=? AND id=? AND active=1', params: ['installation', context.principal] }]);
      const row = rows![0]; if (!row) throw new Error('Authority denied');
      const grant = { scopes: JSON.parse(String(row.scopes)) as string[], commitGuard: {
        sql: 'SELECT 1 FROM native_issuers WHERE namespace=? AND id=? AND revision=? AND active=1',
        params: ['installation', context.principal, Number(row.revision)],
      } };
      if (invalidateBeforeCommit) await db.sql.batch([{ sql: 'UPDATE native_issuers SET revision=revision+1,active=0 WHERE namespace=? AND id=?', params: ['installation', context.principal] }]);
      return grant;
    },
    async administer(context) {
      if (context !== session) throw new Error('Unauthenticated context');
      const [rows] = await db.sql.batch([{ sql: 'SELECT 1 FROM native_issuers WHERE namespace=? AND id=? AND active=1', params: ['installation', context.principal] }]);
      if (!rows!.length) throw new Error('Authority denied');
    },
  };
  const tokens = () => new TokenService(db.repo(), authority);
  await runCases(t, [
    ["issuance refusal inputs: case 1", async t => {
      await assert.rejects(tokens().issue({ principal: 'operator-1' }, { name: 'Forged context', scopes: [] }), /Unauthenticated/);
    }],
    ["issuance refusal inputs: case 2", async t => {
      await assert.rejects(tokens().issue(session, { name: 'Too broad', scopes: ['admin'] }), /grant rejected/);
    }]
  ]);
  const issued = await tokens().issue(session, { name: 'Reader', scopes: ['incidents:read'] });
  assert.match(issued.token, /^int_[a-f0-9]{64}$/);
  const rows = await db.repo().query('SELECT token_hash FROM integration_tokens WHERE namespace=?');
  assert.match(String(rows[0]?.token_hash), /^[a-f0-9]{64}$/); assert.notEqual(rows[0]?.token_hash, issued.token);
  assert.equal((await db.contents()).includes(issued.token), false);
  db.restart();
  assert.equal((await tokens().authorize(issued.token, ['incidents:read'], { requestId: 'request-1', resource: 'incidents/42' }))?.id, issued.credential.id);
  assert.equal(await tokens().authorize(issued.token, ['incidents:write'], { requestId: 'request-2', resource: 'incidents/42' }), null);
  assert.equal(await new TokenService(db.repo('other'), authority).authorize(issued.token, [], { requestId: 'request-3', resource: 'incidents/42' }), null);
  invalidateBeforeCommit = true;
  await assert.rejects(tokens().issue(session, { name: 'Stale authority', scopes: ['incidents:read'] }), /authority changed/);
  assert.equal((await db.repo().query('SELECT id FROM integration_tokens WHERE namespace=?')).length, 1);
  assert.equal((await db.repo().query("SELECT id FROM integration_token_events WHERE namespace=? AND action='issued'")).length, 1);
  await assert.rejects(tokens().revoke(session, issued.credential.id), /Authority denied/);
  await db.sql.batch([{ sql: 'UPDATE native_issuers SET revision=revision+1,active=1' }]);
  invalidateBeforeCommit = false;
  await tokens().revoke(session, issued.credential.id); db.restart();
  assert.equal(await tokens().authorize(issued.token, ['incidents:read'], { requestId: 'request-4', resource: 'incidents/42' }), null);
  assert.equal(await tokens().authorize('unknown-token', [], { requestId: 'request-5', resource: 'incidents/42' }), null);
  const usage = await tokens().usage(session);
  assert.deepEqual(usage.map(u => [u.requestId, u.allowed]).sort(), [['request-1', true], ['request-2', false], ['request-4', false], ['request-5', false]]);
  assert.equal(usage.find(u => u.requestId === 'request-5')?.tokenId, null);
  assert.ok((await tokens().list(session))[0]?.revokedAt);
  assert.equal(JSON.stringify(await tokens().list(session)).includes('token_hash'), false);
  const events = await db.repo().query('SELECT action FROM integration_token_events WHERE namespace=? ORDER BY action');
  assert.deepEqual(events.map(e => e.action), ['issued', 'revoked']);
  await db.repo().query('DELETE FROM integration_tokens WHERE namespace=?');
  assert.equal((await tokens().usage(session)).length, 4);
  assert.equal((await db.repo().query('SELECT id FROM integration_token_events WHERE namespace=?')).length, 2);

  }]]);
});
