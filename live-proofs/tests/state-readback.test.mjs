import { runRows } from '../../default-seed/tests/rows.mjs'
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { digest } from '../../scripts/qualification/operations.mjs';
import { snapshotState, recheckState } from '../t016/state.mjs';

const messageRows = []
const continuityRows = []

// Real SQL readback over test-only representative records. No provider calls.
function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`
    CREATE TABLE users (id TEXT, name TEXT, created_at TEXT);
    CREATE TABLE projects (id TEXT, name TEXT, allowed_origin TEXT, created_at TEXT);
    CREATE TABLE memberships (project_id TEXT, user_id TEXT, role TEXT);
    CREATE TABLE contacts (id TEXT, project_id TEXT, name TEXT, created_at TEXT);
    CREATE TABLE conversations (id TEXT, project_id TEXT, contact_id TEXT, revision INTEGER, last_message_id TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT, local_id TEXT, actor_id TEXT, actor_role TEXT, content TEXT, revision INTEGER, created_at TEXT);
    CREATE TABLE media (id TEXT, conversation_id TEXT, object_key TEXT, filename TEXT, content_type TEXT, size INTEGER, message_id TEXT);
    CREATE TABLE d1_migrations (id INTEGER, name TEXT, applied_at TEXT);
    INSERT INTO users VALUES ('owner', 'Owner', '2026-01-01');
    INSERT INTO projects VALUES ('project', 'Project', 'https://widget.example.test', '2026-01-01');
    INSERT INTO memberships VALUES ('project', 'owner', 'owner');
    INSERT INTO contacts VALUES ('visitor', 'project', 'Visitor', '2026-01-01');
    INSERT INTO conversations VALUES ('conversation', 'project', 'visitor', 2, 'operator-message', '2026-01-01', '2026-01-01');
    INSERT INTO messages VALUES ('visitor-message', 'conversation', 'local-1', 'visitor', 'contact', 'Request Ω', 1, '2026-01-01');
    INSERT INTO messages VALUES ('operator-message', 'conversation', 'local-2', 'owner', 'owner', 'Reply ✓', 2, '2026-01-01');
    INSERT INTO media VALUES ('media', 'conversation', 'object', 'proof.png', 'image/png', 5, 'visitor-message');
    INSERT INTO d1_migrations VALUES (1, '0001_initial.sql', '2026-01-01');
  `);
  const state = { owner: { userId: 'owner', projectId: 'project', token: 'synthetic-session' },
    conversationId: 'conversation', requestContent: 'Request Ω', replyContent: 'Reply ✓',
    reply: { conversationId: 'conversation', visitorId: 'visitor', visitorMessageId: 'visitor-message',
      operatorMessageId: 'operator-message', requestSha256: digest('Request Ω'), replySha256: digest('Reply ✓') },
    media: { mediaId: 'media', sha256: digest('media') }, browserInput: { email: 'proof@example.test' }, password: 'synthetic-password' };
  let mediaReads = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(url, 'https://proof.example.test/api/conversations/conversation/media/media');
    mediaReads++; return new Response('media');
  });
  const input = { read: async (sql, params = []) => db.prepare(sql).all(...params), state,
    origin: 'https://proof.example.test', migrations: [{ name: '0001_initial.sql', sha256: digest('sql') }] };
  return { db, input, mediaReads: () => mediaReads };
}
messageRows.push(['initial snapshot binds two durable messages and captures a stable continuity baseline', {}, async t => {
  const f = fixture(t), first = await snapshotState(f.input), second = await snapshotState(f.input);
  assert.deepEqual(first, second); assert.equal(f.mediaReads(), 2);
  assert.equal(first.mediaSha256, f.input.state.media.sha256);
  assert.equal(first.sourceMigrationsSha256, digest(f.input.migrations));
}]);
for (const [name, sql] of [
  ['visitor message ID', "UPDATE messages SET id='other' WHERE id='visitor-message'"],
  ['operator message ID', "UPDATE messages SET id='other' WHERE id='operator-message'"],
  ['visitor actor', "UPDATE messages SET actor_id='unrelated' WHERE id='visitor-message'"],
  ['operator actor', "UPDATE messages SET actor_id='unrelated' WHERE id='operator-message'"],
  ['visitor role', "UPDATE messages SET actor_role='owner' WHERE id='visitor-message'"],
  ['operator role', "UPDATE messages SET actor_role='contact' WHERE id='operator-message'"],
  ['request content', "UPDATE messages SET content='Corrupted request' WHERE id='visitor-message'"],
  ['reply content', "UPDATE messages SET content='Corrupted reply' WHERE id='operator-message'"],
  ['exact content whitespace', "UPDATE messages SET content=content || ' ' WHERE id='operator-message'"],
]) messageRows.push(['initial snapshot rejects wrong ' + name + ' in the correct conversation', {}, async t => {
  const f = fixture(t); f.db.exec(sql);
  await assert.rejects(snapshotState(f.input), /prior-data-changed/); assert.equal(f.mediaReads(), 0);
}]);
messageRows.push(['moving a required message out of the conversation fails readback', {}, async t => {
  const f = fixture(t); f.db.exec("UPDATE messages SET conversation_id='unrelated' WHERE id='operator-message'");
  await assert.rejects(snapshotState(f.input), /representative-data-incomplete/);
}]);
messageRows.push(['a readback returning the right ID from the wrong conversation is rejected', {}, async t => {
  const f = fixture(t), read = f.input.read;
  // Deliberately corrupt the readback envelope after executing the real query.
  f.input.read = async (...args) => {
    const rows = await read(...args);
    if (args[0].includes('FROM messages')) rows[1].conversation_id = 'other-conversation';
    return rows;
  };
  await assert.rejects(snapshotState(f.input), /prior-data-changed/); assert.equal(f.mediaReads(), 0);
}]);
for (const [name, mutate] of [
  ['request hash', state => state.reply.requestSha256 = digest('different')],
  ['reply hash', state => state.reply.replySha256 = digest('different')],
  ['conversation identity', state => state.reply.conversationId = 'different'],
  ['distinct message identities', state => state.reply.operatorMessageId = state.reply.visitorMessageId],
  ['missing operator identity', state => delete state.reply.operatorMessageId],
  ['missing content', state => delete state.replyContent],
]) messageRows.push(['snapshot rejects inconsistent journey ' + name, {}, async t => {
  const f = fixture(t); mutate(f.input.state);
  await assert.rejects(snapshotState(f.input), /representative-data-incomplete/); assert.equal(f.mediaReads(), 0);
}]);
for (const [name, sql, failure] of [
  ['owner membership', "UPDATE memberships SET role='agent'", /representative-data-incomplete/],
  ['media message binding', "UPDATE media SET message_id='other'", /representative-data-incomplete/],
  ['migration ledger', "UPDATE d1_migrations SET name='other.sql'", /migration-ledger-incomplete/],
]) continuityRows.push(['snapshot retains ' + name + ' invariant', {}, async t => {
  const f = fixture(t); f.db.exec(sql); await assert.rejects(snapshotState(f.input), failure);
}]);
continuityRows.push(['valid message binding cannot mask changed prior rows during recheck', {}, async t => {
  const f = fixture(t), before = await snapshotState(f.input); f.db.exec("UPDATE contacts SET name='Changed'");
  await assert.rejects(recheckState({ ...f.input, before, previousMigrations: f.input.migrations,
    browser: () => assert.fail('Changed rows must fail before browser/login') }), /prior-data-changed/);
}]);
continuityRows.push(['valid message binding cannot mask missing media bytes', {}, async t => {
  const f = fixture(t); t.mock.method(globalThis, 'fetch', async () => new Response('lost'));
  await assert.rejects(snapshotState(f.input), /prior-media-changed/);
}]);
continuityRows.push(['recheck retains applied migration byte immutability before reading state', {}, async t => {
  const f = fixture(t), before = await snapshotState(f.input);
  await assert.rejects(recheckState({ ...f.input, before, previousMigrations: [{ name: '0001_initial.sql', sha256: digest('different sql') }],
    browser: () => assert.fail('Changed history must fail before browser/login') }), /applied-migration-bytes-changed/);
}]);

test("snapshot binds exact journey messages before accepting a continuity baseline", async t => {
  await runRows(t, messageRows)
})

test("snapshot and recheck refuse lost data, media and applied history", async t => {
  await runRows(t, continuityRows)
})
