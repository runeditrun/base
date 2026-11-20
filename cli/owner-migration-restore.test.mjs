import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ArchiveVerifier } from '../modules/portability/format.mjs';
import { buildPackage } from '../scripts/rer-package.mjs';
import { portabilityFixture } from './fixtures/portability.mjs';

const hash = sql => createHash('sha256').update(sql).digest('hex');

test('the installed CLI restores Platform data into an upgraded native checkout and refuses invalid native owner history', { timeout: 6 * 60_000 }, async t => {
 const directory = await mkdtemp(join(tmpdir(), 'rer-owner-package-'));
 t.after(() => rm(directory, { recursive: true, force: true }));
 const packed = await buildPackage(resolve(import.meta.dirname, '..'), directory);
 execFileSync('tar', ['-xzf', packed, '-C', directory]);
 const pkg = join(directory, 'package');
 const seed = await portabilityFixture(t, { generated: false, entry: join(pkg, 'global/rer.mjs') });
 // Let the installed dispatcher run this checkout and use its portability adapter.
 await rm(join(seed.root, 'scripts/rer.mjs'));
 const adapter = join(seed.root, 'scripts/installer/local.mjs');
 await writeFile(adapter, (await readFile(adapter, 'utf8'))
  .replace("'../base-cli/cli/portability.mjs'", JSON.stringify(pathToFileURL(join(pkg, 'cli/portability.mjs')).href))
  .replace('policy: portabilityPolicy', "policy: { product: 'synthetic/owner-migrations' }"));

 const coreDirectory = join(seed.root, 'migrations/core');
 for (const file of await readdir(coreDirectory)) await rm(join(coreDirectory, file));
 const core = [
  ['0040_auxiliary.sql', 'CREATE TABLE auxiliary (id TEXT PRIMARY KEY);'],
  ['020_records.sql', 'CREATE TABLE restore_records (id TEXT PRIMARY KEY);'],
 ];
 for (const [name, sql] of core) await writeFile(join(coreDirectory, name), sql);
 const rows = [{ id: 'synthetic-owner-record', owner_note: 'default-note' }];
 // Platform applies the plan in filename order. Wrangler orders the same
 // mixed-width migration numbers numerically.
 await seed.data(`CREATE TABLE rer_migrations (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  ${core.map(([name, sql]) => `${sql} INSERT INTO rer_migrations(name,sha256) VALUES('${name}','${hash(sql)}');`).join('\n')}
  INSERT INTO restore_records VALUES('${rows[0].id}');`);
 await seed.text(['export', '--output', 'exports/platform.rer']);

 const state = join(seed.root, '.wrangler/state');
 await rename(state, state + '-platform');
 await seed.text(['export', '--output', 'exports/native-core.rer']);
 const applied = (await seed.data('SELECT name FROM d1_migrations ORDER BY id'))[0].results;
 assert.deepEqual(applied.map(row => row.name), core.map(([name]) => name).reverse());

 const ownerDirectory = join(seed.root, 'migrations/ext');
 const owner = '0001_owner.sql', ownerFile = join(ownerDirectory, owner), ownerName = 'ext-' + owner;
 const alter = "ALTER TABLE restore_records ADD COLUMN owner_note TEXT NOT NULL DEFAULT 'default-note';";
 await mkdir(ownerDirectory);
 await writeFile(ownerFile, alter);
 await writeFile(join(seed.root, 'rer-packaging.json'), JSON.stringify({
  artifact: { specInputs: { extraMigrationDirectories: [{ binding: 'DB', path: 'migrations/ext', prefix: 'ext-' }] } },
 }));
 const { name } = JSON.parse(await readFile(join(seed.root, 'package.json'), 'utf8'));
 const ledger = name.split('/').at(-1).replaceAll('-', '_') + '_ext_migrations';
 await seed.data(`${alter}
  CREATE TABLE ${ledger}(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);
  INSERT INTO ${ledger}(name, applied_at) SELECT '${owner}', datetime(max(applied_at), '+1 second') FROM d1_migrations;`);
 await cp(state, state + '-empty', { recursive: true });
 const clear = async () => {
  await rm(state, { recursive: true, force: true });
  await cp(state + '-empty', state, { recursive: true });
 };
 const records = async () => (await seed.data('SELECT id,owner_note FROM restore_records'))[0].results;
 const importFrom = (file, code = 0) => seed.text(['import', '--input', `exports/${file}.rer`, '--yes'], code);
 await importFrom('platform');
 assert.deepEqual(await records(), rows);
 await seed.text(['export', '--output', 'exports/owner.rer']);
 await clear();
 await importFrom('owner');
 assert.deepEqual(await records(), rows);
 await clear();

 async function variant(name, transform) {
  const lines = (await readFile(join(seed.root, 'exports/owner.rer'), 'utf8')).trimEnd().split('\n');
  const manifest = JSON.parse(lines[0]);
  assert.ok(!manifest.tables.some(table => table.name === ledger));
  manifest.migrationLedger.entries = transform(manifest.migrationLedger.entries);
  manifest.migrations = manifest.migrationLedger.entries.map(entry => entry.name);
  const verifier = new ArchiveVerifier(manifest);
  for (const part of lines.slice(1, -1)) verifier.add(JSON.parse(part));
  const closing = { ...JSON.parse(lines.at(-1)), archiveHash: verifier.digest() };
  await writeFile(join(seed.root, `exports/${name}.rer`), [JSON.stringify(manifest), ...lines.slice(1, -1), JSON.stringify(closing), ''].join('\n'));
 }
 async function refuses(file) {
  const result = await importFrom(file, 4);
  assert.match(result.stderr, /schema_mismatch:owner_migration_history/);
  assert.deepEqual(await records(), []);
  assert.equal((await seed.data("SELECT count(*) AS n FROM rer_portability_jobs WHERE kind='import'"))[0].results[0].n, 0);
 }

 await writeFile(ownerFile, `${alter}\n-- Revised migration file.`);
 await refuses('owner');
 await writeFile(ownerFile, alter);
 await variant('omitted', entries => entries.filter(entry => entry.name !== ownerName));
 await refuses('omitted');
 await variant('reordered', entries => entries.toReversed());
 await refuses('reordered');
 await variant('extra', entries => [...entries, { name: 'ext-0002_unapplied.sql', sha256: hash('DELETE FROM auxiliary;') }]);
 await refuses('extra');
 await rm(ownerFile);
 await refuses('owner');
});
