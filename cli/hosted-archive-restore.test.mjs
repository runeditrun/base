import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildPackage } from '../scripts/rer-package.mjs';
import { portabilityFixture } from './fixtures/portability.mjs';

const base = resolve(import.meta.dirname, '..');
let directory, pkg;
before(async () => {
 directory = await mkdtemp(join(await realpath(tmpdir()), 'rer-restore-package-'));
 const tarball = await buildPackage(base, directory);
 execFileSync('tar', ['-xzf', tarball, '-C', directory]);
 pkg = join(directory, 'package');
});
after(async () => {
 if (directory) await rm(directory, { recursive: true, force: true });
});

async function installedSeed(t, core) {
 const seed = await portabilityFixture(t, { generated: false, entry: join(pkg, 'global/rer.mjs') });
 await rm(join(seed.root, 'scripts/rer.mjs'));
 const adapter = join(seed.root, 'scripts/installer/local.mjs');
 await writeFile(adapter, (await readFile(adapter, 'utf8'))
  .replace("'../base-cli/cli/portability.mjs'", JSON.stringify(pathToFileURL(join(pkg, 'cli/portability.mjs')).href))
  .replace('policy: portabilityPolicy', "policy: { product: 'synthetic/restore' }"));
 const migrations = join(seed.root, 'migrations/core');
 for (const file of await readdir(migrations)) await rm(join(migrations, file));
 for (const [name, sql] of core) await writeFile(join(migrations, name), sql);
 return { ...seed, migrations, state: join(seed.root, '.wrangler/state') };
}

const recordsFile = ['020_records.sql', 'CREATE TABLE restore_records (id TEXT PRIMARY KEY);'];
const retainedRow = { id: 'synthetic-retained-record' };
const insert = `INSERT INTO restore_records VALUES ('${retainedRow.id}');`;
const records = async seed => (await seed.data('SELECT id FROM restore_records'))[0].results;
const restore = ['import', '--input', 'exports/backup.rer', '--yes', '--non-interactive'];

test('the installed CLI restores a hosted deployment history into a newer Wrangler checkout', { timeout: 240_000 }, async t => {
 const core = [['0040_auxiliary.sql', 'CREATE TABLE auxiliary (id TEXT PRIMARY KEY);'], recordsFile];
 const seed = await installedSeed(t, core);
 // The hosted export fixture has a plain Wrangler ledger and a hashed legacy
 // deployment ledger alongside it. Its manifest carries filenames sorted by
 // that legacy ledger, without a migrationLedger origin or owner entries.
 const ordered = core.toReversed();
 await seed.data(`CREATE TABLE _rer_deploy_migrations(name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, state TEXT NOT NULL);
  CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  ${ordered.map(([name, sql]) => `${sql}
   INSERT INTO d1_migrations(name) VALUES('${name}');
   INSERT INTO _rer_deploy_migrations VALUES('${name}','${createHash('sha256').update(sql).digest('hex')}','applied');`).join('\n')}
  ${insert}`);
 await seed.text(['export', '--output', 'exports/backup.rer']);
 const manifest = JSON.parse((await readFile(join(seed.root, 'exports/backup.rer'), 'utf8')).split('\n', 1)[0]);
 assert.equal(manifest.migrationLedger, undefined);
 assert.deepEqual(manifest.migrations, core.map(([name]) => name));
 await rename(seed.state, seed.state + '-source');
 const additive = '9999_additive.sql';
 await writeFile(join(seed.migrations, additive), 'CREATE TABLE later (id TEXT PRIMARY KEY);');
 await seed.text(restore);
 assert.deepEqual(await records(seed), [retainedRow]);
 assert.deepEqual((await seed.data('SELECT name FROM d1_migrations ORDER BY id'))[0].results.map(row => row.name),
  [...ordered.map(([name]) => name), additive]);
 assert.equal((await seed.data('SELECT count(*) AS n FROM later'))[0].results[0].n, 0);
});

test('the installed CLI completes import with an unchecked process inspection', { timeout: 240_000 }, async t => {
 const seed = await installedSeed(t, [recordsFile]);
 await seed.text(['export', '--output', 'exports/empty.rer']);
 await seed.data(insert);
 await seed.text(['export', '--output', 'exports/backup.rer']);
 await rename(seed.state, seed.state + '-source');

 const held = join(seed.root, 'held-inspection.log');
 const result = await seed.text(restore, 0, {
  preload: 'held-inspection.mjs',
  env: { RER_TEST_HELD_INSPECTION: held },
 });
 assert.match(await readFile(held, 'utf8'), /^\d+ SIGKILL$/m);
 assert.match(result.stdout + result.stderr, /process inspection did not answer/i);
 assert.deepEqual(await records(seed), [retainedRow]);
});
