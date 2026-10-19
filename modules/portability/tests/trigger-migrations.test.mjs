import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { createPortability, readArchive } from '../index.mjs';
import { migrationReplay } from '../migration-history.mjs';

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
const plan = migrations => migrations.map(({ name, sql, statements }) => ({ name, statements: statements ?? split(sql) }));
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
const service = (db, migrations) => createPortability({ db: binding(db), policy, migrations: async () => migrationReplay(plan(migrations), policy) });
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
  assert.equal((await restore(await service(target, migrations), bundle)).phase, 'complete');
  assert.deepEqual(rows(target, tables), rows(source, tables));
  assert.deepEqual(triggers(target), before);
  return { bundle, target };
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

test('trigger-only migrations admit archives that predate them and restore every row exactly', async () => {
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
});

test('later migrations that rewrite archived rows, directly, through a trigger or past an unbounded trigger, stay refused', async () => {
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
  for (const later of refusals) {
    const migrations = [custody, later], target = database(migrations);
    await assert.rejects((await service(target, migrations)).imports.create(bundle.manifest), new RegExp('schema_mismatch:migration_data:' + later.name));
    assert.deepEqual(rows(target, ['jobs', 'custody_states', 'sources']), { jobs: [], custody_states: [], sources: [] });
  }
});
