import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { D1 } from '../../container/adapters/d1.mjs';
import { generateMigrationEvidence } from '../../../cli/portability-evidence.mjs';
import { createPortability, createPortabilityHandler, readArchive } from '../index.mjs';
import { workerMigrations } from '../worker-history.mjs';

test('Worker restore refuses a newer owner migration even when its SQL leaves the schema unchanged', async t => {
 const root = await mkdtemp(join(tmpdir(), 'owner-worker-'));
 t.after(() => rm(root, { recursive: true, force: true }));
 const core = '0001_records.sql', owner = '0001_note.sql', later = '0002_note.sql';
 const coreSql = 'CREATE TABLE records(id TEXT PRIMARY KEY);';
 const ownerSql = 'ALTER TABLE records ADD COLUMN note TEXT;';
 const laterSql = "UPDATE records SET note = 'synthetic-backfill';";
 await Promise.all(['core','owner'].map(name => mkdir(join(root, name))));
 await Promise.all([
  writeFile(join(root, 'wrangler.jsonc'), JSON.stringify({ d1_databases: [{ binding: 'DB', migrations_dir: 'core' }] })),
  writeFile(join(root, 'package.json'), JSON.stringify({ name: 'synthetic' })),
  writeFile(join(root, 'rer-packaging.json'), JSON.stringify({
   artifact: { specInputs: { extraMigrationDirectories: [{ binding: 'DB', path: 'owner', prefix: 'ext-' }] } },
  })),
  writeFile(join(root, 'core', core), coreSql),
  writeFile(join(root, 'owner', owner), ownerSql),
  writeFile(join(root, 'owner', later), laterSql),
 ]);
 const evidence = await generateMigrationEvidence(root);
 const source = new D1(join(root, 'source.sqlite')), target = new D1(join(root, 'target.sqlite'));
 t.after(() => Promise.all([source.close(), target.close()]));
 const schema = await readFile(new URL('../schema/portability.sql', import.meta.url), 'utf8');
 const columns = 'id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL';
 for (const db of [source, target]) await db.exec(`${schema} ${coreSql} ${ownerSql}
  CREATE TABLE d1_migrations(${columns});
  CREATE TABLE synthetic_ext_migrations(${columns});
  INSERT INTO d1_migrations(name,applied_at) VALUES('${core}','2026-01-01 00:00:00');
  INSERT INTO synthetic_ext_migrations(name,applied_at) VALUES('${owner}','2026-01-01 00:00:01');`);
 await source.exec(`${laterSql}
  INSERT INTO synthetic_ext_migrations(name,applied_at) VALUES('${later}','2026-01-01 00:00:02');
  INSERT INTO records VALUES('one','synthetic-owner-note');`);

 const policy = { product: 'synthetic/worker-restore' };
 const options = db => ({ db, policy, migrations: () => workerMigrations(db, policy, evidence) });
 const service = await createPortability(options(source));
 const id = await service.exports.create();
 while ((await service.exports.advance(id)).phase === 'building') {}
 const archive = [];
 for await (const record of readArchive(await service.exports.download(id))) archive.push(record);
 const [manifest] = archive;
 assert.deepEqual(manifest.migrationLedger.entries.map(row => row.name), [core, 'ext-' + owner, 'ext-' + later]);
 assert.deepEqual(manifest.tables.map(table => table.name), ['records']);

 const appOrigin = 'https://restore.invalid';
 const handler = await createPortabilityHandler({ ...options(target), appOrigin, authorize: () => 'synthetic-owner' });
 const response = await handler(new Request(appOrigin + '/api/portability/imports', {
  method: 'POST', headers: { Origin: appOrigin }, body: JSON.stringify({ confirmed: true, manifest }),
 }));
 assert.equal(response.status, 409);
 assert.deepEqual(await response.json(), { error: 'schema_mismatch:owner_migration_history' });
 assert.deepEqual((await target.prepare('SELECT * FROM records').all()).results, []);
});
