import test from 'node:test';
import { caseRow, caseRows } from './fold-case.mjs';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { validateMigrations, migrate } from '../migrations.mjs';
import { ledgerShapeQuery, migrationLedgerShape } from '../migration-ledger.mjs';
import { hash } from '../validation.mjs';
import { cloudflare } from '../provider.mjs';
import { providerFixture } from './provider-fixture.mjs';

const admissionRows = [];
const admission = (name, run) => admissionRows.push({name,run});

const migration = (sql, name = '0001_schema.sql') => ({ name, sql, sha256: hash(sql) });
const validate = sql => validateMigrations([migration(sql)]);
const trigger = `CREATE TRIGGER record_change AFTER INSERT ON source
  WHEN CASE WHEN NEW.value > 0 THEN 1 ELSE 0 END
  BEGIN
    INSERT INTO audit(value) VALUES (
      CASE WHEN NEW.value = 1 THEN CASE WHEN NEW.value > 0 THEN 11 ELSE 12 END ELSE 20 END
    );
    UPDATE audit SET message = 'BEGIN; COMMIT; END; it''s a string /* not a comment */';
  END;`;
const schema = 'CREATE TABLE source(value INTEGER); CREATE TABLE audit(value INTEGER, message TEXT);';

function database(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  return db;
}

admission('SQLite executes nested CASE triggers, multiple body statements and SQL after the trigger', t => {
  const db = database(t);
  const sql = `${schema}\n${trigger}\nINSERT INTO source VALUES (1);`;
  validate(sql);
  db.exec(sql);
  assert.deepEqual({ ...db.prepare('SELECT * FROM audit').get() }, {
    value: 11, message: "BEGIN; COMMIT; END; it's a string /* not a comment */",
  });
});

admission('temporary and quoted trigger names, comments and unterminated-final-semicolon syntax execute', t => {
  const db = database(t);
  const sql = `${schema}
    -- BEGIN; COMMIT; ROLLBACK; _rer_deploy_migrations
    /* CREATE TRIGGER fake BEGIN; END; d1_migrations */
    CREATE TEMP TRIGGER IF NOT EXISTS "semi;END" AFTER INSERT ON source
      BEGIN INSERT INTO audit(value) VALUES (NEW.value); END;
    CREATE TEMPORARY TRIGGER [bracket;BEGIN] AFTER UPDATE ON source
      BEGIN UPDATE audit SET value = NEW.value; END`;
  validate(sql);
  db.exec(sql);
  db.exec('INSERT INTO source VALUES (4); UPDATE source SET value = 9;');
  assert.equal(db.prepare('SELECT value FROM audit').get().value, 9);
});

admission('control words inside quoted identifiers and strings remain ordinary application data', t => {
  const db = database(t);
  const sql = `CREATE TABLE "BEGIN" ([COMMIT] TEXT, \`ROLLBACK\` TEXT, "quote"";END" TEXT);
    INSERT INTO "BEGIN" VALUES ('ATTACH; VACUUM; SAVEPOINT; DETACH', 'END; RELEASE', 'it''s -- a /* literal */');`;
  validate(sql);
  db.exec(sql);
  assert.equal(db.prepare('SELECT [COMMIT] FROM "BEGIN"').get().COMMIT, 'ATTACH; VACUUM; SAVEPOINT; DETACH');
});

const controls = [
  'BEGIN', 'BEGIN IMMEDIATE', 'BEGIN EXCLUSIVE TRANSACTION', 'COMMIT', 'END', 'END TRANSACTION',
  'ROLLBACK', 'ROLLBACK TRANSACTION TO SAVEPOINT batch', 'SAVEPOINT batch', 'RELEASE SAVEPOINT batch',
  "ATTACH DATABASE ':memory:' AS other", 'DETACH DATABASE other', 'VACUUM', "VACUUM INTO 'copy.db'",
];
for (const control of controls) {
  admission(`refuses executable ${control} before and after CASE triggers`, () => {
    for (const prefix of ['', `${schema}\n`, `${schema}\n${trigger}\n`, `${schema}\n${trigger}\n${trigger.replace('record_change', 'another_change')}\n`]) {
      assert.throws(() => validate(`${prefix}; /* boundary */ ${control.toLowerCase()};`), /unsafe-migration-control/);
    }
  });
}

admission('a real COMMIT after a trigger would escape a SQLite transaction, and validation prevents it', t => {
  const db = database(t);
  db.exec('BEGIN;');
  assert.equal(db.isTransaction, true);
  const sql = `${schema}${trigger} COMMIT;`;
  assert.throws(() => validate(sql), /unsafe-migration-control/);
  db.exec(sql);
  assert.equal(db.isTransaction, false);
});

for (const name of ['_rer_deploy_migrations', 'd1_migrations']) {
  admission(`reserves ${name} across SQLite name quoting and schema qualification`, async t => {
  await caseRows(t, [['independent checks', async t => {
    const db = database(t);
    db.exec(`CREATE TABLE ${name}(value INTEGER); INSERT INTO ${name} VALUES (7);`);
    let rowAt93 = 0;
  for (const quoted of [name, name.toUpperCase(), `"${name}"`, `[${name}]`, `\`${name}\``, `'${name}'`]) {
    await caseRow(t, 'table at line 93 row ' + rowAt93++, async () => {

      let rowAt94 = 0;
  for (const reference of [quoted, `main.${quoted}`, `"main"./* schema boundary */${quoted}`]) {
    await caseRow(t, 'table at line 94 row ' + rowAt94++, async () => {

        const sql = `SELECT value FROM ${reference};`;
        assert.equal(db.prepare(sql).get().value, 7, reference);
        assert.throws(() => validate(sql), /unsafe-migration-control/, reference);
        for (const mutation of [
          `UPDATE ${reference} SET value=8;`, `DELETE FROM ${reference};`,
          `DROP TABLE ${reference};`, `ALTER TABLE ${reference} RENAME TO stolen;`,
        ]) assert.throws(() => validate(mutation), /unsafe-migration-control/, mutation);
          });
  }
      await caseRow(t, 'following assertion at line 103', async () => { assert.throws(() => validate(`CREATE TABLE source(value); CREATE TRIGGER attack AFTER INSERT ON source BEGIN DELETE FROM ${quoted}; END;`), /unsafe-migration-control/); });
      await caseRow(t, 'following assertion at line 104', async () => { assert.throws(() => validate(`ALTER TABLE source RENAME TO ${quoted};`), /unsafe-migration-control/); });
        });
  }
    // Single quotes can become identifiers in SQLite, so the exact reserved
    // names are conservatively unavailable even as string values.
    await caseRow(t, 'following assertion at line 108', async () => { assert.throws(() => validate(`SELECT '${name}';`), /unsafe-migration-control/); });
    validate(`SELECT 'documentation mentions ${name} here'; -- ${name}\n`);
    }]]);
});
}

admission('incomplete quotes/comments/triggers and NUL cannot swallow controller completion SQL', () => {
  for (const sql of [
    "SELECT 'open", 'SELECT "open', 'SELECT [open', 'SELECT `open', 'SELECT 1; /* open',
    'SELECT 1;\0COMMIT;', `${schema}CREATE TRIGGER incomplete AFTER INSERT ON source BEGIN SELECT 1;`,
    `${schema}CREATE TRIGGER incomplete AFTER INSERT ON source;`,
  ]) assert.throws(() => validate(sql), /unsafe-migration-control/);
});

test('trigger migration preserves controller claims, applied hashes and no-op replay semantics', async t => {
  const fixture = providerFixture();
  t.after(() => fixture.close());
  const api = cloudflare(fixture);
  const resource = await api.request('/d1/database', { method: 'POST', body: { name: 'trigger-proof' } });
  const migrations = [migration(schema), migration(trigger, '0002_trigger.sql')];
  const first = await migrate(api, resource.uuid, migrations);
  assert.deepEqual(first.applied, migrations.map(row => row.name));
  const db = fixture.state.databases[0].db;
  db.exec('INSERT INTO source VALUES (1);');
  assert.equal(db.prepare('SELECT value FROM audit').get().value, 11);
  assert.deepEqual(db.prepare('SELECT name, sha256, state FROM d1_migrations ORDER BY id').all().map(row => ({ ...row })),
    migrations.map(({ name, sha256 }) => ({ name, sha256, state: 'applied' })));
  const writes = fixture.state.writes.length;
  assert.deepEqual((await migrate(api, resource.uuid, migrations)).applied, []);
  assert.equal(fixture.state.writes.length, writes);
});

// Seed recovery code checks the ledger before reading it. Every ledger a
// deployment can hold passes the shared check: a fresh kit deploy's, Wrangler's
// own, Wrangler's after a kit deploy adopted it, and a rer 0.2.1 deploy's,
// alone or beside Wrangler's. Any other shape is refused.
test('migrationLedgerShape accepts the kit, Wrangler, adopted and 0.2.1 ledgers and refuses any other', async t => {
  const fixture = providerFixture();
  t.after(() => fixture.close());
  const api = cloudflare(fixture);
  const migrations = [migration(schema)];
  const wranglerLedger = 'CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)';
  const deployment = async (name, before) => {
    const resource = await api.request('/d1/database', { method: 'POST', body: { name } });
    const db = fixture.state.databases.at(-1).db;
    if (before) db.exec(before);
    return { resource, db, shape: () => migrationLedgerShape(db.prepare(ledgerShapeQuery).all()) };
  };
  const kit = await deployment('kit');
  await migrate(api, kit.resource.uuid, migrations);
  assert.deepEqual(kit.shape(), { name: 'd1_migrations', columns: ['id', 'name', 'applied_at', 'sha256', 'state'], shape: 'kit' });
  const wrangler = await deployment('wrangler', wranglerLedger);
  assert.deepEqual(wrangler.shape(), { name: 'd1_migrations', columns: ['id', 'name', 'applied_at'], shape: 'wrangler' });
  await migrate(api, wrangler.resource.uuid, migrations);
  assert.deepEqual(wrangler.shape(), { name: 'd1_migrations', columns: ['id', 'name', 'applied_at', 'sha256', 'state'], shape: 'adopted' });
  const other = await deployment('other', wranglerLedger + '; ALTER TABLE d1_migrations ADD COLUMN note TEXT');
  assert.throws(() => other.shape(), /invalid-migration-ledger/);
  // The statements rer 0.2.1's migrate() ran for one migration on a new database.
  const [applied] = migrations;
  const deployed021 = `CREATE TABLE _rer_deploy_migrations (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('applying','applied')));
    INSERT INTO _rer_deploy_migrations(name,sha256,state) VALUES ('${applied.name}','${applied.sha256}','applying');
    ${applied.sql}; UPDATE _rer_deploy_migrations SET state='applied' WHERE name='${applied.name}' AND sha256='${applied.sha256}';`;
  const legacy = { name: '_rer_deploy_migrations', columns: ['name', 'sha256', 'state'], shape: 'legacy' };
  const old = await deployment('0.2.1', deployed021);
  assert.deepEqual(old.shape(), legacy);
  const beside = await deployment('0.2.1-over-wrangler', `${wranglerLedger}; ${deployed021}`);
  assert.deepEqual(beside.shape(), legacy, 'the kit ledger is the history, not the stale Wrangler table');
  await migrate(api, old.resource.uuid, migrations);
  assert.equal(old.shape().shape, 'kit', 'the next deploy moves it into d1_migrations');
  const widened = await deployment('0.2.1-widened', deployed021 + ' ALTER TABLE _rer_deploy_migrations ADD COLUMN note TEXT;');
  assert.throws(() => widened.shape(), /invalid-migration-ledger/);
});

admission('conflict and trigger ROLLBACK policies cannot implicitly end the provider transaction', t => {
  const db = database(t);
  db.exec('CREATE TABLE unique_values(value INTEGER UNIQUE); INSERT INTO unique_values VALUES (1); BEGIN;');
  const conflict = 'INSERT OR ROLLBACK INTO unique_values VALUES (1);';
  assert.throws(() => validate(conflict), /unsafe-migration-control/);
  assert.throws(() => db.exec(conflict), /UNIQUE/);
  assert.equal(db.isTransaction, false);
  for (const sql of [
    'CREATE TABLE danger(value INTEGER UNIQUE ON CONFLICT ROLLBACK);',
    "CREATE TRIGGER danger BEFORE INSERT ON unique_values BEGIN SELECT RAISE(ROLLBACK, 'denied'); END;",
    'UPDATE OR ROLLBACK unique_values SET value = 1;',
  ]) assert.throws(() => validate(sql), /unsafe-migration-control/);
});

admission('exact ledger tokens remain reserved even when SQLite would return them as data', t => {
  const db = database(t);
  for (const query of [
    "SELECT '_rer_deploy_migrations', 'd1_migrations';",
    "SELECT coalesce(NULL, '_rer_deploy_migrations');",
    "SELECT 'd1_migrations' IS NOT DISTINCT FROM 'd1_migrations';",
  ]) {
    assert.doesNotThrow(() => db.prepare(query).get());
    assert.throws(() => validate(query), /unsafe-migration-control/);
  }
});

admission('legacy quoted ledger relations cannot hide after FROM commas, joins or nested table groups', t => {
  const db = database(t);
  db.exec(`${schema} INSERT INTO source VALUES (1);`);
  for (const name of ['_rer_deploy_migrations', 'd1_migrations']) {
    db.exec(`CREATE TABLE ${name}(secret); INSERT INTO ${name} VALUES ('controller');`);
    for (const reference of [`'${name}'`, `main.'${name}'`, `'main'.'${name.toUpperCase()}'`]) {
      for (const query of [
        `SELECT secret FROM source, ${reference};`,
        `SELECT secret FROM source AS s, /* relation */ ${reference} AS ledger;`,
        ...['WINDOW', 'BEGIN', 'WITH'].flatMap(alias => [
          `SELECT secret FROM source AS ${alias}, ${reference};`,
          `SELECT secret FROM source ${alias}, ${reference};`,
        ]),
        `SELECT secret FROM source JOIN ${reference} ON 1;`,
        `SELECT secret FROM source, (${reference});`,
        `SELECT secret FROM (source, (${reference}));`,
        `SELECT secret FROM source, (SELECT secret FROM source, ${reference});`,
        `SELECT secret FROM source JOIN source AS s ON coalesce(1, 2), ${reference};`,
        `SELECT secret FROM source JOIN source AS s ON CASE WHEN 1 THEN 1 ELSE 0 END, ${reference};`,
      ]) {
        assert.equal(db.prepare(query).get().secret, 'controller', query);
        assert.throws(() => validate(query), /unsafe-migration-control/, query);
      }
    }
  }
});

admission('legacy single quotes remain ledger identifiers in writes, DDL and trigger targets', async t => {
  await caseRows(t, [['independent checks', async t => {
  const db = database(t);
  db.exec(schema);
  for (const name of ['_rer_deploy_migrations', 'd1_migrations']) {
    db.exec(`CREATE TABLE ${name}(value);`);
    let rowAt238 = 0;
  for (const reference of [`'${name}'`, `main.'${name}'`, `'main'.'${name}'`]) {
    await caseRow(t, 'table at line 238 row ' + rowAt238++, async () => {

      for (const sql of [
        `INSERT INTO ${reference} VALUES (1);`,
        `REPLACE INTO ${reference} VALUES (1);`,
        `UPDATE OR ABORT ${reference} SET value = 2;`,
        `CREATE TABLE IF NOT EXISTS ${reference}(value);`,
        `CREATE TRIGGER guard AFTER INSERT ON ${reference} BEGIN SELECT 1; END;`,
      ]) {
        assert.doesNotThrow(() => db.prepare(sql), sql);
        assert.throws(() => validate(sql), /unsafe-migration-control/, sql);
      }
        });
  }
    for (const sql of [
      `CREATE INDEX lookup ON '${name}'(value);`,
      `CREATE TABLE child(value REFERENCES '${name}'(value));`,
      `CREATE VIEW '${name}' AS SELECT 1;`,
      `CREATE INDEX '${name}' ON source(value);`,
      `ALTER TABLE source RENAME TO '${name}';`,
      `CREATE TRIGGER write_ledger AFTER INSERT ON source BEGIN INSERT INTO '${name}' VALUES (1); END;`,
      `CREATE TRIGGER read_ledger AFTER INSERT ON source BEGIN SELECT * FROM source, main.'${name}'; END;`,
    ]) assert.throws(() => validate(sql), /unsafe-migration-control/, sql);
  }
  }]]);
});

admission('incomplete or crossing CASE and parenthesis scopes never become a trigger terminator', t => {
  const db = database(t);
  db.exec(schema);
  for (const sql of [
    'CREATE TRIGGER bad AFTER INSERT ON source BEGIN SELECT CASE WHEN 1 THEN 2; END;',
    'CREATE TRIGGER bad AFTER INSERT ON source BEGIN SELECT CASE WHEN 1 THEN end; END;',
    'CREATE TRIGGER bad AFTER INSERT ON source WHEN CASE WHEN NEW.value THEN NEW.end BEGIN SELECT 1; END;',
    'CREATE TRIGGER bad AFTER INSERT ON source BEGIN SELECT CASE WHEN 1 THEN 2 + end; END;',
    'CREATE TRIGGER bad AFTER INSERT ON source BEGIN SELECT CASE WHEN 1 THEN 2 COLLATE end; END;',
    'CREATE TRIGGER bad AFTER INSERT ON source BEGIN SELECT CASE WHEN 1 THEN CASE WHEN 1 THEN end END; END;',
    'CREATE TRIGGER bad AFTER INSERT ON source WHEN CASE WHEN NEW.value > 0 THEN 1 BEGIN SELECT 1; END;',
    'CREATE TRIGGER bad AFTER INSERT ON source WHEN CASE WHEN 1 THEN CASE WHEN 1 THEN 2 END BEGIN SELECT 1; END;',
    'CREATE TRIGGER bad AFTER INSERT ON source BEGIN SELECT CASE WHEN 1 THEN CASE WHEN 1 THEN 2 END; END;',
    'CREATE TRIGGER bad AFTER INSERT ON source BEGIN SELECT (CASE WHEN 1 THEN 2) END; END;',
    'CREATE TRIGGER bad AFTER INSERT ON source WHEN (NEW.value > 0 BEGIN SELECT 1; END;',
    'CREATE TRIGGER bad AFTER INSERT ON source BEGIN SELECT (1; END;',
  ]) {
    assert.throws(() => db.prepare(sql), /syntax|incomplete/, sql);
    assert.throws(() => validate(sql), /unsafe-migration-control/, sql);
  }
});

admission('END used as a SQLite result alias does not open or close an expression scope', t => {
  const db = database(t);
  const sql = `${schema}
    CREATE TRIGGER end_alias AFTER INSERT ON source
      BEGIN SELECT CASE WHEN 1 THEN 2 END END; END;
    INSERT INTO source VALUES (1);`;
  validate(sql);
  db.exec(sql);
  assert.equal(db.prepare('SELECT CASE WHEN 1 THEN 2 END END').get().END, 2);
});

admission('safe trigger SQL reaches the provider byte-for-byte before the completion marker', async t => {
  const fixture = providerFixture();
  t.after(() => fixture.close());
  const api = cloudflare(fixture);
  const resource = await api.request('/d1/database', { method: 'POST', body: { name: 'sql-bytes' } });
  const sql = `\uFEFF${schema}\r\n${trigger}\r\nINSERT INTO source VALUES (1);\r\nSELECT 'ledger audit data'; -- final comment`;
  const entry = migration(sql);
  await migrate(api, resource.uuid, [entry]);
  const batches = fixture.state.writes.filter(write => write.body?.sql?.startsWith('\uFEFF'));
  assert.equal(batches.length, 1);
  assert.equal(batches[0].body.sql, `${sql}\nUPDATE d1_migrations SET state='applied' WHERE name='${entry.name}' AND sha256='${entry.sha256}';`);
  assert.equal(entry.sha256, hash(sql));
  assert.equal(fixture.state.databases[0].db.prepare('SELECT value FROM audit').get().value, 11);
});

admission('CASE END distinguishes keyword identifiers from the expression terminator', t => {
  const db = database(t);
  const sql = `CREATE TABLE source(value, end); CREATE TABLE audit(value);
    CREATE TRIGGER end_column AFTER INSERT ON source
      WHEN CASE WHEN NEW.value THEN NEW.end END
      BEGIN INSERT INTO audit SELECT CASE WHEN 1 THEN end + 1. ELSE .5 END FROM source; END;
    INSERT INTO source VALUES (1, 2);`;
  validate(sql);
  db.exec(sql);
  assert.equal(db.prepare('SELECT value FROM audit').get().value, 3);
});

admission('END after OVER names a window and cannot close an unfinished CASE', t => {
  const db = database(t);
  const sql = `CREATE TABLE source(value);
    CREATE TRIGGER tr AFTER INSERT ON source
      BEGIN SELECT CASE WHEN 1 THEN count(*) OVER end; END;`;
  assert.throws(() => db.exec(sql), /near ";": syntax error/);
  assert.throws(() => validate(sql), /unsafe-migration-control/);
});

admission('a named END window and its separate CASE terminator execute in a trigger', t => {
  const db = database(t);
  const query = 'SELECT CASE WHEN 1 THEN count(*) OVER end END WINDOW end AS ()';
  const sql = `CREATE TABLE source(value);
    CREATE TRIGGER tr AFTER INSERT ON source BEGIN ${query}; END;
    INSERT INTO source VALUES (1);`;
  validate(sql);
  db.exec(sql);
  assert.deepEqual(Object.values(db.prepare(query).get()), [1]);
  assert.equal(db.prepare('SELECT value FROM source').get().value, 1);
});

admission('OVER remains an operand when used as a column or named window', t => {
  const db = database(t);
  const sql = `CREATE TABLE source(over); INSERT INTO source VALUES (7);`;
  validate(sql);
  db.exec(sql);
  for (const [query, expected] of [
    ['SELECT CASE WHEN 1 THEN over END FROM source', 7],
    ['SELECT CASE WHEN 1 THEN source.over END FROM source', 7],
    ['SELECT CASE WHEN 1 THEN count(*) OVER over END WINDOW over AS ()', 1],
  ]) {
    validate(query);
    assert.deepEqual(Object.values(db.prepare(query).get()), [expected]);
  }
});

admission('ledger tokens cannot be used as virtual-table content or introspection arguments', t => {
  const db = database(t);
  for (const name of ['_rer_deploy_migrations', 'd1_migrations']) {
    db.exec(`CREATE TABLE ${name}(name); INSERT INTO ${name} VALUES ('controller row');`);
    const shadow = `shadow${name}`;
    const virtual = `CREATE VIRTUAL TABLE ${shadow} USING fts5(name, content='${name}');`;
    db.exec(virtual);
    assert.equal(db.prepare(`SELECT name FROM ${shadow}`).get().name, 'controller row');
    assert.throws(() => validate(virtual), /unsafe-migration-control/);
    for (const query of [
      `PRAGMA table_info('${name}');`,
      `SELECT * FROM pragma_table_info('${name}');`,
    ]) {
      assert.equal(db.prepare(query).get().name, 'name');
      assert.throws(() => validate(query), /unsafe-migration-control/);
    }
  }
});

admission('BEGIN in a trigger name or header operand is distinct from the body boundary', t => {
  const db = database(t);
  const sql = `CREATE TABLE source(value, begin); CREATE TABLE audit(value);
    CREATE TRIGGER begin AFTER INSERT ON source
      WHEN CASE WHEN NEW.value THEN NEW.begin END
      BEGIN INSERT INTO audit VALUES (NEW.value); END;
    INSERT INTO source VALUES (3, 1);`;
  validate(sql);
  db.exec(sql);
  assert.equal(db.prepare('SELECT value FROM audit').get().value, 3);
  assert.throws(() => validate(`${sql} COMMIT;`), /unsafe-migration-control/);
});

test('migration SQL admission preserves application SQL and refuses controller transaction or ledger access', async (t) => {
  await caseRows(t, admissionRows.map(({name,run}) => [name,run]));
});
