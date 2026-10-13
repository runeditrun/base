import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, readMigrationRewrites, withRewrites } from '../migrations.mjs';
import { cloudflare } from '../provider.mjs';
import { hash } from '../validation.mjs';
import { providerFixture } from './provider-fixture.mjs';

const entry = sql => ({ name: '0001_schema.sql', sql, sha256: hash(sql) });
const schema = "CREATE TABLE source(value TEXT); INSERT INTO source VALUES ('retained');";
async function setup(t) {
  const fixture = providerFixture();
  t.after(() => fixture.close());
  const api = cloudflare(fixture);
  const resource = await api.request('/d1/database', { method: 'POST', body: { name: 'terminator-proof' } });
  return { fixture, api, id: resource.uuid, db: fixture.state.databases[0].db };
}

const cases = [
  ['terminated SQL', schema, ''],
  ['trailing line comment without newline', `${schema} -- final comment`, ''],
  ['trailing comment lines', `${schema}\n-- first comment\n-- final comment\n`, ''],
  ['trailing block comment', `${schema}\n/* comment with ; and UPDATE inside */`, ''],
  ['BOM and CRLF comments', `\uFEFF${schema}\r\n-- final comment\r\n`, ''],
  ['unterminated final SQL', `${schema}\nUPDATE source SET value='retained'`, '; '],
  ['unterminated SQL and line comment', `${schema}\nUPDATE source SET value='retained' -- final comment`, '; '],
  ['quoted semicolon', `${schema}\nSELECT ';'`, '; '],
  ['quoted identifier semicolon', `${schema}\nSELECT value AS ";" FROM source WHERE value='retained'`, '; '],
  ['final quoted identifier semicolon', `${schema}\nSELECT 'retained' AS ";"`, '; '],
  ['trigger with trailing comment', `${schema}\nCREATE TRIGGER copy AFTER INSERT ON source BEGIN UPDATE source SET value=NEW.value; END;\n-- final comment`, ''],
  ['trigger without final terminator', `${schema}\nCREATE TRIGGER copy AFTER INSERT ON source BEGIN UPDATE source SET value=NEW.value; END`, '; '],
];

for (const [label, sql, separator] of cases) {
  test(`completion preserves migration bytes and executes after ${label}`, async t => {
    const { fixture, api, id, db } = await setup(t);
    const migration = entry(sql), original = structuredClone(migration);
    const result = await migrate(api, id, [migration]);
    const batches = fixture.state.writes.filter(write => write.body?.sql?.startsWith(sql));
    assert.equal(batches.length, 1);
    assert.equal(batches[0].body.sql, `${sql}\n${separator}UPDATE d1_migrations SET state='applied' WHERE name='${migration.name}' AND sha256='${migration.sha256}';`);
    assert.deepEqual(migration, original);
    assert.equal(migration.sha256, hash(sql));
    assert.deepEqual(result.applied, [migration.name]);
    assert.deepEqual({ ...db.prepare('SELECT name,sha256,state FROM d1_migrations').get() },
      { name: migration.name, sha256: migration.sha256, state: 'applied' });
    assert.equal(db.prepare('SELECT value FROM source').get().value, 'retained');
    if (label.startsWith('trigger')) {
      db.exec("INSERT INTO source VALUES ('triggered')");
      assert.equal(db.prepare("SELECT count(*) AS total FROM source WHERE value='triggered'").get().total, 2);
    }
    const writes = fixture.state.writes.length;
    assert.deepEqual((await migrate(api, id, [migration])).applied, []);
    assert.equal(fixture.state.writes.length, writes);
  });
}

test('claim failure prevents migration execution and completion', async t => {
  const { fixture, api, id, db } = await setup(t);
  fixture.state.failSql = 'INSERT INTO d1_migrations';
  await assert.rejects(migrate(api, id, [entry(`${schema}\n-- comment`)]), /provider-unsuccessful-or-malformed/);
  assert.equal(fixture.state.writes.filter(write => write.body?.sql?.startsWith(fixture.state.failSql)).length, 1);
  assert.equal(db.prepare('SELECT count(*) AS total FROM d1_migrations').get().total, 0);
  assert.equal(db.prepare("SELECT count(*) AS total FROM sqlite_master WHERE name='source'").get().total, 0);
});

test('SQL failure retains applying claim and refuses uncertain-history replay', async t => {
  const { fixture, api, id, db } = await setup(t);
  const migration = entry(`${schema}\nINSERT INTO missing_table VALUES (1);\n-- final comment`);
  await assert.rejects(migrate(api, id, [migration]), /d1-import-failed/);
  assert.deepEqual({ ...db.prepare('SELECT name,sha256,state FROM d1_migrations').get() },
    { name: migration.name, sha256: migration.sha256, state: 'applying' });
  assert.equal(fixture.state.writes.filter(write => write.body?.sql?.startsWith(schema)).length, 1);
  assert.equal(db.prepare("SELECT count(*) AS total FROM sqlite_master WHERE name='source'").get().total, 0);
  const writes = fixture.state.writes.length;
  await assert.rejects(migrate(api, id, [migration]), /changed-or-uncertain-migration-history/);
  assert.equal(fixture.state.writes.length, writes);
});

test('a lost ingestion response leaves the claim uncertain and blocks automatic SQL replay', async t => {
  const { fixture, id, db } = await setup(t);
  const migration = entry(schema);
  const api = cloudflare({...fixture, fetch:async (url, init) => {
    if (url.endsWith('/import') && JSON.parse(init.body).action === 'ingest') throw new Error('connection lost');
    return fixture.fetch(url, init);
  }});
  await assert.rejects(migrate(api, id, [migration]), /provider-transport-failed/);
  assert.equal(db.prepare('SELECT state FROM d1_migrations').get().state, 'applying');
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='source'").get().n, 0);
  const writes = fixture.state.writes.length;
  await assert.rejects(migrate(cloudflare(fixture), id, [migration]), /uncertain-migration-history/);
  assert.equal(fixture.state.writes.length, writes);
});

test('a seed-declared reviewed rewrite lets upgrades past a released migration proceed; undeclared changes stay refused', async t => {
  const { fixture, api, id, db } = await setup(t);
  const product = await mkdtemp(join(await realpath(tmpdir()), 'rewrite-proof-'));
  t.after(() => rm(product, { recursive: true, force: true }));
  const named = (name, sql) => ({ name, sql, sha256: hash(sql) });
  const released = [named('0001_schema.sql', schema), named('0002_custody.sql', 'CREATE TABLE custody(id TEXT);')];
  await migrate(api, id, released);
  const rewritten = named('0002_custody.sql', 'CREATE TABLE IF NOT EXISTS custody(id TEXT);');
  const current = [released[0], rewritten, named('0003_converge.sql', 'CREATE INDEX custody_id ON custody(id);')];
  const ledger = () => db.prepare('SELECT name,sha256,state FROM d1_migrations ORDER BY id').all().map(row => ({ ...row }));
  const before = ledger(), writes = fixture.state.writes.length;
  const declare = rewrites => writeFile(join(product, 'migrations/rewrites.json'), JSON.stringify({ version: 1, rewrites }));
  const declared = { migration: '0002_custody.sql', from: released[1].sha256, to: rewritten.sha256, reason: 'Fresh D1 could not parse the released statement.', reviewed: true };
  await mkdir(join(product, 'migrations'), { recursive: true });
  assert.deepEqual(await readMigrationRewrites(product), []);
  await assert.rejects(migrate(api, id, current), /changed-or-uncertain-migration-history/);
  for (const [rewrites, refusal] of [
    [[{ ...declared, reviewed: false }], /unreviewed-migration-rewrite/],
    [[{ ...declared, to: hash('other bytes') }], /migration-rewrite-mismatch/],
    [[{ ...declared, migration: '0009_absent.sql' }], /unknown-migration-rewrite/],
  ]) {
    await declare(rewrites);
    await assert.rejects(async () => migrate(api, id, withRewrites(current, await readMigrationRewrites(product))), refusal);
  }
  await declare([declared]);
  const upgrade = withRewrites(current, await readMigrationRewrites(product));
  const changedFirst = withRewrites([named('0001_schema.sql', `${schema}\n-- edited`), ...current.slice(1)], await readMigrationRewrites(product));
  await assert.rejects(migrate(api, id, changedFirst), /changed-or-uncertain-migration-history/, 'an undeclared change is still refused');
  assert.deepEqual(ledger(), before);
  assert.equal(fixture.state.writes.length, writes, 'refusals write nothing');
  assert.deepEqual((await migrate(api, id, upgrade)).applied, ['0003_converge.sql']);
  assert.deepEqual(ledger(), [...before, { name: '0003_converge.sql', sha256: current[2].sha256, state: 'applied' }], 'the ledger keeps the released digest it applied');
  assert.deepEqual((await migrate(api, id, upgrade)).applied, []);
});
