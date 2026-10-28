import { DatabaseSync } from 'node:sqlite';
import { createHash, createHmac } from 'node:crypto';
import { copyFile, lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseJsonc } from './jsonc.mjs';
import { loadPolicy } from './portability-policy.mjs';
import { appliedMigrations, platformMigrationDeclaration } from './portability-migrations.mjs';
import { migrationReplay } from '../modules/portability/migration-history.mjs';
import { splitStatements } from '../modules/portability/sql-text.mjs';
import { requireEmptyTables } from '../modules/portability/restore-empty.mjs';
import { insist } from '../modules/portability/storage.mjs';
import { shared } from './shared.mjs';

const status = path => lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
// Miniflare's named D1 identity: the declared binding determines its file.
function databaseFile(id) {
 const key = createHash('sha256').update('miniflare-D1DatabaseObject').digest();
 const name = createHmac('sha256', key).update(id).digest().subarray(0, 16);
 return Buffer.concat([name, createHmac('sha256', key).update(name).digest().subarray(0, 16)]).toString('hex') + '.sqlite';
}

// Called under the runner's stopped-writer custody and operation lock. Even a
// read-only SQLite connection can checkpoint or alter shared memory: open only
// a private copy, including existing journal sidecars, before any native proxy.
export async function emptyNativePreflight({ root, binding, policy, policyModule, platformMigrations }) {
 const { selectLocalState } = await shared('local/state.mjs');
 const state = await selectLocalState(root);
 const config = parseJsonc(await readFile(join(root, 'wrangler.jsonc'), 'utf8'));
 const bindings = config.d1_databases?.filter(entry => entry.binding === binding) ?? [];
 insist(bindings.length === 1, 'migration_ledger:binding', 409);
 const id = bindings[0].preview_database_id ?? bindings[0].database_id;
 insist(typeof id === 'string' && id.length > 0, 'migration_ledger:binding', 409);
 let parent = state;
 for (const part of ['v3', 'd1', 'miniflare-D1DatabaseObject']) {
  parent = join(parent, part); const info = await status(parent);
  if (!info) return;
  insist(info.isDirectory() && !info.isSymbolicLink(), 'restore_state_unsafe', 409);
 }
 const path = join(parent, databaseFile(id)), paths = [path, path + '-wal', path + '-journal'];
 const before = await Promise.all(paths.map(status));
 if (!before[0]) return;
 insist(before.every(info => !info || info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.uid === process.getuid()), 'restore_state_unsafe', 409);
 const directory = await mkdtemp(join(tmpdir(), 'rer-empty-preflight-')); let snapshot;
 try {
  for (let i = 0; i < paths.length; i++) if (before[i]) await copyFile(paths[i], join(directory, 'database.sqlite' + paths[i].slice(path.length)));
  const after = await Promise.all(paths.map(status));
  insist(before.every((info, i) => info ? after[i] && ['ino', 'size', 'mtimeMs', 'ctimeMs'].every(key => info[key] === after[i][key]) : !after[i]), 'restore_state_changed', 409);
  snapshot = new DatabaseSync(join(directory, 'database.sqlite'), { readOnly: true });
  // Wrangler can create a D1 file before any product migrations run. Only
  // literal SQLite/Cloudflare engine internals may exist in that empty file;
  // policy exclusions and migration ledgers do not make other schema empty.
  // Every existing product/foreign object still goes through the full policy
  // and occupied-table checks before migrations can change the destination.
  if (!snapshot.prepare("SELECT 1 FROM sqlite_master WHERE substr(lower(name),1,7) <> 'sqlite_' AND substr(lower(name),1,4) <> '_cf_' LIMIT 1").get()) return;
  const db = { prepare(sql) { const query = snapshot.prepare(sql); let values = []; return {
   bind(...args) { values = args; return this; },
   async all() { return { results: query.all(...values) }; },
   async first() { return query.get(...values) ?? null; },
  }; } };
  const rules = await loadPolicy(root, policy, policyModule), declaration = platformMigrationDeclaration(platformMigrations);
  const migrations = async () => migrationReplay(await appliedMigrations(root, db, binding, declaration, splitStatements), rules, declaration);
  await requireEmptyTables({ db, policy: rules, migrations });
 } finally { try { snapshot?.close(); } finally { await rm(directory, { recursive: true, force: true }); } }
}
