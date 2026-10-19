import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { database, bundle, stage } from './regression-helpers.mjs';
import { createPortability } from '../index.mjs';
import { migrationReplay } from '../migration-history.mjs';

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
const log = `CREATE TABLE membership_log(seq INTEGER PRIMARY KEY AUTOINCREMENT,room TEXT NOT NULL,user TEXT NOT NULL,action TEXT NOT NULL,at TEXT NOT NULL);
CREATE INDEX membership_log_room ON membership_log(room,seq);`;
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
async function installed(t, migrations, wrap = db => db) {
  const target = await database(t, [ledger], policy);
  await apply(target.db, migrations);
  const replay = async () => migrationReplay(migrations.map(m => ({ name: m.name, statements: statements(m) })), policy);
  return { ...target, service: await createPortability({ db: wrap(target.db), buckets: { FILES: target.bucket }, policy, migrations: replay }) };
}
async function source(t, first = rooms) {
  const installation = await installed(t, [first]);
  await installation.db.batch(["INSERT INTO rooms VALUES('r1','Launch'),('r2','Support')", "INSERT INTO members VALUES('r1','u1'),('r1','u2'),('r2','u1')"].map(sql => installation.db.prepare(sql)));
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

test('an archive predating a journal backfill restores to the live upgrade, and a failed apply leaves no replayed row', async t => {
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
});

test('a write to an excluded table reading archived rows is admitted; a backfill of a carried table, an archived UPDATE or a second writer stay refused', async t => {
  const { archive } = await source(t);
  const admitted = { name: '0002_changes.sql', sql: changes };
  const target = await installed(t, [rooms, admitted]);
  const status = await finalize(target.service, archive, await stage(target.service, archive));
  assert.equal(status.phase, 'complete');
  assert.equal(status.bridged?.replayed, undefined);

  const carried = { name: '0001_rooms.sql', sql: `${rooms.sql}\n${log}` };
  const refusals = [
    [await source(t, carried), [carried, { name: '0002_baseline.sql', sql: backfill }]],
    [{ archive }, [rooms, { name: '0002_titles.sql', sql: "UPDATE rooms SET title=upper(title) WHERE id IN (SELECT room FROM members);" }]],
    [{ archive }, [rooms, { name: '0002_journal.sql', sql: `${journal.sql}\nDELETE FROM membership_log WHERE user='u2';` }]],
    [{ archive }, [rooms, { name: '0002_from_excluded.sql', sql: `${changes}\n${log}\nINSERT INTO membership_log(room,user,action,at) SELECT room,'u0','baseline','now' FROM room_changes;` }]],
  ];
  for (const [{ archive: older }, migrations] of refusals) {
    const destination = await installed(t, migrations);
    await assert.rejects(destination.service.imports.create(older.manifest), new RegExp('schema_mismatch:migration_data:' + migrations[1].name), migrations[1].name);
    assert.deepEqual([await membership(destination.db).catch(() => []), ...await archived(destination.db)], [[], [], []]);
  }
});
