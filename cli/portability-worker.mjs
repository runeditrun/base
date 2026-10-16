import { portabilityPlan, ensurePortabilitySchema } from '../modules/container/portability-schema.mjs';
import { exportArchive, importArchive, fileRecords } from '../modules/portability/files.mjs';
import { readLegacyArchive } from '../modules/portability/format.mjs';
import { recoverLegacyArchive } from '../modules/portability/legacy-files.mjs';
import { legacyTargetState, requireLegacyEmpty } from '../modules/portability/legacy-safety.mjs';
import { migrationReplay } from '../modules/portability/migration-history.mjs';
import { appliedMigrations as appliedMigrationNames } from '../modules/portability/bridge.mjs';
import { join } from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createPortability, PortabilityError, readArchive } from '../modules/portability/index.mjs';
import { parseJsonc } from './jsonc.mjs';
import { loadPolicy } from './portability-policy.mjs';

// The migrations this installation applied, in its ledger's order, so a
// restore can place an older archive within them.
async function appliedMigrations(root, db, binding, split) {
 const config = parseJsonc(await readFile(join(root, 'wrangler.jsonc'), 'utf8'));
 const directory = join(root, config.d1_databases.find(entry => entry.binding === binding).migrations_dir ?? 'migrations');
 const names = await appliedMigrationNames(db) ?? [];
 return Promise.all(names.map(async name => ({ name, statements: split(await readFile(join(directory, name), 'utf8')) })));
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
 // Validate all inputs before opening bindings or acquiring a restore lock.
 if (direction === 'import') {
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
  const migrations=async()=>migrationReplay(await appliedMigrations(root,proxy.env[binding],binding,unstable_splitSqlQuery),policy);
  const options={ db: proxy.env[binding], buckets: Object.fromEntries(Object.entries(buckets).map(([name, binding]) => [name, proxy.env[binding]])), policy, migrations };
  if(direction==='legacy-preflight') {
   await requireLegacyEmpty(options,await legacyTargetState(options.db,options.migrations));
   return {checkedEmpty:true};
  }
  await ensurePortabilitySchema(proxy.env[binding], await portabilityPlan(unstable_splitSqlQuery));
  if(legacyRecovery)return await recoverLegacyArchive(options,path,legacyRecovery.output,transient,legacyRecovery.acknowledged);
  const service = await createPortability(options);
  return await (direction === 'export' ? exportArchive(service,path,transient) : importArchive(service,path,transient,journal));
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
 process.exitCode = exitCode;
 await reply({ ok: false, code: exitCode === 2 ? 'invalid_archive' : exitCode === 4 ? 'restore_refused' : 'transfer_failed', reason, ...(migration ? { migration } : {}), exitCode });
}
