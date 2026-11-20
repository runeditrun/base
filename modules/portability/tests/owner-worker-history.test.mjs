import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { D1 } from '../../container/adapters/d1.mjs';
import { generateMigrationEvidence } from '../../../cli/portability-evidence.mjs';
import { createPortability, createPortabilityHandler, readArchive, sha256 } from '../index.mjs';
import { ArchiveVerifier } from '../format.mjs';
import { workerMigrations } from '../worker-history.mjs';

async function exportArchive(options) {
 const service = await createPortability(options);
 const id = await service.exports.create();
 while ((await service.exports.advance(id)).phase === 'building') {}
 const records = [];
 for await (const record of readArchive(await service.exports.download(id))) records.push(record);
 return records;
}

test('Worker restore binds owner SQL and the interleaved native D1 migration history', async t => {
 const root = await mkdtemp(join(tmpdir(), 'owner-worker-'));
 const databases = [];
 t.after(async () => {
  await Promise.all(databases.map(db => db.close()));
  await rm(root, { recursive: true, force: true });
 });
 const core = { dir: 'core', name: '0001_records.sql', sql: 'CREATE TABLE records(id TEXT PRIMARY KEY);' };
 const owner = { dir: 'owner', name: '0001_note.sql', sql: "ALTER TABLE records ADD COLUMN note TEXT NOT NULL DEFAULT 'owner-default';" };
 const upgrade = { dir: 'core', name: '0002_state.sql', sql: `
  ALTER TABLE records ADD COLUMN state TEXT NOT NULL DEFAULT 'retained';
  CREATE INDEX records_note ON records(note);` };
 const backfill = { dir: 'owner', name: '0002_note.sql', sql: "UPDATE records SET note = 'synthetic-backfill';" };
 const throughUpgrade = [core, owner, upgrade];
 const history = [...throughUpgrade, backfill];
 const path = ({ dir, name }) => join(root, dir, name);
 await Promise.all(['core', 'owner'].map(name => mkdir(join(root, name))));
 await Promise.all([
  writeFile(join(root, 'wrangler.jsonc'), JSON.stringify({ d1_databases: [{ binding: 'DB', migrations_dir: 'core' }] })),
  writeFile(join(root, 'package.json'), JSON.stringify({ name: 'synthetic' })),
  writeFile(join(root, 'rer-packaging.json'), JSON.stringify({
   artifact: { specInputs: { extraMigrationDirectories: [{ binding: 'DB', path: 'owner', prefix: 'ext-' }] } },
  })),
  ...history.map(file => writeFile(path(file), file.sql)),
 ]);
 const [evidence, schema] = await Promise.all([
  generateMigrationEvidence(root),
  readFile(new URL('../schema/portability.sql', import.meta.url), 'utf8'),
 ]);
 const changedOwner = { ...owner, sql: owner.sql + '\n-- Different owner migration bytes.\n' };
 await writeFile(path(changedOwner), changedOwner.sql);
 const changedEvidence = await generateMigrationEvidence(root);
 await rm(path(backfill));
 const missingEvidence = await generateMigrationEvidence(root);

 const columns = 'id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL';
 const database = async (name, applied) => {
  const db = new D1(join(root, name + '.sqlite'));
  databases.push(db);
  await db.exec(`${schema}
   CREATE TABLE d1_migrations(${columns});
   CREATE TABLE synthetic_ext_migrations(${columns});`);
  for (const [index, file] of applied.entries()) {
   await db.exec(file.sql);
   const ledger = file.dir === 'core' ? 'd1_migrations' : 'synthetic_ext_migrations';
   await db.prepare(`INSERT INTO ${ledger}(name,applied_at) VALUES(?,?)`)
    .bind(file.name, `2026-01-01 00:00:0${index}`).run();
  }
  return db;
 };
 const policy = { product: 'synthetic/worker-restore' };
 const options = (db, built = evidence) => ({ db, policy, migrations: () => workerMigrations(db, policy, built) });
 const appOrigin = 'https://restore.invalid';
 const restore = async (db, [manifest, ...records], built) => {
  const handler = await createPortabilityHandler({ ...options(db, built), appOrigin, authorize: () => 'synthetic-owner' });
  const call = (suffix, method, body) => handler(new Request(appOrigin + '/api/portability/imports' + suffix, {
   method, headers: { Origin: appOrigin }, body: JSON.stringify(body),
  }));
  const created = await call('', 'POST', { confirmed: true, manifest });
  if (!created.ok) return created;
  assert.equal(created.status, 201);
  const { id } = await created.json();
  for (const part of records.slice(0, -1)) {
   const uploaded = await call(`/${id}/parts/${part.index}`, 'PUT', part);
   assert.equal(uploaded.status, 200, await uploaded.clone().text());
  }
  return call(`/${id}/finalize`, 'POST', records.at(-1));
 };
 const rows = async db => (await db.prepare('SELECT * FROM records').all()).results;
 const definitions = async db => (await db.prepare("SELECT name,sql FROM sqlite_master WHERE tbl_name='records' ORDER BY name").all()).results;

 const source = await database('source', history);
 await source.prepare("INSERT INTO records(id,note) VALUES('one','synthetic-owner-note')").run();
 const archive = await exportArchive(options(source));
 const [manifest] = archive;
 assert.deepEqual(manifest.migrationLedger.entries.map(row => row.name), [core.name, 'ext-' + owner.name, upgrade.name, 'ext-' + backfill.name]);
 assert.deepEqual(manifest.tables.map(table => table.name), ['records']);
 const sourceDefinitions = await definitions(source);

 const matching = await database('matching', history);
 const response = await restore(matching, archive);
 assert.equal(response.status, 200, await response.clone().text());
 assert.equal((await response.json()).phase, 'complete');
 assert.deepEqual(await rows(matching), [{ id: 'one', note: 'synthetic-owner-note', state: 'retained' }]);

 const historyError = 'schema_mismatch:owner_migration_history';
 const omitted = structuredClone(archive);
 const omittedManifest = omitted[0];
 omittedManifest.migrationLedger.entries = omittedManifest.migrationLedger.entries.filter(entry => entry.name !== 'ext-' + owner.name);
 omittedManifest.migrations = omittedManifest.migrationLedger.entries.map(entry => entry.name);
 const verifier = new ArchiveVerifier(omittedManifest);
 for (const part of omitted.slice(1, -1)) verifier.add(part);
 omitted.at(-1).archiveHash = verifier.digest();

 for (const { name, applied, built, archiveInput = archive, sameSchema = true } of [
  { name: 'changed owner SQL bytes', applied: [core, changedOwner, upgrade, backfill], built: changedEvidence },
  { name: 'missing applied owner file', applied: history, built: missingEvidence },
  { name: 'archive omits the owner ALTER', applied: history, archiveInput: omitted },
  { name: 'missing owner ALTER', applied: [core], sameSchema: false },
  { name: 'different applied order', applied: [core, owner, backfill, upgrade] },
  { name: 'archive has an extra data-only owner migration', applied: throughUpgrade },
 ]) {
  const target = await database(name, applied);
  if (sameSchema) assert.deepEqual(await definitions(target), sourceDefinitions, name);
  const response = await restore(target, archiveInput, built);
  assert.equal(response.status, 409, name);
  assert.deepEqual(await response.json(), { error: historyError }, name);
  assert.deepEqual(await rows(target), [], name);
  assert.equal((await target.prepare('SELECT COUNT(*) AS n FROM rer_portability_jobs').first()).n, 0, name);
  t.diagnostic(`${name}: 409 ${historyError}, zero rows`);
 }

 for (const { label, applied, insert, note } of [
  { label: 'core prefix', applied: [core], insert: "INSERT INTO records VALUES('older')", note: 'owner-default' },
  { label: 'owner prefix', applied: [core, owner], insert: "INSERT INTO records VALUES('older','synthetic-owner-note')", note: 'synthetic-owner-note' },
 ]) {
  const older = await database(label + ' source', applied);
  await older.prepare(insert).run();
  const target = await database(label + ' destination', throughUpgrade);
  const archive = await exportArchive(options(older));
  const response = await restore(target, archive);
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).phase, 'complete');
  assert.deepEqual(await rows(target), [{ id: 'older', note, state: 'retained' }]);
 }
});

test('Worker refuses a Platform archive when cross-ledger replay changes its schema', async t => {
 const root = await mkdtemp(join(tmpdir(), 'platform-worker-'));
 const source = new D1(join(root, 'source.sqlite'));
 const target = new D1(join(root, 'target.sqlite'));
 t.after(async () => {
  await Promise.all([source.close(), target.close()]);
  await rm(root, { recursive: true, force: true });
 });
 const create = { dir: 'core', name: '0001_records.sql', sql: 'CREATE TABLE restore_records(id TEXT PRIMARY KEY);' };
 const status = { dir: 'core', name: '0002_status.sql', sql: "ALTER TABLE restore_records ADD COLUMN status TEXT NOT NULL DEFAULT 'open';" };
 const prefs = { dir: 'owner', name: '0001_preferences.sql', sql: 'CREATE TABLE preferences(id TEXT PRIMARY KEY);' };
 const note = { dir: 'owner', name: '0002_note.sql', sql: "ALTER TABLE restore_records ADD COLUMN note TEXT NOT NULL DEFAULT 'owner-default';" };
 await Promise.all(['core', 'owner'].map(dir => mkdir(join(root, dir))));
 await Promise.all([
  writeFile(join(root, 'wrangler.jsonc'), JSON.stringify({ d1_databases: [{ binding: 'DB', migrations_dir: 'core' }] })),
  writeFile(join(root, 'package.json'), JSON.stringify({ name: 'synthetic' })),
  writeFile(join(root, 'rer-packaging.json'), JSON.stringify({
   artifact: { specInputs: { extraMigrationDirectories: [{ binding: 'DB', path: 'owner', prefix: 'ext-' }] } },
  })),
  ...[create, status, prefs, note].map(file => writeFile(join(root, file.dir, file.name), file.sql)),
 ]);
 const [evidence, schema] = await Promise.all([
  generateMigrationEvidence(root),
  readFile(new URL('../schema/portability.sql', import.meta.url), 'utf8'),
 ]);
 await source.exec(`${schema}
  CREATE TABLE rer_migrations(name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at TEXT NOT NULL);`);
 const appliedAt = index => `2026-01-01 00:00:0${index}`;
 for (const [index, file] of [create, status, note].entries()) {
  await source.exec(file.sql);
  await source.prepare('INSERT INTO rer_migrations VALUES(?,?,?)')
   .bind(file.dir === 'owner' ? 'ext-' + file.name : file.name, await sha256(file.sql), appliedAt(index)).run();
 }
 await source.prepare('INSERT INTO restore_records VALUES(?,?,?)').bind('one', 'closed', 'synthetic-owner-note').run();
 const policy = { product: 'synthetic/worker-restore' };
 const [manifest] = await exportArchive({ db: source, policy });
 assert.equal(manifest.migrationLedger.origin, 'rer_migrations');

 const columns = 'id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL';
 await target.exec(`${schema}
  CREATE TABLE d1_migrations(${columns});
  CREATE TABLE synthetic_ext_migrations(${columns});`);
 for (const [index, file] of [create, prefs, note, status].entries()) {
  await target.exec(file.sql);
  const ledger = file.dir === 'core' ? 'd1_migrations' : 'synthetic_ext_migrations';
  await target.prepare(`INSERT INTO ${ledger}(name,applied_at) VALUES(?,?)`).bind(file.name, appliedAt(index)).run();
 }
 const appOrigin = 'https://restore.invalid';
 const handler = await createPortabilityHandler({ db: target, policy, appOrigin, authorize: () => 'synthetic-owner',
  migrations: () => workerMigrations(target, policy, evidence) });
 const response = await handler(new Request(appOrigin + '/api/portability/imports', {
  method: 'POST', headers: { Origin: appOrigin }, body: JSON.stringify({ confirmed: true, manifest }),
 }));
 assert.equal(response.status, 409, await response.clone().text());
 assert.deepEqual(await response.json(), { error: 'schema_mismatch' });
 assert.equal(await target.prepare('SELECT COUNT(*) AS n FROM restore_records').first('n'), 0);
 assert.equal(await target.prepare('SELECT COUNT(*) AS n FROM rer_portability_jobs').first('n'), 0);
});
