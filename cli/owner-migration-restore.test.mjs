import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, readdir, rm, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { portabilityFixture } from './fixtures/portability.mjs';

test('local restore replays the exported owner migration and refuses a different one', {timeout: 240_000}, async t => {
 const seed = await portabilityFixture(t, {generated: false});
 const coreDirectory = join(seed.root, 'migrations/core');
 for (const file of await readdir(coreDirectory)) await rm(join(coreDirectory, file));
 const core = '0999_records.sql', owner = '0001_owner.sql';
 await writeFile(join(coreDirectory, core), 'CREATE TABLE restore_records(id TEXT PRIMARY KEY);');
 const ownerDirectory = join(seed.root, 'migrations/ext'), ownerFile = join(ownerDirectory, owner);
 await mkdir(ownerDirectory);
 const alter = 'ALTER TABLE restore_records ADD COLUMN owner_note TEXT;';
 await writeFile(ownerFile, alter);
 await writeFile(join(seed.root, 'rer-packaging.json'), JSON.stringify({
  artifact: {specInputs: {extraMigrationDirectories: [{binding: 'DB', path: 'migrations/ext', prefix: 'ext-'}]}},
 }));
 const {name} = JSON.parse(await readFile(join(seed.root, 'package.json'), 'utf8'));
 const ledger = name.split('/').at(-1).replaceAll('-', '_') + '_ext_migrations';
 const adapter = join(seed.root, 'scripts/installer/local.mjs');
 await writeFile(adapter, (await readFile(adapter, 'utf8')).replace('policy: portabilityPolicy', "policy: { product: 'synthetic/owner-migrations' }"));

 // Initialize core state via the public command, then record the owner ALTER
 // with Wrangler's native ledger shape. The restored states start from scratch.
 await seed.text(['export', '--output', 'exports/core.rer']);
 await seed.data(`${alter}
  CREATE TABLE ${ledger}(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);
  INSERT INTO ${ledger}(name, applied_at) SELECT '${owner}', datetime(max(applied_at), '+1 second') FROM d1_migrations;
  INSERT INTO restore_records VALUES('first', 'owner data');`);
 await seed.text(['export', '--output', 'exports/owner.rer']);
 const manifest = JSON.parse((await readFile(join(seed.root, 'exports/owner.rer'), 'utf8')).split('\n', 1)[0]);
 assert.deepEqual(manifest.migrations, [core, 'ext-' + owner]);
 assert.ok(!manifest.tables.some(table => table.name === ledger));

 const state = join(seed.root, '.wrangler/state');
 await rename(state, state + '-source');
 await seed.text(['import', '--input', 'exports/owner.rer', '--yes']);
 assert.deepEqual((await seed.data('SELECT owner_note FROM restore_records'))[0].results, [{owner_note: 'owner data'}]);

 await rename(state, state + '-restored');
 await writeFile(ownerFile, 'ALTER TABLE restore_records ADD COLUMN different_note TEXT;');
 const refused = await seed.text(['import', '--input', 'exports/owner.rer', '--yes'], 4);
 assert.match(refused.stderr, /schema_mismatch:owner_migration_history/);
 assert.deepEqual((await seed.data('SELECT id FROM restore_records'))[0].results, []);
});
