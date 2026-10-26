import { lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { relative } from 'node:path';
import { readArchive, PortabilityError } from '../modules/portability/index.mjs';
import { readLegacyArchive } from '../modules/portability/format.mjs';
import { fileRecords } from '../modules/portability/files.mjs';
import { RerError, refuse } from './errors.mjs';
import { policyModuleURL, serializablePolicy } from './portability-policy.mjs';
import { shared } from './shared.mjs';
import { ledgerRefusal } from './ledger-refusal.mjs';

const reExport = 'Re-export from the original installation with rer export --output exports/recovered.rer (add --target remote for a hosted installation), then retry rer import --input exports/recovered.rer --yes. Keep the original archive until recovery succeeds.';

// Seeds declare their real bindings and data policy. The shared module owns the
// archive format and atomic restore; the shared runner owns its native children.
export function localPortability({ database, binding = 'DB', buckets = {}, policy, policyModule, transient = [], platformMigrations }) {
 async function run({ root, path, journal, store, signal, operationToken, platform, legacyRecovery, acknowledgeUnverifiedSchemaObjects }, direction) {
  if (direction === 'export') {
   if (await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) throw refuse('Export requires a new archive path.');
  }
  if(legacyRecovery && (!legacyRecovery.acknowledged || await lstat(legacyRecovery.output).catch(error=>{if(error.code==='ENOENT')return null;throw error;})))throw refuse('Legacy recovery requires acknowledgement and a new output archive path.');
  if (direction === 'import') {
   // Refuse damaged or unverifiable archives before migrations open the
   // destination database. Worker and finalization verify again before publish.
   try {
    for await (const record of fileRecords(path,legacyRecovery?readLegacyArchive:readArchive)) {}
    if(journal)for await(const record of fileRecords(journal)) {}
   }
   catch (error) {
    if (error.message === 'archive_json') throw new RerError('invalid_archive', `Restore refused: the archive is damaged or incomplete. ${reExport}`, 2);
    if (!(error instanceof PortabilityError)) throw error;
    const message = error.code === 'legacy_archive_unverifiable'
     ? 'Restore refused (legacy_archive_unverifiable): version 1 metadata cannot be authenticated. Upgrade the original installation and re-export, or use rer import --legacy-v1 --input FILE --yes --acknowledge-unverified-metadata --output exports/recovered-v2.rer in an empty installation. See modules/portability/README.md#backup-only-v1-recovery.'
     : `Restore refused (${error.code}): archive verification failed. ${reExport}`;
    const refused = error.status === 409;
    throw new RerError(refused ? 'restore_refused' : 'transfer_failed', message, refused ? 4 : 1);
   }
  }
  if(legacyRecovery)store.report('Legacy v1 recovery: manifest metadata is unverified. Restored data will be audited and exported to a new v2 backup.');
  let declaration;
  try {
   if (policyModule !== undefined) {
    if (policy !== undefined) throw new PortabilityError('ambiguous_policy', 409);
    if (platform === 'container') throw new PortabilityError('container_policy_module_unsupported', 409);
    declaration = { policyModule: await policyModuleURL(root, policyModule) };
   } else declaration = { policy: serializablePolicy(policy) };
  } catch (error) {
   if (!(error instanceof PortabilityError)) throw error;
   throw refuse(`Local portability policy refused (${error.code}). Executable policies require a seed-owned policyModule with a valid default policy export; policyModule requires native local transport.`);
  }
  if(platform==='container') return (await import('./container-transfer.mjs')).containerTransfer({root,path,journal,store,signal,direction,binding,buckets,policy:declaration.policy,transient,acknowledgeUnverifiedSchemaObjects});
  const input={ root, path, journal, binding, buckets, ...declaration, transient, legacyRecovery, acknowledgeUnverifiedSchemaObjects, platformMigrations };
  // Check the executable policy before migrations; the transfer worker imports
  // it again in its own process so module closures are retained during restore.
  if (policyModule !== undefined) await nativeWorker(store,'policy-preflight',input,signal);
  // Do not apply pending product migrations to a populated recovery target.
  // Check real existing bindings first; finalize repeats this under the lock.
  if(legacyRecovery)await nativeWorker(store,'legacy-preflight',input,signal);
  const {nativeApply}=await nativeWorker(store,'migration-preflight',input,signal);
  // Local migrations need no provider account: wrangler runs without credentials.
  // Its info lines (the local location and "Use --remote if you want to access
  // the remote instance") only confuse a local backup; warnings and errors print.
  const { dependencyEnvironment } = await shared('dependency-environment.mjs');
  if(nativeApply)await store.run('Applying local data migrations', 'pnpm', ['exec', 'wrangler', 'd1', 'migrations', 'apply', database, '--local', '--persist-to', '.wrangler/state', '--config', 'wrangler.jsonc'], {
   cwd: root, signal, env: { ...dependencyEnvironment(), RER_LOCAL_OPERATION: operationToken, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG: 'warn' },
  });
  const receipt=await nativeWorker(store,direction,input,signal);
  if(legacyRecovery)receipt.output=relative(root,legacyRecovery.output);
  return { target: 'local', [direction === 'export' ? 'output' : 'input']: relative(root, path), ...receipt };
 }
 return { legacyRecovery:true, export: context => run(context, 'export'), import: context => run(context, 'import') };
}

async function nativeWorker(store,direction,input,signal) {
  // The notice filter loads before the worker links its static node:sqlite import.
  const worker = fileURLToPath(new URL('./portability-worker.mjs', import.meta.url)), notice = new URL('./sqlite-notice.mjs', import.meta.url).href;
  const child = store.spawn(`${direction === 'migration-preflight' ? 'Checking migration history for' : direction === 'policy-preflight' ? 'Checking archive policy' : direction === 'legacy-preflight' ? 'Checking empty recovery destination' : direction === 'export' ? 'Exporting' : 'Restoring'} local installation data`, process.execPath,
   ['--import', notice, worker, direction, JSON.stringify(input)], { cwd: input.root, signal, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let receipt;
  // Progress lines come first, as {progress}; the last message is the receipt.
  child.on('message', message => { if (typeof message?.progress === 'string') store.report(message.progress); else receipt = message; });
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  await new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
  await store.stop(child);
  const status = await closed;
  if (!receipt || typeof receipt !== 'object') throw new RerError('transfer_failed', `Local portability ended before it finished (${status.signal ? `signal ${status.signal}` : `exit code ${status.code}`}). Run the same command again; it starts over${direction === 'import' ? ' and first cleans up anything this attempt staged' : ''}.`, 1);
  if (status.code !== 0 || !receipt.ok) throw new RerError(receipt.code ?? 'transfer_failed', receipt.reason==='legacy_restored_export_failed'
   ? 'Legacy data was restored and audited, but its v2 export failed. Preserve this installation, resolve the output problem, then run rer export --output FILE. Do not reset it to retry recovery.'
   : receipt.reason === 'archive_json' ? `Restore refused: the archive is damaged or incomplete. ${reExport}`
   : receipt.reExport ? `Restore refused (schema_mismatch): the schema definitions cannot be safely verified by this version. ${reExport}`
   : receipt.safety ? `Restore refused (${receipt.reason}): safety normalization for ${receipt.safety} violates the declared import policy.`
   : receipt.reason?.startsWith('migration_ledger:') ? ledgerRefusal(receipt)
   : receipt.migration ? `Restore refused (schema_mismatch:migration_data): migration ${receipt.migration} changed data after this archive was made, so its rows would skip that change. Restore an archive made after it.`
   : receipt.occupied ? `Restore refused (${receipt.reason}): ${receipt.reason === 'bucket_not_empty' ? `storage bucket ${receipt.occupied} in this installation already holds files` : `table ${receipt.occupied} in this installation already holds rows its migrations did not insert`}, and a restore only goes into an empty installation. To replace this installation's data with the archive, keep a copy with rer export --output exports/before-restore.rer, then run rer reset --yes and rer import --input ${relative(input.root, input.path)} --yes again.`
   : `The portability module refused or failed the archive operation (${receipt.reason ?? 'incomplete'}${receipt.native ? `: ${receipt.native.class}${receipt.native.code && receipt.native.code !== receipt.reason ? `, code ${receipt.native.code}` : ''}` : ''}).${receipt.native && receipt.exitCode === 1 ? ' Run the same command again; it starts over.' : ''}`, receipt.exitCode ?? 1);
  delete receipt.ok;
  return receipt;
}
