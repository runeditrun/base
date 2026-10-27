import { runCases } from '../helpers/cases.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { createRuntime, ingest } from '../messaging/runtime.mjs';
import { source, event, signedEvents, NOW } from '../messaging/fixtures.mjs';

async function counts(db) {
  return { receipts: (await db.prepare('SELECT count(*) AS n FROM rer_mail_event_receipts').first()).n,
    states: (await db.prepare('SELECT count(*) AS n FROM rer_mail_event_states').first()).n };
}
async function states(db, tenant = 'tenant', namespace = 'events') {
  return (await db.prepare('SELECT recipient, status, event_id FROM rer_mail_event_states WHERE tenant_id = ? AND event_namespace = ? ORDER BY recipient').bind(tenant, namespace).all()).results;
}

test('signed public intake uses real atomic D1 for races, isolation, full rollback and restart', { timeout: 60000 }, async t => {
  await runCases(t, [['atomic mail intake journey', async t => {
  const path = await mkdtemp(join(tmpdir(), 'messaging-d1-'));
  let runtime;
  try {
    runtime = await createRuntime(path, source(), NOW);
    let db = await runtime.getD1Database('DB');
    const schema = await readFile(new URL('../../src/events/d1-schema.sql', import.meta.url), 'utf8');
    const install = () => db.batch(schema.split(';').filter(sql => sql.trim()).map(sql => db.prepare(sql)));
    await install(); await install(); // additive setup is repeatable
    const token = signedEvents([event()]);
    const raced = await Promise.all(Array.from({ length: 6 }, () => ingest(runtime, token)));
    assert.deepEqual(raced.map(response => response.result[0].outcome).sort(), ['duplicate', 'duplicate', 'duplicate', 'duplicate', 'duplicate', 'stored']);
    assert.deepEqual(await counts(db), { receipts: 1, states: 1 });
    // One signed event ID cannot identify two facts, including under races.
    const raceId = 'conflicting-race';
    const conflicts = await Promise.all([
      ingest(runtime, signedEvents([event(raceId, { type: 'bounced', detail: { bounce: 'hard' } })])),
      ingest(runtime, signedEvents([event(raceId, { type: 'complained' })])),
    ]);
    assert.equal(conflicts.filter(response => response.status === 200).length, 1);
    assert.equal(conflicts.filter(response => response.code === 'event_identity_conflict').length, 1);
    const beforeConflict = await counts(db), beforeStates = await states(db);
    const rollback = await ingest(runtime, signedEvents([event('new-before-conflict', { messageId: 'new-message' }), event('event-1', { type: 'failed' })]));
    assert.equal(rollback.code, 'event_identity_conflict');
    assert.deepEqual(await counts(db), beforeConflict); assert.deepEqual(await states(db), beforeStates);
    // A real SQL error after receipt insertion must roll back receipt AND state.
    await db.prepare("CREATE TRIGGER force_mail_failure BEFORE INSERT ON rer_mail_event_states WHEN NEW.provider_message_id = 'force-failure' BEGIN SELECT RAISE(ABORT, 'SENSITIVE provider recipient'); END").run();
    const failed = await ingest(runtime, signedEvents([event('new-before-sql-error', { messageId: 'new-message' }), event('sql-error', { messageId: 'force-failure' })]));
    assert.equal(failed.code, 'event_storage_failed'); assert.doesNotMatch(JSON.stringify(failed), /SENSITIVE|provider recipient/);
    assert.deepEqual(await counts(db), beforeConflict); assert.deepEqual(await states(db), beforeStates);
    await db.prepare('DROP TRIGGER force_mail_failure').run();
    assert.equal((await ingest(runtime, signedEvents([event('new-before-sql-error', { messageId: 'new-message' })]))).result[0].outcome, 'stored');
    // Rebatched/resigned events preserve identity independent of envelope clock/order.
    const reordered = Object.fromEntries(Object.entries(event()).reverse());
    assert.equal((await ingest(runtime, signedEvents([reordered], { claims: { iat: NOW / 1000 + 1 } }))).result[0].outcome, 'duplicate');
    const twice = await ingest(runtime, signedEvents([event('twice'), event('twice')]));
    assert.deepEqual(twice.result.map(item => item.outcome), ['stored', 'duplicate']);
    const suppression = await ingest(runtime, signedEvents([event('suppression', { messageId: 'suppressed-message', type: 'suppressed', detail: { suppression: 'provider', code: 'list_block' } })]));
    assert.equal(suppression.result[0].recipients[0].state.status, 'rejected');
    const stored = JSON.parse((await db.prepare('SELECT event_json FROM rer_mail_event_receipts WHERE event_id = ?').bind('suppression').first()).event_json);
    assert.equal(stored.providerMessageId, 'suppressed-message'); assert.equal(stored.deliveryId, 'command-1');
    assert.deepEqual(stored.detail, { suppression: 'provider', code: 'list_block' });
    assert.deepEqual(stored.recipients, ['Reader@example.test']);
    // Authenticated tenant + namespace are composite identities, not global IDs.
    await runCases(t, Array.from(['tenant', 'other'], (tenantId, rowIndex) => [`${t.name}: tenantId row ${rowIndex + 1}`, async t => {
await runCases(t, Array.from(['events', 'other'], (eventNamespace, rowIndex) => [`${t.name}: eventNamespace row ${rowIndex + 1}`, async t => {
      const response = await ingest(runtime, token, { tenantId, eventNamespace });
      assert.equal(response.result[0].outcome, tenantId === 'tenant' && eventNamespace === 'events' ? 'duplicate' : 'stored');
}]));
}]));
    await runtime.dispose(); runtime = await createRuntime(path, source(), NOW); db = await runtime.getD1Database('DB');
    assert.equal((await ingest(runtime, token)).result[0].outcome, 'duplicate');
    // Local-part case is meaningful; two mailbox states must survive independently.
    const caseResponse = await ingest(runtime, signedEvents([event('case', { recipient: 'reader@example.test' })]));
    assert.equal(caseResponse.result[0].recipients[0].recipient, 'reader@example.test');
    assert.ok((await states(db)).some(row => row.recipient === 'Reader@example.test'));
    assert.ok((await states(db)).some(row => row.recipient === 'reader@example.test'));
    // Pending/terminal races and out-of-order facts have forward-only SQL policy.
    const future = (seconds) => new Date(NOW + seconds * 1000).toISOString();
    await Promise.all([
      ingest(runtime, signedEvents([event('pending-race', { messageId: 'ordering', type: 'accepted', occurredAt: future(30) })])),
      ingest(runtime, signedEvents([event('terminal-race', { messageId: 'ordering', type: 'delivered', occurredAt: future(10) })])),
    ]);
    const late = await ingest(runtime, signedEvents([event('late-deferred', { messageId: 'ordering', type: 'deferred', occurredAt: future(50) })]));
    assert.equal(late.result[0].recipients[0].applied, false); assert.equal(late.result[0].recipients[0].state.status, 'delivered');
    const older = await ingest(runtime, signedEvents([event('older-terminal', { messageId: 'ordering', type: 'bounced', occurredAt: future(5) })]));
    assert.equal(older.result[0].recipients[0].applied, false);
    const newer = await ingest(runtime, signedEvents([event('newer-terminal', { messageId: 'ordering', type: 'complained', occurredAt: future(15) })]));
    assert.equal(newer.result[0].recipients[0].state.status, 'complained');
    const equal = await ingest(runtime, signedEvents([event('equal-terminal', { messageId: 'ordering', type: 'failed', occurredAt: future(15) })]));
    assert.equal(equal.result[0].recipients[0].applied, false); assert.equal(equal.result[0].recipients[0].state.status, 'complained');
    // Verify all authentication and authorization BEFORE the first durable effect.
    const baseline = await counts(db);
    const otherKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
    await runCases(t, Array.from([token.slice(0, -4) + 'AAAA', JSON.stringify({ events: [event('unsigned')] }),
      signedEvents([event('wrong-key')], { privateKey: otherKey }),
      signedEvents([event('wrong-iss')], { claims: { iss: 'https://other.example.test' } }),
      signedEvents([event('wrong-aud')], { claims: { aud: 'other-install' } }),
      signedEvents([event('stale')], { claims: { iat: NOW / 1000 - 3600 } }),
      signedEvents([event('future')], { claims: { iat: NOW / 1000 + 3600 } }),
      signedEvents([event('alg')], { header: { alg: 'HS256' } }),
      signedEvents([event('kid')], { header: { kid: 'untrusted' } }),
      signedEvents([event('jku')], { header: { jku: 'https://evil.test/keys' } })], (bad, rowIndex) => [`${t.name}: invalid signature row ${rowIndex + 1}`, async t => {
      assert.equal((await ingest(runtime, bad)).code, 'event_signature_invalid');
}]));
    const unauthorized = await ingest(runtime, signedEvents([event('before-unauthorized'), event('unauthorized', { deliveryId: 'unowned' })]));
    assert.equal(unauthorized.code, 'event_unauthorized');
    await runCases(t, Array.from([event('schema', { surprise: 'SENSITIVE' }), event('detail', { detail: { text: 'SENSITIVE' } }),
      event('detail-kind', { detail: { bounce: 'hard' } }), event('bad-address', { recipient: 'Reader <Reader@example.test>' }),
      event('bad-date', { occurredAt: '2026-02-30T00:00:00Z' })], (bad, rowIndex) => [`${t.name}: invalid event row ${rowIndex + 1}`, async t => {
      assert.equal((await ingest(runtime, signedEvents([event('before-invalid'), bad]))).status, 400);
}]));
    assert.deepEqual(await counts(db), baseline);
  } finally { await runtime?.dispose(); await rm(path, { recursive: true, force: true }); }

  }]]);
});
