import { portabilityPlan, ensurePortabilitySchema } from '../modules/container/portability-schema.mjs';
import { exportArchive, importArchive, fileRecords } from '../modules/portability/files.mjs';
import { readLegacyArchive } from '../modules/portability/format.mjs';
import { recoverLegacyArchive } from '../modules/portability/legacy-files.mjs';
import { legacyTargetState, requireLegacyEmpty } from '../modules/portability/legacy-safety.mjs';
import { migrationReplay } from '../modules/portability/migration-history.mjs';
import { splitStatements } from '../modules/portability/sql-text.mjs';
import { appliedMigrations as appliedMigrationNames } from '../modules/portability/bridge.mjs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createPortability, PortabilityError, readArchive } from '../modules/portability/index.mjs';
import { transferProgress } from '../modules/portability/progress.mjs';
import { nativeFailure, stateBytes } from './portability-progress.mjs';
import { parseJsonc } from './jsonc.mjs';
import { loadPolicy } from './portability-policy.mjs';

// The migrations this installation applied, in its ledger's order, with each
// file's hash, so a restore can place an older archive within them. Statements
// are split at SQLite's own boundaries (sql-text.mjs), not Wrangler's: its
// splitter can glue a trigger holding CASE ... END to the statements after it.
async function appliedMigrations(root, db, binding) {
 const config = parseJsonc(await readFile(join(root, 'wrangler.jsonc'), 'utf8'));
 const directory = join(root, config.d1_databases.find(entry => entry.binding === binding).migrations_dir ?? 'migrations');
 const names = await appliedMigrationNames(db) ?? [];
 return Promise.all(names.map(async name => {
  const bytes = await readFile(join(directory, name));
  return { name, statements: splitStatements(bytes.toString('utf8')), sha256: createHash('sha256').update(bytes).digest('hex') };
 }));
}

// Transfers read only the D1 database and R2 buckets. A configuration with just
// those keeps the app's other bindings out of the proxy: a Durable Object class
// it cannot export otherwise makes workerd print a warning on every transfer.
async function dataConfiguration(root) {
 const config = parseJsonc(await readFile(join(root, 'wrangler.jsonc'), 'utf8'));
 const directory = join(root, '.wrangler'), path = join(directory, `rer-portability-${process.pid}.json`);
 await mkdir(directory, { recursive: true });
 await writeFile(path, JSON.stringify(Object.fromEntries(['name', 'compatibility_date', 'compatibility_flags', 'd1_databases', 'r2_buckets'].filter(key => config[key] !== undefined).map(key => [key, config[key]]))), { mode: 0o600 });
 return path;
}

async function run(direction, { root, path, journal, binding, buckets, policy, policyModule, transient, legacyRecovery }) {
 // Lines for the person go to the CLI over IPC, which prints them as the command's progress.
 const progress = transferProgress(line => process.send({ progress: line }));
 if (!legacyRecovery && ['export', 'import'].includes(direction)) progress({ phase: 'start', direction, bytes: direction === 'export' ? await stateBytes(join(root, '.wrangler/state')) : (await stat(path)).size });
 // Validate all inputs before opening bindings or acquiring a restore lock.
 if (direction === 'import') {
  progress({ phase: 'checking', direction });
  for await (const record of fileRecords(path,legacyRecovery?readLegacyArchive:readArchive)) {}
  if(journal)for await(const record of fileRecords(journal)) {}
 }
 policy = await loadPolicy(root, policy, policyModule);
 if (direction === 'policy-preflight') return { checkedPolicy: true };
 const { getPlatformProxy, unstable_splitSqlQuery } = createRequire(join(root, 'package.json'))('wrangler');

 // Unlike Wrangler's --persist-to base, the API takes the versioned directory.
 const configPath = await dataConfiguration(root);
 let proxy;
 try {
  proxy = await getPlatformProxy({ configPath, persist: { path: join(root, '.wrangler/state/v3') }, remoteBindings: false });
  const migrations=async()=>migrationReplay(await appliedMigrations(root,proxy.env[binding],binding),policy);
  const options={ db: proxy.env[binding], buckets: Object.fromEntries(Object.entries(buckets).map(([name, binding]) => [name, proxy.env[binding]])), policy, migrations };
  if(direction==='legacy-preflight') {
   await requireLegacyEmpty(options,await legacyTargetState(options.db,options.migrations));
   return {checkedEmpty:true};
  }
  await ensurePortabilitySchema(proxy.env[binding], await portabilityPlan(unstable_splitSqlQuery));
  if(legacyRecovery)return await recoverLegacyArchive(options,path,legacyRecovery.output,transient,legacyRecovery.acknowledged);
  const service = await createPortability(options);
  // This checkout's operation lock means no other import can be running. Abort
  // the recorded abandoned job, dropping only its exact staging copies and
  // sidecars before the replacement import creates its own scratch tables.
  if (direction === 'import' && await service.imports.abortAbandoned()) process.send({ progress: 'Cleaned up an unfinished earlier import: a restore that stopped part-way left its staged data here. Its staging is removed and this import starts from the beginning.' });
  return await (direction === 'export' ? exportArchive(service,path,transient,progress) : importArchive(service,path,transient,journal,progress));
 } finally { await proxy?.dispose(); await rm(configPath, { force: true }); }
}

// The receipt goes to the CLI over IPC: nothing it holds reaches the terminal.
const reply = message => new Promise(resolve => process.send(message, () => { process.disconnect(); resolve(); }));
try { await reply({ ok: true, ...await run(process.argv[2], JSON.parse(process.argv[3])) }); }
catch (error) {
 // Erasure-fence refusals name the fence: an older archive is refused, not a failed transfer.
 const refusal = error instanceof PortabilityError && (error.status === 409 || ['wrong_product', 'schema_mismatch', 'table_inventory', 'configuration_inventory', 'erased_row', 'erasure_epoch', 'later_journal', 'invalid_journal', 'staged_validation'].includes(error.code.split(':')[0]));
 const exitCode = error.message === 'archive_json' ? 2 : refusal || error.code === 'EEXIST' ? 4 : 1;
 // Report only symbolic codes; native database errors can contain private data.
 const reason = error instanceof PortabilityError ? error.code.split(':')[0] : /^[A-Z_]+$/.test(error.code ?? '') ? error.code : error.message === 'archive_json' ? 'archive_json' : 'native_error';
 // A later migration that changes restorable data is named: it is a file of this installation.
 const migration = error instanceof PortabilityError && error.code.startsWith('schema_mismatch:migration_data:') ? error.code.slice('schema_mismatch:migration_data:'.length) : undefined;
 // A populated destination names its table or bucket: schema names, never row data.
 const occupied = error instanceof PortabilityError && /^(target|bucket)_not_empty:/.test(error.code) ? error.code.slice(error.code.indexOf(':') + 1) : undefined;
 // Safety diagnostics contain only policy schema names, never source values.
 const safety = error instanceof PortabilityError && error.code.startsWith('import_row_') ? error.code.slice(error.code.indexOf(':')+1) : undefined;
 // Anything that is not a portability refusal names its class and code, never its message: that can hold row data.
 const native = error instanceof PortabilityError || error.message === 'archive_json' ? undefined : nativeFailure(error);
 process.exitCode = exitCode;
 await reply({ ok: false, code: exitCode === 2 ? 'invalid_archive' : exitCode === 4 ? 'restore_refused' : 'transfer_failed', reason, ...(migration ? { migration } : {}), ...(occupied ? { occupied } : {}), ...(safety ? { safety } : {}), ...(native ? { native } : {}), exitCode });
}
