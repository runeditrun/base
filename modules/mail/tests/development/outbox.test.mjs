import { runCases } from '../helpers/cases.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { createD1DevelopmentOutbox } from '../../src/development/index.mjs';

const schema = await readFile(new URL('../../src/development/schema.sql', import.meta.url), 'utf8');
const message = id => ({ deliveryId: id, from: 'sender@example.test', to: ['reader@example.test'], subject: 'Saved ✓', text: 'Hello', attachments: [{ filename: 'raw.bin', contentType: 'application/octet-stream', content: Uint8Array.of(0, 255, 128, 10) }] });

// Test-only D1-shaped adapter executes real SQLite SQL, including batch rollback.
function database(t) {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  sqlite.exec(schema); sqlite.exec(schema);
  const db = {
    prepare(sql) { return { bind(...values) { return { sql, values }; } }; },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = statements.map(({ sql, values }) => ({ success: true, results: sqlite.prepare(sql).all(...values) }));
        sqlite.exec('COMMIT'); return results;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  return { db, sqlite };
}

test("development outbox capture remains atomic, bounded and detached from caller bytes", async t => {
  const foldedCases = [];
foldedCases.push(['SQLite batches preserve complete prepared messages and detach raw bytes', async t => {
  const { db } = database(t);
  const outbox = createD1DevelopmentOutbox({ db, clock: () => 1000 });
  const input = { ...message('repeat'), cc: ['copy@example.test'], bcc: ['hidden@example.test'], replyTo: 'reply@example.test', html: '<b>Hello</b>', headers: { 'List-Unsubscribe': '<https://example.test/leave>' }, customArgs: { purpose: 'test' }, asmGroupId: 2, subscriptionTracking: false };
  const expected = structuredClone(input);
  const pending = outbox.put(input);
  input.attachments[0].content.fill(42); input.subject = 'mutated';
  await pending;
  // list() returns summaries without attachment bytes; get() restores the full capture.
  const [listed] = await outbox.list();
  const { attachments: _omitted, ...summary } = expected;
  assert.deepEqual(listed.message, summary); assert.equal(listed.createdAt, 1000);
  const stored = await outbox.get(listed.id);
  assert.deepEqual(stored.message, expected); assert.equal(stored.createdAt, 1000);
  stored.message.attachments[0].content.fill(13);
  assert.deepEqual((await outbox.get(listed.id)).message, expected);
  await outbox.put(message('repeat'));
  const rows = await outbox.list(); assert.equal(rows.length, 2); assert.notEqual(rows[0].id, rows[1].id);
  assert.equal(await outbox.get('missing'), null);
}]);
foldedCases.push(['retention prunes count on writes and bounds reads with deterministic time ties', async t => {
  const { db, sqlite } = database(t);
  const outbox = createD1DevelopmentOutbox({ db, maxMessages: 2, clock: () => 1000 });
  for (const id of ['first', 'second', 'third']) await outbox.put(message(id));
  assert.deepEqual((await outbox.list()).map(row => row.message.deliveryId), ['third', 'second']);
  assert.equal(sqlite.prepare('SELECT count(*) AS count FROM rer_mail_development_outbox').get().count, 2);
  const smaller = createD1DevelopmentOutbox({ db, maxMessages: 1, clock: () => 1000 });
  const rows = await smaller.list(); assert.deepEqual(rows.map(row => row.message.deliveryId), ['third']);
  // Reads never write: the smaller bound limits the listing but prunes nothing.
  assert.equal(sqlite.prepare('SELECT count(*) AS count FROM rer_mail_development_outbox').get().count, 2);
}]);
foldedCases.push(['age expiration applies at exact boundary on reads and writes, including get', async t => {
  const { db, sqlite } = database(t); let time = 1000;
  const outbox = createD1DevelopmentOutbox({ db, maxAgeMs: 100, clock: () => time });
  await outbox.put(message('one')); const [first] = await outbox.list();
  time = 1099; assert.ok(await outbox.get(first.id));
  time = 1100; assert.equal(await outbox.get(first.id), null);
  await outbox.put(message('two')); time = 1200;
  assert.deepEqual(await outbox.list(), []);
  await outbox.put(message('three')); time = 1300; await outbox.put(message('four'));
  assert.deepEqual((await outbox.list()).map(row => row.message.deliveryId), ['four']);
  assert.equal(sqlite.prepare('SELECT count(*) AS count FROM rer_mail_development_outbox').get().count, 1);
}]);
foldedCases.push(['invalid retention, clocks and unprepared mail fail before storage', async t => {
  const { db } = database(t);
  await runCases(t, Array.from(['maxMessages', 'maxAgeMs'], (key, rowIndex) => [`${t.name}: key row ${rowIndex + 1}`, async t => {
await runCases(t, Array.from([0, -1, 1.5, NaN, Infinity, '10', Number.MAX_SAFE_INTEGER + 1], (value, rowIndex) => [`${t.name}: value row ${rowIndex + 1}`, async t => {
    assert.throws(() => createD1DevelopmentOutbox({ db, [key]: value }), /retention/);
}]));
}]));
  await runCases(t, [
    ["outbox configuration inputs: case 1", async t => {
      assert.throws(() => createD1DevelopmentOutbox(), /configuration/);
    }],
    ["outbox configuration inputs: case 2", async t => {
      assert.throws(() => createD1DevelopmentOutbox({ db, clock: 3 }), /configuration/);
    }]
  ]);
  await runCases(t, Array.from([-1, NaN, Infinity, '100', 1.1, 8_640_000_000_000_001], (time, rowIndex) => [`${t.name}: time row ${rowIndex + 1}`, async t => {
    const outbox = createD1DevelopmentOutbox({ db, clock: () => time });
    await runCases(t, [
    ["invalid clock operations: case 1", async t => {
      await assert.rejects(outbox.put(message('bad')), /clock/);
    }],
    ["invalid clock operations: case 2", async t => {
      await assert.rejects(outbox.list(), /clock/);
    }],
    ["invalid clock operations: case 3", async t => {
      await assert.rejects(outbox.get('id'), /clock/);
    }]
  ]);
}]));
  const outbox = createD1DevelopmentOutbox({ db });
  await runCases(t, [
    ["invalid outbox messages: case 1", async t => {
      await assert.rejects(outbox.put({ ...message('unprepared'), unsubscribe: { url: 'https://example.test/leave' } }), error => error.code === 'unsubscribe_not_assembled');
    }],
    ["invalid outbox messages: case 2", async t => {
      await assert.rejects(outbox.put({ ...message('invalid'), attachments: [{ content: 'not raw bytes' }] }));
    }]
  ]);
  await runCases(t, Array.from(['', null, 'x'.repeat(129)], (id, rowIndex) => [`${t.name}: id row ${rowIndex + 1}`, async t => {
await assert.rejects(outbox.get(id), /ID/);
}]));
  assert.deepEqual(await outbox.list(), []);
}]);
foldedCases.push(['a batch failure rolls back capture and does not silently fall back', async t => {
  const { db, sqlite } = database(t);
  const outbox = createD1DevelopmentOutbox({ db, clock: () => 1000, maxMessages: 1 });
  await outbox.put(message('first'));
  sqlite.exec("CREATE TRIGGER stop_delete BEFORE DELETE ON rer_mail_development_outbox BEGIN SELECT RAISE(ABORT, 'retention failed'); END");
  await assert.rejects(outbox.put(message('second')), /retention failed/);
  assert.deepEqual((await outbox.list()).map(row => row.message.deliveryId), ['first']);
  const failed = createD1DevelopmentOutbox({ db: { prepare: db.prepare, batch: async () => [{ success: false }] } });
  await assert.rejects(failed.list(), /storage failed/);
}]);
  await runCases(t, foldedCases);
});
