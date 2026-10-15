import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { createD1DevelopmentOutbox } from '../../../modules/mail/src/development/index.mjs';

const schema = await readFile(new URL('../../../modules/mail/src/development/schema.sql', import.meta.url), 'utf8');
const message = id => ({
  deliveryId: id,
  from: 'sender@example.test',
  to: ['reader@example.test'],
  subject: 'Saved ✓',
  text: 'Hello',
  attachments: [{ filename: 'raw.bin', contentType: 'application/octet-stream', content: Uint8Array.of(0, 255, 128, 10) }],
});

function database(t) {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  sqlite.exec(schema);
  const db = {
    prepare(sql) { return { bind(...values) { return { sql, values }; } }; },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = statements.map(({ sql, values }) => ({ success: true, results: sqlite.prepare(sql).all(...values) }));
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return { db, sqlite };
}

test('list and get are query-only reads and leave expired rows for the next write to purge', async t => {
  const { db, sqlite } = database(t);
  let time = 1000;
  const outbox = createD1DevelopmentOutbox({ db, maxAgeMs: 100, clock: () => time });
  await outbox.put(message('first'));
  await outbox.put(message('second'));
  const [first] = await outbox.list();

  sqlite.exec('PRAGMA query_only = ON');
  const full = await outbox.get(first.id);
  assert.deepEqual(full.message.attachments[0].content, message('first').attachments[0].content);
  time = 1100;
  assert.deepEqual(await outbox.list(), []);
  assert.equal(await outbox.get(first.id), null);
  assert.equal(sqlite.prepare('SELECT count(*) AS count FROM rer_mail_development_outbox').get().count, 2);

  sqlite.exec('PRAGMA query_only = OFF');
  await outbox.put(message('fresh'));
  assert.deepEqual((await outbox.list()).map(row => row.message.deliveryId), ['fresh']);
  assert.equal(sqlite.prepare('SELECT count(*) AS count FROM rer_mail_development_outbox').get().count, 1);
});

test('list keeps the configured count bound and newest-first timestamp tie order without pruning on read', async t => {
  const { db, sqlite } = database(t);
  const writer = createD1DevelopmentOutbox({ db, maxMessages: 2, clock: () => 1000 });
  for (const id of ['first', 'second', 'third']) await writer.put(message(id));
  assert.deepEqual((await writer.list()).map(row => row.message.deliveryId), ['third', 'second']);
  assert.equal(sqlite.prepare('SELECT count(*) AS count FROM rer_mail_development_outbox').get().count, 2);

  sqlite.exec('PRAGMA query_only = ON');
  const limited = createD1DevelopmentOutbox({ db, maxMessages: 1, clock: () => 1000 });
  assert.deepEqual((await limited.list()).map(row => row.message.deliveryId), ['third']);
  assert.equal(sqlite.prepare('SELECT count(*) AS count FROM rer_mail_development_outbox').get().count, 2);
});

test('list drops attachment payloads without decoding poisoned base64', async t => {
  const { db, sqlite } = database(t);
  const outbox = createD1DevelopmentOutbox({ db, clock: () => 1000 });
  await outbox.put(message('poison'));
  const [capture] = await outbox.list();
  const stored = sqlite.prepare('SELECT message FROM rer_mail_development_outbox WHERE id = ?').get(capture.id);
  const poisoned = JSON.parse(stored.message);
  poisoned.attachments[0].content = 'not base64!';
  sqlite.prepare('UPDATE rer_mail_development_outbox SET message = ? WHERE id = ?').run(JSON.stringify(poisoned), capture.id);

  const originalAtob = globalThis.atob;
  globalThis.atob = () => { throw new Error('list decoded attachment bytes'); };
  t.after(() => { globalThis.atob = originalAtob; });
  const [summary] = await outbox.list();
  assert.equal(summary.id, capture.id);
  assert.equal('attachments' in summary.message, false);
  assert.doesNotMatch(JSON.stringify(summary), /not base64/);
});

test('get restores complete attachment payloads as independent Uint8Array bytes', async t => {
  const { db } = database(t);
  const outbox = createD1DevelopmentOutbox({ db, clock: () => 1000 });
  const input = message('binary');
  await outbox.put(input);
  const [summary] = await outbox.list();
  const capture = await outbox.get(summary.id);
  assert.deepEqual(capture.message, input);
  assert.ok(capture.message.attachments[0].content instanceof Uint8Array);
  assert.notEqual(capture.message.attachments[0].content, input.attachments[0].content);
});


test('failed retention rolls back the insert and invalid storage results reject reads', async t => {
  const { db, sqlite } = database(t);
  const outbox = createD1DevelopmentOutbox({ db, maxMessages: 1, clock: () => 1000 });
  await outbox.put(message('kept'));
  sqlite.exec("CREATE TRIGGER stop_delete BEFORE DELETE ON rer_mail_development_outbox BEGIN SELECT RAISE(ABORT, 'retention failed'); END");
  await assert.rejects(outbox.put(message('rolled-back')), /retention failed/);
  assert.deepEqual((await outbox.list()).map(row => row.message.deliveryId), ['kept']);

  const invalidStorage = createD1DevelopmentOutbox({ db: {
    prepare: db.prepare,
    async batch() { return [{ success: false, results: [] }]; },
  } });
  await assert.rejects(invalidStorage.list(), /Development outbox storage failed/);
});
