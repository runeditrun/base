import { randomUUID } from 'node:crypto';
import { readFile, readdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { privateDirectory, writePrivateFile } from './private-files.mjs';
import { selectLocalState } from './local/state.mjs';
import { labels } from './adapter-labels.mjs';

async function appliedNames(state, table) {
 const directory = join(state, 'v3/d1/miniflare-D1DatabaseObject'), names = new Set();
 let files;
 try { files = await readdir(directory); } catch (error) { if (error.code === 'ENOENT') return names; throw error; }
 for (const file of files.filter(name => name.endsWith('.sqlite'))) {
  const db = new DatabaseSync(join(directory, file), { readOnly: true });
  try {
   if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
    for (const row of db.prepare(`SELECT name FROM "${table.replaceAll('"', '""')}"`).all()) names.add(row.name);
   }
  } finally { db.close(); }
 }
 return names;
}

// Vite's last build copied only the migrations that existed then. Keep its D1
// identity, but give Wrangler the complete current source inventory, including
// files just acquired by git pull. The temporary config contains no app vars.
export async function migrateOperator(context, database) {
 const { root, demo, store } = context;
 const config = JSON.parse(await readFile(join(root, 'dist/server/wrangler.json'), 'utf8'));
 const binding = config.d1_databases?.find(item => item.database_name === database || item.binding === database);
 if (!binding) throw new Error(`Local migration database ${database} is missing from the built configuration. Run rer setup.`);
 const state = resolve(root, demo?.state ?? await selectLocalState(root));
 const inventory = resolve(root, 'migrations/core');
 const names = (await readdir(inventory)).filter(name => name.endsWith('.sql')).sort();
 const table = binding.migrations_table ?? 'd1_migrations';
 const before = await appliedNames(state, table);
 const directory = await privateDirectory(root, ['.rer', 'local']);
 const path = join(directory, `migrations-${randomUUID()}.json`);
 await writePrivateFile(path, JSON.stringify({ name: config.name, compatibility_date: config.compatibility_date,
  d1_databases: [{ ...binding, migrations_dir: inventory, migrations_pattern: `${inventory}/*.sql` }] }));
 try {
  await context.run(labels.migrate, 'pnpm', ['exec', 'wrangler', 'd1', 'migrations', 'apply', database,
   '--local', '--persist-to', state, '--config', path], { step: 'setup' });
  const after = await appliedNames(state, table);
  const applied = names.filter(name => !before.has(name) && after.has(name));
  if (applied.length) store.report(`Applied local migrations: ${applied.join(', ')}`);
 } finally { await unlink(path); }
}
