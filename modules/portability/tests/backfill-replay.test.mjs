import { runCases } from './cases.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { database, bundle, stage } from './regression-helpers.mjs';
import { createPortability } from '../index.mjs';
import { migrationReplay } from '../migration-history.mjs';
import { migrationStatements } from '../migration-sql.mjs';

// An archive taken before a migration that adds a journal table excluded from
// archives and a membership log the archive lacks, each backfilled from archived
// rows, restored through the public service into D1 destinations whose ledger
// applied it. Migrations are split by Wrangler's own splitter, as the CLI runner splits them.
const root = new URL('../../../', import.meta.url).pathname;
const wrangler = (await readdir(join(root, 'node_modules/.pnpm'))).find(name => name.startsWith('wrangler@4.129.1_'));
const { unstable_splitSqlQuery: split } = createRequire(join(root, 'node_modules/.pnpm', wrangler, 'node_modules/wrangler/package.json'))('wrangler');
const policy = { product: 'backfill-replay', excludeTables: ['room_changes'] };
const ledger = 'CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL UNIQUE,applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)';
const rooms = { name: '0001_rooms.sql', sql: `CREATE TABLE rooms(id TEXT PRIMARY KEY,title TEXT NOT NULL);
CREATE TABLE members(room TEXT NOT NULL REFERENCES rooms(id),user TEXT NOT NULL,PRIMARY KEY(room,user));` };
const changes = `CREATE TABLE room_changes(room TEXT PRIMARY KEY,revision INTEGER NOT NULL);
INSERT INTO room_changes SELECT id,0 FROM rooms;`;
const log = `CREATE TABLE membership_log(seq INTEGER PRIMARY KEY AUTOINCREMENT,room TEXT NOT NULL,user TEXT NOT NULL,action TEXT NOT NULL,at TEXT NOT NULL,private_note TEXT);
CREATE INDEX membership_log_room ON membership_log(room,seq);`;
const carriedLog = log.replace(' AUTOINCREMENT', '');
const backfill = `INSERT INTO membership_log(room,user,action,at) SELECT room,user,'baseline',strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM members;`;
const journal = { name: '0002_journal.sql', sql: `${changes}
${log}
${backfill}
CREATE TRIGGER membership_join AFTER INSERT ON members BEGIN INSERT INTO membership_log(room,user,action,at) VALUES(NEW.room,NEW.user,'join',strftime('%Y-%m-%dT%H:%M:%fZ','now')); END;
CREATE TRIGGER room_change AFTER INSERT ON members BEGIN INSERT INTO room_changes VALUES(NEW.room,1) ON CONFLICT(room) DO UPDATE SET revision=revision+1; END;` };

const statements = migration => split(migration.sql);
async function apply(db, migrations) {
  for (const migration of migrations) await db.batch([...statements(migration), `INSERT INTO d1_migrations(name) VALUES('${migration.name}')`].map(sql => db.prepare(sql)));
}
// A D1 database that applied `migrations`, served with a replay of them.
async function installed(t, migrations, wrap = db => db, rules = policy) {
  const target = await database(t, [ledger], policy);
  await apply(target.db, migrations);
  const replay = async () => migrationReplay(migrations.map(m => ({ name: m.name, statements: migrationStatements(m.sql, split) })), rules);
  return { ...target, service: await createPortability({ db: wrap(target.db), buckets: { FILES: target.bucket }, policy: rules, migrations: replay }) };
}
async function source(t, first = rooms, extra = [], rules = policy) {
  const installation = await installed(t, [first], undefined, rules);
  await installation.db.batch(["INSERT INTO rooms VALUES('r1','Launch'),('r2','Support')", "INSERT INTO members VALUES('r1','u1'),('r1','u2'),('r2','u1')"].map(sql => installation.db.prepare(sql)));
  if (extra.length) await installation.db.batch(extra.map(sql => installation.db.prepare(sql)));
  return { ...installation, archive: await bundle(installation.service) };
}
const select = async (db, sql) => (await db.prepare(sql).all()).results;
const membership = db => select(db, 'SELECT seq,room,user,action FROM membership_log ORDER BY seq');
const archived = db => Promise.all(['SELECT * FROM rooms ORDER BY id', 'SELECT * FROM members ORDER BY room,user'].map(sql => select(db, sql)));
const finalize = (service, archive, id) => service.imports.finalize(id, { contentHash: archive.closing.contentHash, archiveHash: archive.closing.archiveHash });
// The apply batch that runs replays fails once after they ran, inside D1's own transaction.
function failingOnce(db) {
  let failed = false;
  const wrap = (raw, sql) => ({ sql, raw, bind: (...args) => wrap(raw.bind(...args), sql), all: () => raw.all(), first: (...args) => raw.first(...args), run: () => raw.run() });
  return { prepare: sql => wrap(db.prepare(sql), sql), async batch(list) {
    const raw = list.map(x => x.raw);
    if (!failed && list.some(x => x.sql.includes('json_set'))) { failed = true; raw.push(db.prepare('INSERT INTO rer_portability_guard(value) VALUES(0)')); }
    return db.batch(raw);
  } };
}

test("restore replays only safe carried journal backfills without rewriting archived data", async t => {
  const foldedCases = [];
foldedCases.push(['an archive predating a journal backfill restores to the live upgrade, and a failed apply leaves no replayed row', async t => {
  const { db: live, archive } = await source(t);
  assert.deepEqual(archive.manifest.migrations, [rooms.name]);
  await apply(live, [journal]);
  const upgraded = await membership(live);
  assert.equal(upgraded.length, 3);

  const target = await installed(t, [rooms, journal], failingOnce);
  const id = await stage(target.service, archive);
  await assert.rejects(finalize(target.service, archive, id));
  assert.deepEqual([await membership(target.db), ...await archived(target.db)], [[], [], []]);
  const status = await finalize(target.service, archive, id);
  assert.equal(status.phase, 'complete');
  assert.deepEqual(await membership(target.db), upgraded);
  assert.deepEqual(await archived(target.db), await archived(live));
  assert.deepEqual(status.bridged.replayed, [{ migration: journal.name, statement: 4, table: 'membership_log', rows: 3 }]);
  // The excluded journal is not restored: the destination keeps its own (empty) rows.
  assert.deepEqual(await select(target.db, 'SELECT * FROM room_changes'), []);
  // Triggers are back after the replay: a new member logs a join after the baselines.
  await target.db.prepare("INSERT INTO members VALUES('r2','u3')").run();
  assert.deepEqual((await membership(target.db)).at(-1), { seq: 4, room: 'r2', user: 'u3', action: 'join' });
}]);
foldedCases.push(['a carried journal replays INSERT or REPLACE over its archived rows exactly like a live upgrade', async t => {
  const carried = { name: rooms.name, sql: `${rooms.sql}\n${carriedLog}` };
  await runCases(t, Array.from(['INSERT OR IGNORE', 'REPLACE'], (verb, rowIndex) => [`${t.name}: verb row ${rowIndex + 1}`, async t => {
    const { db: live, archive } = await source(t, carried, ["INSERT INTO membership_log(seq,room,user,action,at) VALUES(8,'r1','u0','archived','2026-10-20T00:00:00Z')"]);
    const added = verb === 'REPLACE' ? "ALTER TABLE membership_log ADD COLUMN origin TEXT NOT NULL DEFAULT 'retained';\n" : '';
    const mirror = { name: '0002_baseline.sql', sql: `${added}${verb} INTO membership_log(room,user,action,at) SELECT room,user,'baseline','2026-10-20T01:00:00Z' FROM members ORDER BY room,user;` };
    await apply(live, [mirror]);
    const expected = await select(live, 'SELECT * FROM membership_log ORDER BY seq');
    assert.equal(expected.length, 4);

    const target = await installed(t, [carried, mirror], failingOnce);
    const id = await stage(target.service, archive);
    await assert.rejects(finalize(target.service, archive, id));
    assert.deepEqual([await membership(target.db), ...await archived(target.db)], [[], [], []]);
    const status = await finalize(target.service, archive, id);
    assert.equal(status.phase, 'complete');
    assert.equal(JSON.stringify(await select(target.db, 'SELECT * FROM membership_log ORDER BY seq')), JSON.stringify(expected));
    assert.deepEqual(await archived(target.db), await archived(live));
    assert.deepEqual(status.bridged.replayed, [{ migration: mirror.name, statement: added ? 1 : 0, table: 'membership_log', rows: 3 }]);
}]));
}]);
foldedCases.push(['excluded writes are admitted; carried UPDATE/DELETE, another writer and non-archived reads stay refused', async t => {
  const { archive } = await source(t);
  const admitted = { name: '0002_changes.sql', sql: changes };
  const target = await installed(t, [rooms, admitted]);
  const status = await finalize(target.service, archive, await stage(target.service, archive));
  assert.equal(status.phase, 'complete');
  assert.equal(status.bridged?.replayed, undefined);

  const carried = { name: '0001_rooms.sql', sql: `${rooms.sql}\n${carriedLog}` };
  const olderCarried = await source(t, carried, ["INSERT INTO membership_log(room,user,action,at) VALUES('r1','u0','archived','2026-10-20T00:00:00Z')"]);
  const secretPolicy = { ...policy, secretColumns: { membership_log: ['private_note'] } };
  const withSecret = await source(t, carried, ["INSERT INTO membership_log(room,user,action,at,private_note) VALUES('r1','u0','archived','now','omitted')"], secretPolicy);
  const sequenced = { name: rooms.name, sql: `${rooms.sql}\n${log}` };
  const withSequenceGap = await source(t, sequenced, ["INSERT INTO membership_log(seq,room,user,action,at) VALUES(8,'r1','u0','archived','now'),(100,'r1','u9','deleted','now')", 'DELETE FROM membership_log WHERE seq=100']);
  const refusals = [
    [olderCarried, [carried, { name: '0002_update.sql', sql: "UPDATE membership_log SET action='changed';" }]],
    [olderCarried, [carried, { name: '0002_delete.sql', sql: 'DELETE FROM membership_log;' }]],
    [olderCarried, [carried, { name: '0002_second_writer.sql', sql: `${backfill}\nDELETE FROM membership_log WHERE user='u2';` }]],
    [olderCarried, [carried, { name: '0002_baseline.sql', sql: backfill }, { name: '0003_second_insert.sql', sql: "INSERT INTO membership_log(room,user,action,at) SELECT room,user,'other','now' FROM members;" }]],
    [olderCarried, [carried, { name: '0002_from_excluded.sql', sql: `${changes}\nINSERT INTO membership_log(room,user,action,at) SELECT room,'u0','baseline','now' FROM room_changes;` }]],
    [olderCarried, [carried, { name: '0002_positional.sql', sql: "INSERT INTO membership_log SELECT seq+100,room,user,action,at,private_note FROM membership_log;" }]],
    [olderCarried, [carried, { name: '0002_star.sql', sql: 'INSERT INTO membership_log(seq,room,user,action,at,private_note) SELECT * FROM membership_log;' }]],
    [withSecret, [carried, { name: '0002_secret.sql', sql: "INSERT INTO membership_log(room,user,action,at) SELECT room,user,private_note,at FROM membership_log;" }], secretPolicy],
    [withSecret, [carried, { name: '0002_secret_view.sql', sql: "CREATE VIEW journal_notes AS SELECT room,user,private_note AS note,at FROM membership_log;\nINSERT INTO membership_log(room,user,action,at) SELECT room,user,note,at FROM journal_notes;" }], secretPolicy],
    [withSequenceGap, [sequenced, { name: '0002_autoincrement.sql', sql: backfill }]],
    [olderCarried, [carried, { name: '0002_physical_rowid.sql', sql: "INSERT INTO membership_log(room,user,action,at) SELECT room,user,CAST(rowid AS TEXT),'now' FROM members;" }]],
    [olderCarried, [carried, { name: '0002_physical_rowid_view.sql', sql: "CREATE VIEW physical_members AS SELECT room,user,rowid AS position FROM members;\nINSERT INTO membership_log(room,user,action,at) SELECT room,user,CAST(position AS TEXT),'now' FROM physical_members;" }]],
    [{ archive }, [rooms, { name: '0002_titles.sql', sql: "UPDATE rooms SET title=upper(title) WHERE id IN (SELECT room FROM members);" }]],
    [{ archive }, [rooms, { name: '0002_journal.sql', sql: `${journal.sql}\nDELETE FROM membership_log WHERE user='u2';` }]],
    [{ archive }, [rooms, { name: '0002_from_excluded.sql', sql: `${changes}\n${log}\nINSERT INTO membership_log(room,user,action,at) SELECT room,'u0','baseline','now' FROM room_changes;` }]],
  ];
  for (const [{ archive: older }, migrations, rules = policy] of refusals) {
    await runCases(t, [[migrations[1].name, async scenario => {
      const destination = await installed(scenario, migrations, undefined, rules);
      await assert.rejects(destination.service.imports.create(older.manifest), new RegExp('schema_mismatch:migration_data:' + migrations[1].name), migrations[1].name);
      assert.deepEqual([await membership(destination.db).catch(() => []), ...await archived(destination.db)], [[], [], []]);
    }]]);
  }
}]);
foldedCases.push(['import reconstructs a transient backfill from archived evidence and drops it atomically', async t => {
  const baseline = { name: '0002_baseline.sql', sql: `CREATE TABLE room_baseline(room TEXT PRIMARY KEY);
INSERT INTO room_baseline SELECT id FROM rooms;
${log}
CREATE TABLE attribution(seq INTEGER PRIMARY KEY,user TEXT NOT NULL);` };
  const retained = { name: '0003_retained.sql', sql: `CREATE TABLE "retained staging"(seq INTEGER PRIMARY KEY,room TEXT,user TEXT);
INSERT INTO "retained staging" SELECT coalesce((SELECT max(seq) FROM membership_log),0)+row_number() OVER (ORDER BY m.room,m.user),m.room,m.user FROM members m JOIN room_baseline b ON b.room=m.room;
INSERT INTO membership_log(seq,room,user,action,at) SELECT seq,room,user,'retained','2026-10-20T00:00:00Z' FROM "retained staging";
INSERT INTO attribution(seq,user) SELECT seq,user FROM "retained staging";
DROP TABLE "retained staging";` };
  await runCases(t, Array.from([true, false], (evidence, rowIndex) => [`${t.name}: evidence row ${rowIndex + 1}`, async t => {
    const original = await source(t);
    if (!evidence) await original.db.prepare('DELETE FROM members').run();
    const archive = await bundle(original.service);
    await apply(original.db, [baseline, retained]);
    const queries = ['SELECT * FROM membership_log ORDER BY seq', 'SELECT * FROM attribution ORDER BY seq', 'SELECT * FROM room_baseline ORDER BY room'];
    const expected = await Promise.all(queries.map(sql => select(original.db, sql)));
    assert.equal(expected[0].length, evidence ? 3 : 0);
    const target = await installed(t, [rooms, baseline, retained], failingOnce);
    const id = await stage(target.service, archive);
    await assert.rejects(finalize(target.service, archive, id));
    assert.deepEqual(await select(target.db, 'SELECT * FROM members'), []);
    assert.deepEqual(await select(target.db, "SELECT name FROM sqlite_master WHERE name='retained staging'"), []);
    assert.equal((await finalize(target.service, archive, id)).phase, 'complete');
    assert.deepEqual(await Promise.all(queries.map(sql => select(target.db, sql))), expected);
    assert.deepEqual(await archived(target.db), await archived(original.db));
    assert.deepEqual(await select(target.db, "SELECT name FROM sqlite_master WHERE name='retained staging'"), []);
    // A newer archive already carries the facts; it must not reconstruct them.
    const newer = await bundle(original.service),fresh = await installed(t, [rooms, baseline, retained]);
    assert.equal((await finalize(fresh.service, newer, await stage(fresh.service, newer))).phase, 'complete');
    assert.deepEqual(await Promise.all(queries.map(sql => select(fresh.db, sql))), expected);
}]));
  // An unsupported transient UPDATE keeps the old new-table-only admission;
  // its consumers must not run against the missing table at finalize.
  const original = await source(t),unsupported = { ...retained, sql: retained.sql.replace('INSERT INTO membership_log', 'UPDATE "retained staging" SET user=upper(user);\nINSERT INTO membership_log') };
  const target = await installed(t, [rooms, baseline, unsupported]);
  assert.equal((await finalize(target.service, original.archive, await stage(target.service, original.archive))).phase, 'complete');
  assert.deepEqual(await membership(target.db), []);
  assert.deepEqual(await archived(target.db), await archived(original.db));
}]);
  await runCases(t, foldedCases);
});
