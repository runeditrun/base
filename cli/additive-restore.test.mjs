import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { portabilityFixture } from './fixtures/portability.mjs';

const additive = `CREATE TABLE later_notes (id TEXT PRIMARY KEY, body TEXT NOT NULL);
ALTER TABLE computed_entries ADD COLUMN priority INTEGER NOT NULL DEFAULT 5;
CREATE INDEX computed_entries_priority ON computed_entries(priority);`;

// An owner's backup outlives the release that made it: later migrations that only
// add tables, defaulted columns or indexes must not strand it. Any other schema
// difference is still refused before anything is written.
test('an archive made before later additive migrations restores into the upgraded installation, over rows the migrations seed; other differences are refused', { timeout: 15 * 60_000 }, async t => {
 const seed = await portabilityFixture(t);
 const migration = name => join(seed.root, 'migrations/core', name);
 await seed.run(['export', '--output', 'exports/empty.rer']);
 await seed.data("INSERT INTO computed_entries(id,quantity,unit_price,label) VALUES('first',3,125,'café'),('second',2,75,NULL)");
 const original = 'SELECT id,quantity,unit_price,label,total,description FROM computed_entries ORDER BY id', rows = (await seed.data(original))[0].results;
 await seed.run(['export', '--output', 'exports/older.rer']);

 await writeFile(migration('1000_later.sql'), additive);
 await seed.run(['reset', '--yes']);
 const restored = (await seed.run(['import', '--input', 'exports/older.rer', '--yes'])).at(-1);
 assert.deepEqual(restored.bridged.migrations, ['1000_later.sql']);
 assert.deepEqual(restored.bridged.tables, ['later_notes']);
 assert.deepEqual(restored.bridged.columns, { computed_entries: ['priority'] });
 assert.deepEqual((await seed.data(original))[0].results, rows);
 assert.deepEqual((await seed.data('SELECT DISTINCT priority FROM computed_entries'))[0].results, [{ priority: 5 }]);
 assert.equal((await seed.data('SELECT COUNT(*) AS n FROM later_notes'))[0].results[0].n, 0);

 // The restored installation's own archive is current and imports normally.
 const current = (await seed.run(['export', '--output', 'exports/current.rer'])).at(-1);
 await seed.run(['reset', '--yes']);
 const again = (await seed.run(['import', '--input', 'exports/current.rer', '--yes'])).at(-1);
 assert.equal(again.contentHash, current.contentHash);
 assert.equal(again.bridged, undefined);

 const refused = async (file, reason) => {
  await seed.run(['reset', '--yes']);
  const events = await seed.run(['import', '--input', file, '--yes'], 4);
  assert.match(events.find(event => event.event === 'error').message, reason);
  assert.equal((await seed.data('SELECT COUNT(*) AS n FROM computed_entries'))[0].results[0].n, 0);
  assert.equal((await seed.data('SELECT COUNT(*) AS n FROM rer_portability_jobs'))[0].results[0].n, 0);
 };
 // A migration the archive has and this installation lacks.
 await unlink(migration('1000_later.sql'));
 await refused('exports/current.rer', /schema_mismatch/);
 // A later migration that renames a column is not additive.
 await writeFile(migration('1000_later.sql'), additive);
 await writeFile(migration('1001_rename.sql'), 'ALTER TABLE computed_entries RENAME COLUMN label TO caption;');
 await refused('exports/older.rer', /schema_mismatch/);
 // A later migration that adds a column and also purges rows would be skipped by
 // the restored rows, so it is refused like any other non-additive change.
 await unlink(migration('1001_rename.sql'));
 await writeFile(migration('1001_purge.sql'), "ALTER TABLE computed_entries ADD COLUMN reviewed INTEGER;\nDELETE FROM computed_entries WHERE label IS NULL;");
 await refused('exports/older.rer', /schema_mismatch/);
 // A later purge or backfill leaves the schema as the archive has it, yet its rows
 // would still skip the change: refused, naming the migration. An index restores.
 await unlink(migration('1001_purge.sql'));
 await writeFile(migration('1001_purge.sql'), 'DELETE FROM computed_entries WHERE label IS NULL;');
 await refused('exports/current.rer', /schema_mismatch:migration_data\): migration 1001_purge\.sql/);
 await unlink(migration('1001_purge.sql'));
 await writeFile(migration('1001_backfill.sql'), "UPDATE computed_entries SET label='unlabelled' WHERE label IS NULL;");
 await refused('exports/current.rer', /schema_mismatch:migration_data\): migration 1001_backfill\.sql/);
 await unlink(migration('1001_backfill.sql'));
 await writeFile(migration('1001_index.sql'), 'CREATE INDEX computed_entries_label ON computed_entries(label);');
 await seed.run(['reset', '--yes']);
 assert.equal((await seed.run(['import', '--input', 'exports/current.rer', '--yes'])).at(-1).contentHash, current.contentHash);
 assert.deepEqual((await seed.data(original))[0].results, rows);
 // An archive from an installation one index ahead has this schema, but names a
 // migration this installation never applied: it is newer, and refused.
 await seed.run(['export', '--output', 'exports/newer.rer']);
 await unlink(migration('1001_index.sql'));
 await refused('exports/newer.rer', /schema_mismatch/);

 // A fresh installation holds the rows its own migrations insert, as a seed's
 // default settings: they are not the owner's data and do not block a restore.
 await writeFile(migration('1002_settings.sql'), "CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);\nINSERT INTO app_settings VALUES('currency','USD'),('week_start','monday');");
 const settings = 'SELECT key,value FROM app_settings ORDER BY key', defaults = [{ key: 'currency', value: 'USD' }, { key: 'week_start', value: 'monday' }];
 await seed.run(['reset', '--yes']);
 // An archive made before the settings table restores and keeps its seeded rows.
 assert.deepEqual((await seed.run(['import', '--input', 'exports/current.rer', '--yes'])).at(-1).bridged.tables, ['app_settings']);
 assert.deepEqual((await seed.data(settings))[0].results, defaults);
 // The owner's changed setting in an archive replaces the fresh installation's default.
 await seed.data("UPDATE app_settings SET value='EUR' WHERE key='currency'");
 const edited = (await seed.run(['export', '--output', 'exports/settings.rer'])).at(-1);
 await seed.run(['reset', '--yes']);
 assert.equal((await seed.run(['import', '--input', 'exports/settings.rer', '--yes'])).at(-1).contentHash, edited.contentHash);
 assert.deepEqual((await seed.data(settings))[0].results, [{ key: 'currency', value: 'EUR' }, defaults[1]]);
 assert.deepEqual((await seed.data(original))[0].results, rows);
 // A row the migrations did not insert still refuses, naming its table and the next step.
 // The refused newer archive leaves a reset, migrated installation.
 await refused('exports/newer.rer', /schema_mismatch/);
 await seed.data("INSERT INTO app_settings VALUES('locale','en-AU')");
 const occupied = await seed.run(['import', '--input', 'exports/settings.rer', '--yes'], 4);
 assert.match(occupied.find(event => event.event === 'error').message, /^Restore refused \(target_not_empty\): table app_settings in this installation already holds rows its migrations did not insert, .*rer reset --yes and rer import --input exports\/settings\.rer --yes again\.$/);
 assert.deepEqual((await seed.data(settings))[0].results, [{ key: 'currency', value: 'USD' }, { key: 'locale', value: 'en-AU' }, defaults[1]]);
});
