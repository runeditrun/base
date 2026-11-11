import '../sqlite-notice.mjs';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { readMigrationRewrites, withRewrites } from '../../modules/deploy-kit/migrations.mjs';
import { RerError, missing } from '../errors.mjs';
import { defaultBuild } from './build-paths.mjs';

// The schema a build's D1 binding gets: its migrations, in order, in a fresh
// in-memory SQLite. Nothing here reaches a network or an account.
async function migrationFiles(directory) {
  const names = (await readdir(directory)).filter(name => name.endsWith('.sql')).sort();
  return Promise.all(names.map(async name => ({ name, sql: await readFile(join(directory, name), 'utf8') })));
}

// A build's missing migrations directory is an empty database, as serveHosted reads it.
async function apply(directory, label, { optional = false } = {}) {
  const { DatabaseSync } = await import('node:sqlite');
  // Foreign keys are D1's to enforce; here only the schema objects matter. D1 (and local D1) accepts a double-quoted
  // string literal where no such column exists, and a statement that does so must compile here too.
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: false, enableDoubleQuotedStringLiterals: true });
  let files;
  try { files = await migrationFiles(directory); }
  catch (error) { if (optional && error.code === 'ENOENT') files = []; else throw missing(`Cannot read the migrations of ${label} at ${directory}: ${error.code ?? error.message}.`); }
  for (const { name, sql } of files) {
    try { db.exec(sql); }
    catch (error) { throw new RerError('size_schema_invalid', `Migration ${name} of ${label} does not apply in SQLite: ${error.message}`, 1); }
  }
  return { db, migrations: files.length };
}

/** One schema from a directory of migrations: { db, migrations }. */
export const schemaFromMigrations = directory => apply(resolve(directory), resolve(directory));

/** The build's D1 databases, each with its migrations applied as serveHosted
 * does (the build's wrangler file, dist/server/wrangler.json unless `wrangler`
 * names another, d1_databases[].migrations_dir from that file's folder, with the
 * seed's reviewed migration rewrites checked against the migrations'
 * current bytes): [{ binding, db, migrations }]. An empty list is a build
 * with no D1 binding; no build is a missing input. */
export async function schemasFromBuild(root, { wrangler = defaultBuild.wrangler } = {}) {
  const file = join(root, wrangler), build = dirname(file);
  let config;
  try { config = JSON.parse(await readFile(file, 'utf8')); }
  catch { throw missing(`No production build at ${wrangler}. Run rer build, or point --migrations at a directory of D1 migrations.`); }
  const schemas = [];
  for (const item of config.d1_databases ?? []) {
    const directory = resolve(build, item.migrations_dir ?? 'migrations');
    const files = await migrationFiles(directory).catch(() => []);
    try {
      withRewrites(files.map(({ name, sql }) => ({ name, sha256: createHash('sha256').update(sql).digest('hex') })), await readMigrationRewrites(root), { partial: true });
    } catch (error) { throw new RerError('size_schema_invalid', `The migration rewrites of ${item.binding} do not match its migrations (${error.message}).`, 1); }
    schemas.push({ binding: item.binding, ...await apply(directory, `database ${item.binding}`, { optional: true }) });
  }
  return schemas;
}
