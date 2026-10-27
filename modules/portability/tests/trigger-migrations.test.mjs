import { runCases } from './cases.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { createPortability, readArchive, canonicalJson, sha256 } from '../index.mjs';
import { makePart, ContentVerifier, ArchiveVerifier } from '../format.mjs';
import { migrationReplay } from '../migration-history.mjs';
import { migrationStatements } from '../migration-sql.mjs';

// Archives taken before a later migration, restored through the public
// service into a destination whose ledger applied it. Migrations are split by
// Wrangler's own splitter, as the CLI runner splits them.
const root = new URL('../../../', import.meta.url).pathname;
const wrangler = (await readdir(join(root, 'node_modules/.pnpm'))).find(name => name.startsWith('wrangler@4.129.1_'));
const { unstable_splitSqlQuery: split } = createRequire(join(root, 'node_modules/.pnpm', wrangler, 'node_modules/wrangler/package.json'))('wrangler');
const schema = await readFile(new URL('../schema/portability.sql', import.meta.url), 'utf8');
const policy = { product: 'trigger-migrations', excludeTables: ['read_generations'] };

function binding(db) {
  return {
    prepare(sql) {
      let values = [];
      return {
        bind(...args) { values = args; return this; },
        async all() { return { results: db.prepare(sql).all(...values) }; },
        async first() { return db.prepare(sql).get(...values) ?? null; },
        async run() { return db.prepare(sql).run(...values); },
      };
    },
    async batch(statements) {
      db.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        db.exec('COMMIT');
        return results;
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}
const plan = (migrations, splitter = split) => migrations.map(({ name, sql, statements }) => ({ name, statements: statements ?? splitter(sql) }));
// A database that applied `migrations`, with a Wrangler ledger unless `ledger` is false.
function database(migrations, { ledger = true } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(schema);
  if (ledger) db.exec('CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL UNIQUE,applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  for (const { name, statements } of plan(migrations)) {
    for (const sql of statements) db.exec(sql);
    if (ledger) db.prepare('INSERT INTO d1_migrations(name) VALUES(?)').run(name);
  }
  return db;
}
const service = (db, migrations, input = policy) => createPortability({ db: binding(db), policy: input, migrations: async () => migrationReplay(plan(migrations, sql => migrationStatements(sql, split)), input) });
async function archive(portability) {
  const id = await portability.exports.create();
  while ((await portability.exports.advance(id, { maxParts: 10 })).phase === 'building') {}
  const records = [];
  for await (const record of readArchive(await portability.exports.download(id))) records.push(record);
  return { manifest: records[0], parts: records.filter(row => row.kind === 'part'), closing: records.at(-1) };
}
async function restore(portability, bundle) {
  const id = await portability.imports.create(bundle.manifest);
  for (const part of bundle.parts) await portability.imports.uploadPart(id, part.index, part);
  return portability.imports.finalize(id, { contentHash: bundle.closing.contentHash, archiveHash: bundle.closing.archiveHash });
}
const rows = (db, tables) => Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(row => ({ ...row }))]));
const triggers = db => db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all();
async function roundTrip(migrations, source, tables) {
  const bundle = await archive(await service(source, migrations.slice(0, 1)));
  const target = database(migrations), before = triggers(target);
  const status = await restore(await service(target, migrations), bundle);
  assert.equal(status.phase, 'complete');
  assert.deepEqual(rows(target, tables), rows(source, tables));
  assert.deepEqual(triggers(target), before);
  return { bundle, target, status };
}

const reads = { name: '0001_reads.sql', sql: `CREATE TABLE message_history(id TEXT PRIMARY KEY,conversation TEXT NOT NULL);
CREATE TABLE reads(conversation TEXT NOT NULL,user TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(conversation,user));
CREATE TABLE thread_reads(message TEXT NOT NULL,user TEXT NOT NULL,PRIMARY KEY(message,user));` };
// Like a read-generation fence: triggers on archived tables whose bodies write
// only a table the policy excludes from archives.
const generations = { name: '0002_generations.sql', sql: `CREATE TABLE read_generations(conversation TEXT NOT NULL,user TEXT NOT NULL,generation INTEGER NOT NULL,PRIMARY KEY(conversation,user));
CREATE TRIGGER read_insert AFTER INSERT ON reads BEGIN
 INSERT INTO read_generations VALUES(NEW.conversation,NEW.user,1) ON CONFLICT(conversation,user) DO UPDATE SET generation=generation+1;
END;
CREATE TRIGGER read_update AFTER UPDATE ON reads BEGIN
 INSERT INTO read_generations VALUES(NEW.conversation,NEW.user,1) ON CONFLICT(conversation,user) DO UPDATE SET generation=generation+1;
END;
CREATE TRIGGER thread_read_insert AFTER INSERT ON thread_reads BEGIN
 INSERT INTO read_generations SELECT conversation,NEW.user,1 FROM message_history WHERE id=NEW.message ON CONFLICT(conversation,user) DO UPDATE SET generation=generation+1;
END;
CREATE TABLE read_undo(id TEXT PRIMARY KEY,user TEXT NOT NULL,expires INTEGER NOT NULL);` };
const custody = { name: '0001_custody.sql', sql: `CREATE TABLE jobs(id TEXT PRIMARY KEY);
CREATE TABLE custody_states(job_id TEXT PRIMARY KEY REFERENCES jobs(id),revision INTEGER NOT NULL DEFAULT 0);
CREATE TABLE sources(id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES jobs(id));
CREATE TRIGGER sources_touch AFTER UPDATE ON sources BEGIN UPDATE custody_states SET revision=revision+1 WHERE job_id=NEW.job_id; END;` };
// Like a custody replace fence: BEFORE INSERT/UPDATE triggers on archived
// tables whose bodies RAISE or UPDATE another archived table, and a trigger
// dropped and recreated with a new body.
const replaceFence = { name: '0002_replace_fence.sql', sql: `CREATE TRIGGER IF NOT EXISTS custody_insert BEFORE INSERT ON custody_states WHEN EXISTS(SELECT 1 FROM custody_states WHERE job_id=NEW.job_id OR rowid=NEW.rowid) BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER IF NOT EXISTS "job_reuse" BEFORE INSERT ON "jobs" WHEN EXISTS(SELECT 1 FROM jobs WHERE id=NEW.id) BEGIN SELECT RAISE(ABORT,'JOB_ID_REUSED; END'); END;
CREATE TRIGGER IF NOT EXISTS sources_replace BEFORE INSERT ON sources BEGIN UPDATE custody_states SET revision=revision+1 WHERE job_id IN (SELECT job_id FROM sources WHERE id=NEW.id); UPDATE custody_states SET revision=revision+1 WHERE job_id=NEW.job_id; END;
DROP TRIGGER IF EXISTS sources_touch;
CREATE TRIGGER sources_touch BEFORE UPDATE ON main.sources BEGIN UPDATE custody_states SET revision=revision+1 WHERE job_id IN (OLD.job_id,NEW.job_id); END;` };
function custodySource(migrations) {
  const db = database(migrations);
  db.exec("INSERT INTO jobs VALUES('j1'),('j2'); INSERT INTO custody_states VALUES('j1',3),('j2',1); INSERT INTO sources VALUES('s1','j1'),('s2','j2')");
  return db;
}

const state = { name: '0001_state.sql', sql: `CREATE TABLE data_state(id TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE queued(id TEXT PRIMARY KEY,state TEXT NOT NULL);` };
const emptyUpdate = { name: '0002_empty_update.sql', sql: "UPDATE queued SET state=(SELECT value FROM data_state WHERE id='mode');" };
function stateSource({ queued = false } = {}) {
  const db = database([state]);
  db.exec("INSERT INTO data_state VALUES('mode','ready'),('other','carried')");
  if (queued) db.exec("INSERT INTO queued VALUES('q1','waiting')");
  return db;
}
const guardedInsert = { name: '0002_guarded_insert.sql', sql: `CREATE TABLE accepted(id TEXT PRIMARY KEY);
CREATE TRIGGER accepted_guard BEFORE INSERT ON accepted WHEN EXISTS(SELECT 1 FROM data_state WHERE id='mode' AND value<>'ready') BEGIN
 SELECT RAISE(ABORT,'STATE_NOT_READY');
END;
INSERT INTO accepted VALUES('admitted');` };
const viewInsert = { name: '0002_view_insert.sql', sql: `CREATE VIEW carried_state AS SELECT id,value FROM data_state;
CREATE TABLE snapshots(id TEXT PRIMARY KEY,value TEXT NOT NULL);
INSERT INTO snapshots(id,value) SELECT id,value FROM carried_state;` };
const externalViewInsert = { name: '0002_external_view.sql', sql: `CREATE TABLE local_state(id TEXT PRIMARY KEY);
CREATE VIEW carried_state AS SELECT d.id,d.value FROM data_state d JOIN local_state l ON l.id=d.id;
CREATE TABLE snapshots(id TEXT PRIMARY KEY,value TEXT NOT NULL);
INSERT INTO snapshots(id,value) SELECT id,value FROM carried_state;` };

const entriesDefinition = "CREATE TABLE entries(code TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('old','kept')))";
const entries = { name: '0001_entries.sql', sql: `${entriesDefinition}; CREATE TABLE companion(id TEXT PRIMARY KEY);` };
function rebuildEntries(name, definition = entriesDefinition.replace("'kept'", "'kept','new'"), columns = 'code,kind', copy = 'rowid AS original_rowid,*') {
  const rowid = copy.includes('original_rowid');
  return { name, sql: `CREATE TABLE entries_copy AS SELECT ${copy} FROM entries;
DROP TABLE entries;
${definition};
INSERT INTO entries(${rowid ? 'rowid,' : ''}${columns}) SELECT ${rowid ? 'original_rowid,' : ''}${columns} FROM entries_copy;
DROP TABLE entries_copy;` };
}
const entryRows = db => db.prepare('SELECT rowid,code,kind FROM entries ORDER BY rowid').all().map(row => ({ ...row }));
const entryDefinition = db => db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='entries'").get().sql;

test("restore admits compatible triggers and rebuilds while refusing archived-row rewrites", async t => {
  const foldedCases = [];
foldedCases.push(['trigger-only migrations admit archives that predate them and restore every row exactly', async () => {
  // An archive without recorded migrations (placed by its schema prefix).
  const source = database([reads], { ledger: false });
  source.exec("INSERT INTO message_history VALUES('m1','c1'),('m2','c2'); INSERT INTO reads VALUES('c1','u1',10),('c2','u1',20); INSERT INTO thread_reads VALUES('m1','u2')");
  const nook = await roundTrip([reads, generations], source, ['message_history', 'reads', 'thread_reads']);
  assert.equal(nook.bundle.manifest.migrations, undefined);
  assert.deepEqual(rows(nook.target, ['read_generations', 'read_undo']), { read_generations: [], read_undo: [] });
  nook.target.exec("INSERT INTO reads VALUES('c3','u1',30)");
  assert.deepEqual(rows(nook.target, ['read_generations']), { read_generations: [{ conversation: 'c3', user: 'u1', generation: 1 }] });

  // An archive recording its migrations, with the destination's schema identity.
  const oncall = await roundTrip([custody, replaceFence], custodySource([custody]), ['jobs', 'custody_states', 'sources']);
  assert.deepEqual(oncall.bundle.manifest.migrations, [custody.name]);
  assert.throws(() => oncall.target.exec("INSERT INTO jobs VALUES('j1')"), /JOB_ID_REUSED/);
  oncall.target.exec("UPDATE sources SET job_id='j2' WHERE id='s1'");
  assert.deepEqual(oncall.target.prepare('SELECT revision FROM custody_states ORDER BY job_id').all().map(row => row.revision), [4, 2]);

  // A RAISE-only guard can read carried data without making this INSERT a
  // writer of that data. The migration's seeded row must survive finalize.
  const guardedSource = stateSource(), guarded = await roundTrip([state, guardedInsert], guardedSource, ['data_state', 'queued']);
  assert.deepEqual(rows(guarded.target, ['accepted']), { accepted: [{ id: 'admitted' }] });
  assert.deepEqual(guarded.status.bridged.replayed, [{ migration: guardedInsert.name, statement: 2, table: 'accepted', rows: 1 }]);
  guarded.target.exec("UPDATE data_state SET value='blocked' WHERE id='mode'");
  assert.throws(() => guarded.target.exec("INSERT INTO accepted VALUES('denied')"), /STATE_NOT_READY/);
}]);
foldedCases.push(['later migrations that rewrite archived rows, directly, through a trigger or past an unbounded trigger, stay refused', async (t) => {
  const bundle = await archive(await service(custodySource([custody]), [custody]));
  const refusals = [
    { name: '0002_backfill.sql', sql: 'UPDATE custody_states SET revision=revision+1;' },
    { name: '0002_purge.sql', sql: "DELETE FROM sources WHERE job_id='j2';" },
    { name: '0002_audit.sql', sql: `CREATE TABLE audit(id TEXT PRIMARY KEY);
CREATE TRIGGER audit_touch AFTER INSERT ON audit BEGIN UPDATE custody_states SET revision=revision+1; END;
INSERT INTO audit VALUES('a1');` },
    // A trigger glued to the statement after it, as a splitter that missed its END would hand it over.
    { name: '0002_glued.sql', statements: ["CREATE TRIGGER audit_touch AFTER DELETE ON jobs BEGIN SELECT 1; END; UPDATE custody_states SET revision=0"] },
  ];
  await runCases(t, Array.from(refusals, (later, rowIndex) => [`${t.name}: later row ${rowIndex + 1}`, async t => {
    const migrations = [custody, later], target = database(migrations);
    await assert.rejects((await service(target, migrations)).imports.create(bundle.manifest), new RegExp('schema_mismatch:migration_data:' + later.name));
    assert.deepEqual(rows(target, ['jobs', 'custody_states', 'sources']), { jobs: [], custody_states: [], sources: [] });
}]));

  // The same UPDATE admitted for a row-less archive cannot skip an archived row.
  const filled = stateSource({ queued: true }), filledBundle = await archive(await service(filled, [state]));
  const updated = database([state, emptyUpdate]);
  await assert.rejects((await service(updated, [state, emptyUpdate])).imports.create(filledBundle.manifest), /schema_mismatch:migration_data:0002_empty_update\.sql/);
  assert.deepEqual(rows(updated, ['data_state', 'queued']), { data_state: [], queued: [] });

  const entriesSource = database([entries]);
  entriesSource.exec("INSERT INTO entries(rowid,code,kind) VALUES(-7,'alpha','old'),(21,'beta','kept'); INSERT INTO companion VALUES('carried')");
  const entriesBundle = await archive(await service(entriesSource, [entries]));
  await runCases(t, Array.from([
    rebuildEntries('0002_missing_column.sql', 'CREATE TABLE entries(code TEXT NOT NULL)', 'code'),
    rebuildEntries('0002_changed_column.sql', entriesDefinition.replace('code TEXT', 'code INTEGER')),
    rebuildEntries('0002_rejected_check.sql', entriesDefinition.replace("'old','kept'", "'old','new'")),
  ], (later, rowIndex) => [`${t.name}: later row ${rowIndex + 1}`, async t => {
    const migrations = [entries, later], destination = database(migrations), definition = entryDefinition(destination);
    // Before rebuild admission this fails at placement; once admitted, the
    // incompatible column or CHECK must still refuse the whole public restore.
    await assert.rejects(restore(await service(destination, migrations), entriesBundle), /schema_mismatch:(?:migration_data|columns|definition):|CHECK constraint/);
    assert.deepEqual(rows(destination, ['companion', 'entries']), { companion: [], entries: [] }, later.name);
    assert.equal(entryDefinition(destination), definition);
}]));
}]);
foldedCases.push(['an archive predating a guard and a view restores past triggers holding CASE ... END; archived rewrites and unreadable chunks stay refused', async t => {
  const source = database([knowledge, search]);
  source.exec("INSERT INTO pages VALUES('p1','w1','page'),('r1','w1','record'); INSERT INTO page_blocks VALUES('b1','p1','Hello'),('b2','r1','Fields')");
  const exported = await archive(await service(source, [knowledge, search], searchPolicy));
  const bundle = await legacyAssertions(exported, source);
  assert.deepEqual(bundle.manifest.migrations, [knowledge.name, search.name]);
  const migrations = [knowledge, search, door], target = database(migrations), before = triggers(target);
  const restored = await restore(await service(target, migrations, searchPolicy), bundle);
  assert.equal(restored.phase, 'complete');
  assert.deepEqual(restored.skippedTables, ['ik_d1_assertions']);
  assert.ok(!exported.manifest.tables.some(table => table.name === 'ik_d1_assertions'));
  assert.ok(!exported.parts.some(part => part.items.some(item => item.table === 'ik_d1_assertions')));
  assert.deepEqual(rows(target, ['ik_d1_assertions']), { ik_d1_assertions: [] });
  assert.deepEqual(rows(target, ['pages', 'page_blocks', 'door_plans']), { ...rows(source, ['pages', 'page_blocks']), door_plans: [] });
  assert.deepEqual(triggers(target), before);
  target.exec("UPDATE page_blocks SET body='Edited' WHERE id='b2'");
  assert.deepEqual(rows(target, ['search_dirty']), { search_dirty: [{ key: 'record:r1', workspace_id: 'w1' }] });

  const corrupt = await legacyAssertions(exported, source, [1]);
  const destination = database(migrations);
  await assert.rejects(restore(await service(destination, migrations, searchPolicy), corrupt), /invalid_bookkeeping_rows:ik_d1_assertions/);
  assert.deepEqual(rows(destination, ['pages', 'page_blocks', 'ik_d1_assertions']), { pages: [], page_blocks: [], ik_d1_assertions: [] });

  const refusals = [
    [{ name: '0003_door.sql', sql: `${door.sql}\nUPDATE pages SET page_kind='page' WHERE page_kind='record';` }, /schema_mismatch:migration_data:0003_door\.sql/],
    // SQLite runs a statement ending in an open block comment; Base cannot read where it ends.
    [{ name: '0003_open.sql', statements: ['CREATE INDEX pages_kind ON pages(page_kind); /* left open'] }, /generated_sql/],
  ];
  await runCases(t, Array.from(refusals, ([later, refusal], rowIndex) => [`${t.name}: [later, refusal] row ${rowIndex + 1}`, async t => {
    const list = [knowledge, search, later], destination = database(list);
    await assert.rejects((await service(destination, list, searchPolicy)).imports.create(bundle.manifest), refusal, later.name);
    assert.deepEqual(rows(destination, ['pages', 'page_blocks']), { pages: [], page_blocks: [] });
}]));

  // An UPDATE of a carried table with no rows cannot alter the archive, even
  // when its expression reads another carried table that does have rows.
  const stateDb = stateSource();
  await runCases(t, [['a row-less target may read carried rows', async () => {
    await roundTrip([state, emptyUpdate], stateDb, ['data_state', 'queued']);
  }]]);

  // The view itself has no archived rows. Resolve its carried base table and
  // replay the INSERT after restoring it, rather than silently leaving it empty.
  await runCases(t, [['a replay resolves every view dependency', async () => {
    const throughView = await roundTrip([state, viewInsert], stateDb, ['data_state', 'queued']);
    assert.deepEqual(rows(throughView.target, ['snapshots']), { snapshots: rows(stateDb, ['data_state']).data_state });

  // A view's complete dependency set matters: this one also reads a table
  // absent from the archive, so it cannot be replayed from carried rows alone.
    const viewTarget = database([state, externalViewInsert]);
    await assert.rejects((await service(viewTarget, [state, externalViewInsert])).imports.create(throughView.bundle.manifest), /schema_mismatch:migration_data:0002_external_view\.sql/);
    assert.deepEqual(rows(viewTarget, ['data_state', 'queued', 'local_state', 'snapshots']), { data_state: [], queued: [], local_state: [], snapshots: [] });
  }]]);
}]);
foldedCases.push(['a five-statement CHECK widening rebuild preserves the destination definition and every archived rowid', async (t) => {
  const logged = { name: '0003_entry_log.sql', sql: `CREATE TABLE entry_log(code TEXT NOT NULL,kind TEXT NOT NULL);
INSERT INTO entry_log(code,kind) SELECT code,kind FROM entries;
CREATE TRIGGER entry_logged AFTER INSERT ON entries BEGIN INSERT INTO entry_log VALUES(NEW.code,NEW.kind); END;` };
  await runCases(t, Array.from([[false, '*'], [false, 'code,kind'], [false, 'rowid AS original_rowid,*'], [true, 'rowid AS original_rowid,*'], [false, 'rowid AS original_rowid,code,kind'], [true, 'rowid AS original_rowid,code,kind']], ([populated, copy], rowIndex) => [`${t.name}: [populated, copy] row ${rowIndex + 1}`, async t => {
    const wider = rebuildEntries('0002_wider_check.sql', undefined, undefined, copy);
    const source = database([entries]);
    if (populated) source.exec("INSERT INTO entries(rowid,code,kind) VALUES(-11,'alpha','old'),(4,'beta','kept'),(29,'gamma','old'); INSERT INTO companion VALUES('carried')");
    const bundle = await archive(await service(source, [entries]));
    const migrations = [entries, wider, logged], target = database(migrations), definition = entryDefinition(target);
    assert.equal((await restore(await service(target, migrations), bundle)).phase, 'complete');
    assert.equal(entryDefinition(target), definition);
    assert.deepEqual(entryRows(target), entryRows(source));
    assert.deepEqual(rows(target, ['companion']), rows(source, ['companion']));
    assert.deepEqual(rows(target, ['entry_log']).entry_log, rows(source, ['entries']).entries);
    assert.equal(target.prepare("SELECT name FROM sqlite_master WHERE name='entries_copy'").get(), undefined);
    target.exec("INSERT INTO entries(code,kind) VALUES('after','new')");
    assert.throws(() => target.exec("INSERT INTO entries(code,kind) VALUES('invalid','unknown')"), /CHECK constraint/);
}]));
}]);
  await runCases(t, foldedCases);
});



// Like a search capacity migration: triggers feeding an excluded queue whose
// bodies start `SELECT CASE ... END||p.id`. Wrangler's splitter misses their
// END and hands them over glued to each other and to the backfill after them.
const searchPolicy = { product: 'trigger-migrations', excludeTables: ['search_dirty'] };
const knowledge = { name: '0001_knowledge.sql', sql: `CREATE TABLE pages(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,page_kind TEXT NOT NULL);
CREATE TABLE page_blocks(id TEXT PRIMARY KEY,page_id TEXT NOT NULL,body TEXT NOT NULL);
CREATE TABLE ik_d1_assertions(ok INTEGER NOT NULL CHECK(ok=1));` };
const dirty = "INSERT INTO search_dirty SELECT CASE WHEN p.page_kind='record' THEN 'record:' ELSE 'page:' END||p.id,p.workspace_id FROM pages p WHERE p.id=NEW.page_id ON CONFLICT(key) DO NOTHING;";
const search = { name: '0002_search.sql', sql: `CREATE TABLE search_dirty(key TEXT PRIMARY KEY,workspace_id TEXT NOT NULL);
CREATE TRIGGER search_pages_insert AFTER INSERT ON pages BEGIN INSERT INTO search_dirty VALUES(CASE WHEN NEW.page_kind='record' THEN 'record:' ELSE 'page:' END||NEW.id,NEW.workspace_id) ON CONFLICT(key) DO NOTHING; END;
CREATE TRIGGER search_page_blocks_insert AFTER INSERT ON page_blocks BEGIN ${dirty} END;
CREATE TRIGGER search_page_blocks_update AFTER UPDATE ON page_blocks BEGIN ${dirty} END;
INSERT INTO search_dirty SELECT CASE WHEN page_kind='record' THEN 'record:' ELSE 'page:' END||id,workspace_id FROM pages;` };
// Like an import door: a guard that fails the migration while an old unique
// index exists, writing only an excluded assertions table, then a new table and a view of it.
const door = { name: '0003_door.sql', sql: `INSERT INTO ik_d1_assertions(ok) SELECT 0 WHERE EXISTS(SELECT 1 FROM pragma_index_list('door_plans') l WHERE l."unique"=1 AND (SELECT group_concat(name) FROM pragma_index_info(l.name))='page_id,id');
CREATE TABLE IF NOT EXISTS door_plans(id TEXT PRIMARY KEY,page_id TEXT NOT NULL);
CREATE VIEW door_plan_pages AS SELECT id,page_id FROM door_plans;` };

// Reproduce a valid version-two archive from before guard bookkeeping was
// excluded, including the original schema and full archive integrity binding.
async function legacyAssertions(exported, source, values = []) {
  const manifest = structuredClone(exported.manifest), name = 'ik_d1_assertions';
  const sql = source.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(name).sql;
  const columns = source.prepare(`PRAGMA table_info(${name})`).all().map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk }));
  manifest.tables = [...manifest.tables.filter(table => table.name !== name), { name, sql, columns, dependencies: [], rowidAlias: 'rowid', count: values.length }].sort((a, b) => a.name < b.name ? -1 : 1);
  manifest.excludedTables = manifest.excludedTables.filter(table => table !== name);
  manifest.schema = await sha256(canonicalJson(manifest.tables.map(({ name, sql }) => ({ name, sql }))));
  const items = [...values.map((ok, index) => ({ kind: 'row', table: name, index, rowid: index + 1, row: { ok } })), ...exported.parts.flatMap(part => part.items).filter(item => item.table !== name)];
  const parts = [await makePart(0, items)]; manifest.partCount = parts.length;
  const content = new ContentVerifier(manifest), integrity = new ArchiveVerifier(manifest);
  for (const part of parts) { integrity.add(part); for (const item of part.items) content.add(item); }
  return { manifest, parts, closing: { kind: 'closing', partCount: parts.length, contentHash: content.digest(), archiveHash: integrity.digest() } };
}
