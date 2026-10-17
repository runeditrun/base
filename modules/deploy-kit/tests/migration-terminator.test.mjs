import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, readMigrationRewrites, withRewrites } from '../migrations.mjs';
import { cloudflare } from '../provider.mjs';
import { hash } from '../validation.mjs';
import { migrationFailure } from '../diagnostics.mjs';
import { main } from '../owner-cli.mjs';
import { ownerProvider } from './owner-provider.mjs';
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

test('an import D1 rolled back keeps its reason and is retried by the next run of the same bytes', async t => {
  const { fixture, api, id, db } = await setup(t);
  const migration = entry(`${schema}\nINSERT INTO source SELECT value FROM lookup;\n-- final comment`);
  await assert.rejects(migrate(api, id, [migration]), error => error.message === 'd1-import-failed' && error.migration === migration.name
    && /no such table: lookup/.test(error.providerRefusal.errors[0].message));
  assert.deepEqual({ ...db.prepare('SELECT name,sha256,state FROM d1_migrations').get() },
    { name: migration.name, sha256: migration.sha256, state: 'applying' });
  assert.equal(db.prepare("SELECT count(*) AS total FROM sqlite_master WHERE name='source'").get().total, 0);
  db.exec("CREATE TABLE lookup(value TEXT); INSERT INTO lookup VALUES ('looked up')");
  assert.deepEqual((await migrate(api, id, [migration])).applied, [migration.name]);
  assert.deepEqual(db.prepare('SELECT name,sha256,state FROM d1_migrations').all().map(row => ({ ...row })),
    [{ name: migration.name, sha256: migration.sha256, state: 'applied' }]);
  assert.deepEqual(db.prepare('SELECT value FROM source ORDER BY value').all().map(row => row.value), ['looked up', 'retained']);
  assert.equal(fixture.state.writes.filter(write => write.body?.sql?.startsWith('INSERT INTO d1_migrations')).length, 1, 'the claim is made once');
  assert.equal(fixture.state.writes.filter(write => write.body?.sql?.startsWith(schema)).length, 2);
});

test('a lost ingestion response is retried only while the migration provably did not apply', async t => {
  for (const committed of [false, true]) {
    const { fixture, id, db } = await setup(t);
    const migration = entry(schema);
    const api = cloudflare({...fixture, fetch:async (url, init) => {
      if (url.endsWith('/import') && JSON.parse(init.body).action === 'ingest') {
        if (committed) await fixture.fetch(url, init);
        throw new Error('connection lost');
      }
      return fixture.fetch(url, init);
    }});
    await assert.rejects(migrate(api, id, [migration]), /provider-transport-failed/);
    assert.equal(db.prepare('SELECT state FROM d1_migrations').get().state, committed ? 'applied' : 'applying');
    const writes = fixture.state.writes.length;
    assert.deepEqual((await migrate(cloudflare(fixture), id, [migration])).applied, committed ? [] : [migration.name]);
    assert.equal(fixture.state.writes.length, writes + (committed ? 0 : 1), 'an applied import is never run again');
    assert.equal(db.prepare("SELECT count(*) n FROM source").get().n, 1);
    assert.equal(db.prepare('SELECT state FROM d1_migrations').get().state, 'applied');
  }
});

test('a claimed migration whose effects are partly present, or cannot be checked, stays refused and names itself', async t => {
  const { fixture, api, id, db } = await setup(t);
  const named = (name, sql) => ({ name, sql, sha256: hash(sql) });
  const first = named('0001_schema.sql', schema);
  await migrate(api, id, [first]);
  const second = named('0002_lookup.sql', 'CREATE TABLE IF NOT EXISTS seen(value TEXT);\nCREATE INDEX source_value ON source(value);\nALTER TABLE source ADD COLUMN looked TEXT;\nUPDATE source SET looked = (SELECT value FROM lookup);');
  await assert.rejects(migrate(api, id, [first, second]), /d1-import-failed/);
  db.exec('CREATE INDEX source_value ON source(value)');
  const writes = fixture.state.writes.length;
  await assert.rejects(migrate(api, id, [first, second]), error => error.message === 'uncertain-migration-claim'
    && JSON.stringify(error.migrationClaim) === JSON.stringify({ name: '0002_lookup.sql', present: ['index source_value'] }));
  assert.equal(fixture.state.writes.length, writes, 'a refusal writes nothing');
  assert.equal(db.prepare("SELECT state FROM d1_migrations WHERE name='0002_lookup.sql'").get().state, 'applying');
  db.exec('DROP INDEX source_value; CREATE TABLE lookup(value TEXT);');
  assert.deepEqual((await migrate(api, id, [first, second])).applied, ['0002_lookup.sql'], 'with its effects undone it runs again');
  const third = named('0003_backfill.sql', "UPDATE source SET looked = 'yes' WHERE value = (SELECT value FROM missing);");
  await assert.rejects(migrate(api, id, [first, second, third]), /d1-import-failed/);
  await assert.rejects(migrate(api, id, [first, second, third]), error => error.message === 'uncertain-migration-claim' && error.migrationClaim.present.length === 0);
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

test('rer deploy retries a claim D1 rolled back on bytes a reviewed rewrite replaced; a claim on any other bytes is refused with the command that clears it', async t => {
  const provider = ownerProvider(); t.after(() => provider.close());
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rewritten-claim-'))); t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ['dist/server', 'dist/client', 'migrations/core']) await mkdir(join(root, dir), { recursive: true });
  await writeFile(join(root, 'dist/server/wrangler.json'), JSON.stringify({ main: 'index.js', no_bundle: true, rules: [{ type: 'ESModule', globs: ['**/*.js', '**/*.mjs'] }] }));
  await writeFile(join(root, 'dist/server/index.js'), 'export default {fetch(){return new Response("vector")}};');
  await writeFile(join(root, 'dist/client/index.html'), '<h1>Vector</h1>');
  await writeFile(join(root, 'deploy.json'), JSON.stringify({ version: 1, project: 'runeditrun/vector', compatibilityDate: '2026-09-08', compatibilityFlags: ['nodejs_compat'], d1: [{ binding: 'DB' }], secrets: [], crons: [], vars: {} }));
  await writeFile(join(root, '.gitignore'), 'dist/\n.rer/\n');
  const git = (...args) => execFileSync('git', ['-c', 'user.email=owner@example.test', '-c', 'user.name=Owner', '-c', 'commit.gpgsign=false', ...args], { cwd: root, stdio: 'pipe' });
  const commit = async files => {
    for (const [path, text] of Object.entries(files)) await writeFile(join(root, path), text);
    git('add', '.'); git('commit', '-qm', 'change');
  };
  // Like Pantry's 0018: a rebuilt table, which exists either way and proves nothing, then new tables and indexes
  // whose absence proves the rollback (more of them than D1 accepts in one compound SELECT).
  const rebuild = 'CREATE TABLE projects_next(id TEXT PRIMARY KEY, name TEXT);\nINSERT INTO projects_next(id) SELECT id FROM projects;\nDROP TABLE projects;\nALTER TABLE projects_next RENAME TO projects;\nCREATE INDEX projects_name ON projects(name);\n';
  const custody = `CREATE TABLE custody(id TEXT);\n${[1, 2, 3, 4, 5].map(n => `CREATE INDEX custody_${n} ON custody(id);`).join('\n')}\n`;
  const fixed = `${rebuild}${custody}INSERT INTO custody SELECT id FROM projects;`;
  const sql = { schema: 'CREATE TABLE projects(id TEXT PRIMARY KEY);\nCREATE INDEX projects_name ON projects(id);', released: `${rebuild}${custody}INSERT INTO custody SELECT id FROM missing;`, other: `${fixed}\n-- edited without a rewrite record`, fixed };
  git('init', '-q');
  await commit({ 'migrations/core/0001_projects.sql': sql.schema, 'migrations/core/0002_custody.sql': sql.released });
  const notices = [], deploy = () => main(['deploy', '--declaration', 'deploy.json', '--environment', 'production'], { CLOUDFLARE_ACCOUNT_ID: provider.accountId, CLOUDFLARE_API_TOKEN: provider.token }, { fetch: provider.fetch, cwd: root, notice: line => notices.push(line) });
  const db = () => provider.state.databases[0].db;
  const ledger = () => db().prepare('SELECT name,sha256,state FROM d1_migrations ORDER BY id').all().map(row => ({ ...row }));
  await assert.rejects(deploy(), error => error.message === 'd1-import-failed' && error.migration === '0002_custody.sql');
  assert.deepEqual(ledger().at(-1), { name: '0002_custody.sql', sha256: hash(sql.released), state: 'applying' }, 'D1 rolled the import back and the claim stays');
  // Other bytes, undeclared: refused, and the message gives the exact command that clears the claim.
  await commit({ 'migrations/core/0002_custody.sql': sql.other });
  let writes = provider.state.writes.length;
  await assert.rejects(deploy(), error => {
    assert.equal(error.message, 'changed-or-uncertain-migration-history');
    const text = migrationFailure(error);
    assert.ok(text.includes(`npx wrangler d1 execute vector-production-db --remote --command "DELETE FROM d1_migrations WHERE name='0002_custody.sql' AND sha256='${hash(sql.released)}' AND state='applying'"`), text);
    assert.match(text, /no other deploy of this environment is running/);
    return true;
  });
  assert.equal(provider.state.writes.length, writes, 'a refusal writes nothing');
  // The fix, with its reviewed rewrite: the rolled-back claim runs again with the new bytes.
  db().exec("INSERT INTO projects VALUES ('kept')");
  await commit({ 'migrations/core/0002_custody.sql': sql.fixed, 'migrations/rewrites.json': JSON.stringify({ version: 1, rewrites: [{ migration: '0002_custody.sql', from: hash(sql.released), to: hash(sql.fixed), reason: 'The released bytes read a table that does not exist.', reviewed: true }] }) });
  const unlocked = cloudflare(provider); writes = provider.state.writes.length;
  const plan = withRewrites([['0001_projects.sql', sql.schema], ['0002_custody.sql', sql.fixed]].map(([name, text]) => ({ name, sql: text, sha256: hash(text) })), await readMigrationRewrites(root));
  await assert.rejects(migrate(unlocked, provider.state.databases[0].uuid, plan), /changed-or-uncertain-migration-history/, 'a caller without the deploy lock keeps the refusal');
  assert.equal(provider.state.writes.length, writes);
  assert.equal((await deploy()).ok, true);
  assert.deepEqual(ledger().at(-1), { name: '0002_custody.sql', sha256: hash(sql.fixed), state: 'applied' });
  assert.deepEqual(db().prepare('SELECT id FROM custody').all().map(row => row.id), ['kept']);
  assert.ok(notices.includes('Migrations: retried 0002_custody.sql: the earlier attempt was rolled back (D1 vector-production-db).'), notices.join('\n'));
  assert.equal((await deploy()).changed, false, 'the next deploy has nothing to do');
});
