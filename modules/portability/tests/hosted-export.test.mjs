import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPortability, readArchive } from '../index.mjs';
import { migrationReplay } from '../migration-history.mjs';
import { providerFixture } from '../../deploy-kit/tests/provider-fixture.mjs';
import { cloudflare } from '../../deploy-kit/provider.mjs';
import { migrate } from '../../deploy-kit/migrations.mjs';
import { hash } from '../../deploy-kit/validation.mjs';

const policy = { product: 'hosted-portability' };
const schema = await readFile(new URL('../schema/portability.sql', import.meta.url), 'utf8');
const plan = [
  { name: '0001_items.sql', sql: 'CREATE TABLE items(id INTEGER PRIMARY KEY,amount INTEGER NOT NULL);' },
  { name: '0002_cents.sql', sql: 'UPDATE items SET amount=amount*100;' },
].map(row => ({ ...row, sha256: hash(row.sql) }));

// The provider fixture stores actual SQLite databases. Adapt that same store
// to the D1 binding used by the public portability service.
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
async function service(db, migrations = plan) {
  db.exec(schema);
  return createPortability({ db: binding(db), policy,
    migrations: async () => migrationReplay(migrations.map(({ name, sql }) => ({ name, statements: [sql] })), policy) });
}
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

test('hosted archives refuse uncertain data migrations and retain legacy and Wrangler restore history', async t => {
  const fixture = providerFixture(), api = cloudflare(fixture);
  t.after(() => fixture.close());
  async function database(name) {
    const { uuid } = await api.request('/d1/database', { method: 'POST', body: { name } });
    return { uuid, db: fixture.state.databases.find(row => row.uuid === uuid).db };
  }
  const source = await database('source'), target = await database('target');
  await migrate(api, source.uuid, plan.slice(0, 1));
  source.db.exec('INSERT INTO items VALUES(1,1)');
  const disconnected = cloudflare({ ...fixture, fetch: async (url, init) => {
    if (url.endsWith('/import') && JSON.parse(init.body).action === 'ingest') throw Error('network disconnect');
    return fixture.fetch(url, init);
  } });
  await assert.rejects(migrate(disconnected, source.uuid, plan), /provider-transport-failed/);
  assert.equal(source.db.prepare('SELECT amount FROM items').get().amount, 1);
  assert.equal(source.db.prepare('SELECT state FROM d1_migrations WHERE name=?').get(plan[1].name).state, 'applying');
  const uncertain = await service(source.db, plan.slice(0, 1));
  await assert.rejects(archive(uncertain), /schema_mismatch:uncertain_migrations/);
  assert.equal(source.db.prepare('SELECT COUNT(*) AS n FROM rer_portability_jobs').get().n, 0);

  await migrate(api, target.uuid, plan);
  target.db.exec('INSERT INTO items VALUES(1,100)');
  const confirmed = await service(target.db), current = await archive(confirmed);
  assert.deepEqual(current.manifest.migrations, plan.map(row => row.name));
  await assert.rejects(uncertain.imports.create(current.manifest), /schema_mismatch:uncertain_migrations/);
  assert.equal(source.db.prepare('SELECT amount FROM items').get().amount, 1);
  assert.equal(source.db.prepare('SELECT COUNT(*) AS n FROM rer_portability_jobs').get().n, 0);
  target.db.exec('DELETE FROM items');
  assert.equal((await restore(confirmed, current)).phase, 'complete');
  assert.equal(target.db.prepare('SELECT amount FROM items').get().amount, 100);
  target.db.exec('DELETE FROM items');

  // Existing old-ledger archives retain their applied-only history, so their
  // pre-conversion data cannot bypass a confirmed later data-only migration.
  source.db.exec(`CREATE TABLE _rer_deploy_migrations(name TEXT PRIMARY KEY,sha256 TEXT NOT NULL,state TEXT NOT NULL);
    INSERT INTO _rer_deploy_migrations SELECT name,sha256,state FROM d1_migrations; DROP TABLE d1_migrations;`);
  const historical = await archive(uncertain);
  assert.deepEqual(historical.manifest.migrations, [plan[0].name]);
  await assert.rejects(confirmed.imports.create(historical.manifest), /schema_mismatch:migration_data:0002_cents.sql/);
  assert.equal(target.db.prepare('SELECT COUNT(*) AS n FROM items').get().n, 0);

  // Ordinary Wrangler ledgers have no state/hash columns. Their recorded names
  // still support the same public export/import round trip.
  target.db.exec(`ALTER TABLE d1_migrations RENAME TO migration_history;
    CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL UNIQUE,applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    INSERT INTO d1_migrations(id,name,applied_at) SELECT id,name,applied_at FROM migration_history; DROP TABLE migration_history;`);
  assert.equal((await restore(confirmed, current)).phase, 'complete');
  const wrangler = await archive(confirmed);
  assert.deepEqual(wrangler.manifest.migrations, current.manifest.migrations);
  target.db.exec('DELETE FROM items');
  assert.equal((await restore(confirmed, wrangler)).phase, 'complete');
  assert.equal(target.db.prepare('SELECT amount FROM items').get().amount, 100);
});
