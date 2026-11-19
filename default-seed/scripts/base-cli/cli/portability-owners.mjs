import { randomUUID } from 'node:crypto';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sourcePath } from '../modules/delivery-producer/migrations.mjs';
import { ledgerNames } from '../modules/portability/ledgers.mjs';
import { insist } from '../modules/portability/storage.mjs';
import { deliveryDeclarationSources } from './delivery-declarations.mjs';
import { parseJsonc } from './jsonc.mjs';
export { nativeMigrationHistory, ownerMigrationPolicy } from '../modules/portability/owner-history.mjs';

// Delivery declares the extra directories and their prefixes. Native Wrangler
// uses the edition's permanent <project>_<prefix>_migrations ledger for each.
export async function ownerMigrationSources(root, binding) {
 let directories;
 for (const [path, select] of deliveryDeclarationSources) {
  const file = await sourcePath(root, path, { optional: true });
  if (!file) continue;
  directories = select(JSON.parse(await readFile(file, 'utf8')))?.extraMigrationDirectories;
  if (directories !== undefined) break;
 }
 directories ??= [];
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
