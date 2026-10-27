import { installD1Preflight } from '../../../container/adapters/d1-workerd-setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { D1SqlDatabase, IntegrationsRepository, TokenService } from '../../core/index.ts';
import type { SqlStatement } from '../../core/database.ts';
import { installIssuer, nativeAuthority, owner } from './token-authority-fixture.ts';

// Resolve an already installed Miniflare, optionally through a shared dependency cache.
// A missing dependency is an error, never a skipped check or fake D1 implementation.
const miniflare = await import(process.env.INTEGRATIONS_MINIFLARE_MODULE ?? 'miniflare');
installD1Preflight(miniflare.D1_PLUGIN);
const { Miniflare } = miniflare;

test('actual local D1 fixed batches bind grants and usage, roll back audit failures and persist after restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'integrations-d1-'));
  const options = {
    host: '127.0.0.1', port: 0, cf: false, telemetry: { enabled: false },
    resourcePersistencePath: dir,
    workers: [{ config: {
      name: 'integrations-test', type: 'worker', compatibilityDate: '2026-09-01',
      manifest: { mainModule: 'worker.js', modules: { 'worker.js': { type: 'esm', contents: 'export default {fetch() {return new Response("local test");}}' } } },
      env: { DB: { type: 'd1', id: 'integrations' } },
    } }],
  };
  let runtime = new Miniflare(options);
  try {
    let binding = await runtime.getD1Database('DB');
    const schema = await readFile(new URL('../../core/schema.sql', import.meta.url), 'utf8');
    await binding.batch(schema.split(';').filter(sql => sql.trim()).map(sql => binding.prepare(sql)));
    let sql = new D1SqlDatabase(binding);
    await installIssuer(sql);
    const reached = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
    const held = { async batch(statements: SqlStatement[]) {
      if (statements[0]?.sql.startsWith('INSERT INTO integration_tokens(')) { reached.resolve(); await resume.promise; }
      return sql.batch(statements);
    } };
    let tokens = new TokenService(new IntegrationsRepository(held, 'tenant'), nativeAuthority(sql));
    const rejected = assert.rejects(tokens.issue(owner, { name: 'stale', scopes: ['read'] }), /authority changed/);
    await reached.promise;
    const secondBinding = await runtime.getD1Database('DB');
    await secondBinding.prepare("UPDATE issuers SET active=0,revision=revision+1 WHERE namespace='tenant'").run();
    resume.resolve(); await rejected;
    let repo = new IntegrationsRepository(sql, 'tenant');
    assert.equal((await repo.query('SELECT * FROM integration_tokens WHERE namespace=?')).length, 0);
    assert.equal((await repo.query('SELECT * FROM integration_token_events WHERE namespace=?')).length, 0);
    await sql.batch([{ sql: "UPDATE issuers SET active=1,revision=revision+1 WHERE namespace='tenant'" }]);
    tokens = new TokenService(repo, nativeAuthority(sql));
    await binding.prepare("CREATE TRIGGER fail_audit BEFORE INSERT ON integration_token_events BEGIN SELECT RAISE(ABORT,'audit unavailable'); END").run();
    await assert.rejects(tokens.issue(owner, { name: 'failed', scopes: ['read'] }), /audit unavailable/);
    assert.equal((await tokens.list(owner)).length, 0);
    await binding.prepare('DROP TRIGGER fail_audit').run();
    const issued = await tokens.issue(owner, { name: 'app', scopes: ['read'] });
    assert.equal((await tokens.authorize(issued.token, ['read'], { requestId: 'd1-allowed', resource: 'tickets/123' }))!.id, issued.credential.id);
    assert.equal(await tokens.authorize(issued.token, ['write'], { requestId: 'd1-scope-denied', resource: 'tickets/456' }), null);
    assert.equal(await tokens.authorize('invalid', ['read'], { requestId: 'd1-unknown', resource: 'tickets/789' }), null);
    await binding.prepare("CREATE TRIGGER fail_usage BEFORE INSERT ON integration_token_usage BEGIN SELECT RAISE(ABORT,'usage unavailable'); END").run();
    await assert.rejects(tokens.authorize(issued.token, ['read'], { requestId: 'd1-no-receipt', resource: 'tickets/123' }), /usage unavailable/);
    await binding.prepare('DROP TRIGGER fail_usage').run();
    assert.equal((await tokens.usage(owner)).length, 3);
    await runtime.dispose(); runtime = new Miniflare(options);
    binding = await runtime.getD1Database('DB'); sql = new D1SqlDatabase(binding); repo = new IntegrationsRepository(sql, 'tenant');
    tokens = new TokenService(repo, nativeAuthority(sql));
    const usage = await tokens.usage(owner);
    assert.equal(usage.length, 3);
    assert.deepEqual(usage.map(row => [row.requestId, row.resource, row.allowed]), [
      ['d1-allowed', 'tickets/123', true], ['d1-scope-denied', 'tickets/456', false], ['d1-unknown', 'tickets/789', false],
    ]);
    assert.equal(usage[2]!.tokenId, null);
    await tokens.revoke(owner, issued.credential.id);
    assert.equal(await tokens.authorize(issued.token, [], { requestId: 'd1-revoked', resource: 'tickets/123' }), null);
    await repo.query('DELETE FROM integration_tokens WHERE namespace=?');
    assert.equal((await tokens.usage(owner)).length, 4);
    assert.equal((await repo.query('SELECT * FROM integration_token_events WHERE namespace=?')).length, 2);
  } finally { await runtime.dispose(); await rm(dir, { recursive: true, force: true }); }
});
