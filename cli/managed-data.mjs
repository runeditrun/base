import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createRequire } from 'node:module';
import { RerError } from './errors.mjs';
import { randomUUID } from 'node:crypto';
import { isManagedDataZip, readManagedDataZip } from './managed-data-zip.mjs';
import { loadPolicy } from './portability-policy.mjs';
import { managedSchema } from './managed-data-schema.mjs';
import { mapMigrationLedger, appliedMigrations, platformMigrationDeclaration, migrationInventory } from './portability-migrations.mjs';
import { createPortability, PortabilityError } from '../modules/portability/index.mjs';
import { readLedger } from '../modules/portability/ledgers.mjs';
import { exportArchive } from '../modules/portability/files.mjs';
import { portabilityPlan, ensurePortabilitySchema } from '../modules/container/portability-schema.mjs';
import { splitStatements } from '../modules/portability/sql-text.mjs';
import { sqliteTokens } from '../modules/portability/sqlite-tokens.mjs';

const check = (condition, reason) => { if (!condition) throw new PortabilityError('managed_data_' + reason, 409); };
const ledgerIdentity = entries => JSON.stringify(entries.map(({ name, sha256 }) => ({ name, sha256 })).sort((a, b) => a.name.localeCompare(b.name)));

// Optional adapter door. The callback still owns authentication, confirmation,
// custody and native restore. Only its input path changes, for this one call.
// Source SQL runs solely in a disposable workerd D1 sandbox, never in the target.
export async function withManagedDataImport(context, declaration, restore) {
 try { return await intake(context, declaration, restore); }
 catch (error) {
  if (!(error instanceof PortabilityError)) throw error;
  const reason = error.code.startsWith('managed_data_') ? error.code : error.code.split(':').slice(0, 2).join(':');
  throw new RerError(reason, `Managed data restore refused (${reason}). The destination has not accepted this archive.`, 4);
 }
}
async function intake(context, declaration, restore) {
 if (!await isManagedDataZip(context.path)) return restore(context);
 check(context.target === undefined || context.target === 'local', 'local_only');
 check(context.platform !== 'container' && !context.legacyRecovery && !context.journal, 'unsupported_options');
 const { root } = context, { binding = 'DB', buckets = {}, policy: inputPolicy, policyModule, platformMigrations, transient = [] } = declaration;
 const { manifest, entries } = await readManagedDataZip(context.path);
 check(manifest.databases.length === 1 && manifest.databases[0].binding === binding, 'binding_mismatch');
 check(manifest.buckets.every(bucket => Object.values(buckets).includes(bucket.binding)), 'binding_mismatch');
 const database = manifest.databases[0];
 await mapMigrationLedger({ root, binding, platformMigrations, entries: database.migrationLedger });
 check(database.migrationLedger.length > 0, 'missing_ledger');
 let policy = await loadPolicy(root, inputPolicy, policyModule);
 const { migrationReplay } = await import('../modules/portability/migration-history.mjs');
 const { getPlatformProxy, unstable_splitSqlQuery } = createRequire(join(root, 'package.json'))('wrangler');
 const directory = await mkdtemp(join(tmpdir(), 'rer-managed-data-'));
 let proxy;
 try {
  const configPath = join(directory, 'wrangler.json');
  await writeFile(configPath, JSON.stringify({ name: 'rer-managed-data', compatibility_date: '2026-09-01', d1_databases: [{ binding, database_name: 'rer-managed-data', database_id: randomUUID() }], r2_buckets: [...new Set(Object.values(buckets))].map(name => ({ binding: name, bucket_name: 'rer-managed-' + name.toLowerCase() })) }), { mode: 0o600 });
  proxy = await getPlatformProxy({ configPath, persist: { path: join(directory, 'state') }, remoteBindings: false });
  const db = proxy.env[binding];
  try {
   const sql = new TextDecoder('utf-8', { fatal: true }).decode(entries.get(database.dumpPath));
   check(Buffer.byteLength(sql) <= 16 * 1024 * 1024, 'oversized');
   const statements = splitStatements(sql);
   check(statements.length <= 10000, 'oversized');
   const prepared = [];
   for (const statement of statements) {
    context.signal?.throwIfAborted();
    const tokens = sqliteTokens(statement), head = tokens.slice(0, 3).map(token => token.text.toLowerCase());
    // No attach, extension, transaction or arbitrary query statements. Workerd
    // supplies the independent SQL limits and has no filesystem SQL functions.
    check(head[0] === 'create' && ['table', 'index', 'unique', 'view', 'trigger'].includes(head[1]) || head[0] === 'insert' && head[1] === 'into' || tokens.map(token => token.text.toLowerCase()).join('') === 'pragmadefer_foreign_keys=on', 'sql_refused');
    const values = head[0] === 'insert' ? tokens.findIndex(token => token.type === 'keyword' && token.text.toLowerCase() === 'values') : -1;
    check(!tokens.some(token => token.type === 'variable') && (head[0] !== 'insert' || values >= 0), 'sql_refused');
    // Bind cells only in a top-level INSERT. DDL stays literal, including
    // VALUES inside trigger bodies, where SQLite forbids bind parameters.
    let sql = '', offset = 0;
    const params = [];
    for (const token of values < 0 ? [] : tokens.slice(values + 1)) if (token.type === 'string') {
     const value = token.text.slice(1, -1).replaceAll("''", "'");
     check(Buffer.byteLength(value) <= 2 * 1024 * 1024 && params.length < 100, 'oversized');
     sql += statement.slice(offset, token.start) + '?'; offset = token.end; params.push(value);
    }
    sql += statement.slice(offset);
    check(Buffer.byteLength(sql) <= 100000, 'oversized');
    prepared.push(params.length ? db.prepare(sql).bind(...params) : db.prepare(sql));
   }
   await db.batch(prepared);
  } catch (error) {
   if (error instanceof PortabilityError || context.signal?.aborted) throw error;
   check(false, 'sql_refused');
  }
  const ledger = await readLedger(db);
  check(ledger?.table === 'rer_migrations' && ledgerIdentity(ledger.entries) === ledgerIdentity(database.migrationLedger), 'ledger_mismatch');
  for (const bucket of manifest.buckets) for (const object of bucket.objects) {
   context.signal?.throwIfAborted();
   await proxy.env[bucket.binding].put(object.key, entries.get(object.path), { httpMetadata: object.httpMetadata ?? {}, customMetadata: object.customMetadata ?? {} });
  }
  const boundBuckets = Object.fromEntries(Object.entries(buckets).map(([name, binding]) => [name, proxy.env[binding]]));
  policy = await loadPolicy(root, inputPolicy, policyModule, { db, buckets: boundBuckets });
  const schema = await managedSchema(db, await migrationInventory(root, binding, platformMigrationDeclaration(platformMigrations), unstable_splitSqlQuery), policy, ledger);
  await ensurePortabilitySchema(db, await portabilityPlan(unstable_splitSqlQuery));
  const migrations = async () => migrationReplay(await appliedMigrations(root, db, binding, platformMigrationDeclaration(platformMigrations), unstable_splitSqlQuery), policy, platformMigrationDeclaration(platformMigrations));
  const service = await createPortability({ db, buckets: boundBuckets, policy, migrations });
  const path = join(directory, 'native.rer');
  await exportArchive(service, path, transient);
  // Native import rechecks the complete archive and keeps all destination
  // emptiness, migration, erasure, row-safety and atomic publication checks.
  const result = await restore({ ...context, path });
  return result && typeof result === 'object' ? { ...result, ...(Object.hasOwn(result, 'input') ? { input: relative(root, context.path) } : {}), managedSchema: schema } : result;
 } finally { try { await proxy?.dispose(); } finally { await rm(directory, { recursive: true, force: true }); } }
}
