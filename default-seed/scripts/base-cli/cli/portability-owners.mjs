import { randomUUID } from 'node:crypto';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sourcePath } from '../modules/delivery-producer/migrations.mjs';
import { ledgerNames, readLedger } from '../modules/portability/ledgers.mjs';
import { all, insist, quote } from '../modules/portability/storage.mjs';
import { parseJsonc } from './jsonc.mjs';

// Delivery declares the extra directories and their prefixes. Native Wrangler
// uses the edition's permanent <project>_<prefix>_migrations ledger for each.
export async function ownerMigrationSources(root, binding) {
 let packaging;
 try { packaging = JSON.parse(await readFile(join(root, 'rer-packaging.json'), 'utf8')); }
 catch (error) { if (error.code === 'ENOENT') return []; throw error; }
 const directories = packaging.artifact?.specInputs?.extraMigrationDirectories ?? [];
 insist(Array.isArray(directories), 'migration_ledger:incompatible', 409);
 const sources = directories.filter(source => source.binding === binding);
 if (!sources.length) return [];
 const { name } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
 const project = name?.split('/').at(-1).replaceAll('-', '_');
 insist(typeof project === 'string' && /^[a-z][a-z0-9_]*$/.test(project), 'migration_ledger:incompatible', 409);
 const selected = await Promise.all(sources.map(async ({ path, prefix, optional }) => {
  insist(typeof prefix === 'string' && /^[a-z][a-z0-9_-]*-$/.test(prefix), 'migration_ledger:incompatible', 409);
  const table = project + '_' + prefix.slice(0, -1).replaceAll('-', '_') + '_migrations';
  insist(!ledgerNames.includes(table), 'migration_ledger:ambiguous', 409);
  const directory = await sourcePath(root, path, { kind: 'directory', optional: optional === true });
  return { directory, prefix, table };
 }));
 insist(new Set(selected.map(source => source.table)).size === selected.length, 'migration_ledger:ambiguous', 409);
 return selected;
}

export function ownerMigrationPolicy(policy, sources) {
 if (!sources.length) return policy;
 const tables = sources.map(source => source.table);
 insist(!policy.includeTables?.some(name => tables.includes(name.toLowerCase())), 'migration_ledger:incompatible', 409);
 return { ...policy, excludeTables: [...new Set([...(policy.excludeTables ?? []), ...tables])] };
}

const timestamp = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/;
async function nativeRows(db, table, owner = false) {
 const columns = await all(db, `PRAGMA table_info(${quote(table)})`);
 if (!columns.length) return [];
 insist((!owner || columns.length === 3) && columns[0]?.name === 'id' && columns[0].pk === 1 && columns[1]?.name === 'name'
  && columns[2]?.name === 'applied_at', 'migration_ledger:incompatible', 409);
 const rows = await all(db, `SELECT name, applied_at FROM ${quote(table)} ORDER BY id`);
 insist(new Set(rows.map(row => row.name)).size === rows.length
  && rows.every((row, i) => typeof row.name === 'string' && timestamp.test(row.applied_at)
   && (!i || rows[i - 1].applied_at <= row.applied_at)), 'migration_ledger:incompatible', 409);
 return rows;
}

export async function nativeMigrationHistory(db, sources) {
 const ledger = await readLedger(db);
 const owners = (await Promise.all(sources.map(async ({ table, prefix }) =>
  (await nativeRows(db, table, true)).map(row => ({ ...row, name: prefix + row.name, table }))))).flat();
 if (!owners.length) return ledger;
 insist(ledger?.table === 'd1_migrations', 'migration_ledger:multiple', 409);
 const core = (await nativeRows(db, ledger.table)).map((row, i) => ({ ...ledger.entries[i], applied_at: row.applied_at, table: ledger.table }));
 const rows = [...core, ...owners].sort((a, b) => a.applied_at.localeCompare(b.applied_at));
 // IDs order each ledger. Across ledgers equal timestamps carry no order.
 insist(rows.every((row, i) => !i || row.applied_at !== rows[i - 1].applied_at || row.table === rows[i - 1].table), 'migration_ledger:uncertain', 409);
 const entries = rows.map(({ name, sha256 }) => ({ name, ...(sha256 ? { sha256 } : {}) }));
 insist(new Set(entries.map(row => row.name)).size === entries.length, 'migration_ledger:ambiguous', 409);
 return { table: ledger.table, entries, owners: true };
}

export async function applyNativeOwnerMigrations({ root, binding, sources, store, signal, env }) {
 if (!sources.some(source => source.directory)) return;
 const config = parseJsonc(await readFile(join(root, 'wrangler.jsonc'), 'utf8'));
 const target = config.d1_databases.find(entry => entry.binding === binding);
 for (const { table, directory } of sources) {
  if (!directory || !(await readdir(directory)).some(name => name.endsWith('.sql'))) continue;
  const path = join(root, '.wrangler', `rer-owner-migrations-${randomUUID()}.json`);
  try {
   await writeFile(path, JSON.stringify({
    name: config.name, compatibility_date: config.compatibility_date,
    d1_databases: [{ ...target, migrations_dir: directory, migrations_table: table }],
   }), { mode: 0o600, flag: 'wx' });
   await store.run('Applying local owner migrations', 'pnpm', ['exec', 'wrangler', 'd1', 'migrations', 'apply', binding, '--local', '--persist-to', '.wrangler/state', '--config', path], { cwd: root, signal, env });
  } finally { await rm(path, { force: true }); }
 }
}
