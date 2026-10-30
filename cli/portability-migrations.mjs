import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { migrationStatements } from '../modules/portability/migration-sql.mjs';
import { destinationLedger, ledgerNames, matchMigrationLedger } from '../modules/portability/ledgers.mjs';
import { all, insist, PortabilityError } from '../modules/portability/storage.mjs';
import {migrationDirectory} from '../modules/deploy-kit/migration-directory.mjs';
export {migrationDirectory};

// Seed-owned declarations, never archive metadata: the deploymentSpec prefix
// for this binding's directory, and data-only seeds without schema files.
export function platformMigrationDeclaration(input={}) {
 insist(input && typeof input==='object' && !Array.isArray(input) && Object.keys(input).every(key=>['prefix','dataOnly'].includes(key)),'invalid_platform_migrations',409);
 const {prefix,dataOnly=[]}=input;
 insist(prefix===undefined || typeof prefix==='string' && /^[\w.-]*$/.test(prefix),'invalid_platform_migrations',409);
 insist(Array.isArray(dataOnly) && dataOnly.every(name=>typeof name==='string' && /^[\w.-]+\.sql$/.test(name)) && new Set(dataOnly).size===dataOnly.length,'invalid_platform_migrations',409);
 return {prefix,dataOnly};
}

// Reproduce the runner's stored SQL text, then recover SQLite's statement
// boundaries (migration-sql.mjs).
export async function migrationInventory(root,binding,{prefix},split) {
 const directory=await migrationDirectory(root,binding);
 return Promise.all((await readdir(directory)).filter(name=>name.endsWith('.sql')).sort().map(async name=>{
  const bytes=await readFile(join(directory,name));
  return {name,...(split?{statements:migrationStatements(bytes.toString('utf8'),split)}:{}),sha256:createHash('sha256').update(bytes).digest('hex'),...(prefix===undefined?{}:{aliases:[prefix+name]})};
 }));
}

// Preserve the runner's applied order, resolving file identities by hash.
export async function appliedMigrations(root,db,binding,declaration,split) {
 const ledger=await destinationLedger(db) ?? [],files=await migrationInventory(root,binding,declaration,split);
 return matchMigrationLedger(ledger,files,declaration).map(name=>files.find(file=>file.name===name));
}

// Ledger contents can contain private values. Report constant categories,
// retaining the transfer's canonical compatibility and hash-matching policy.
function constantRefusal(error,files) {
 if(!(error instanceof PortabilityError))return error;
 const code=error.code.startsWith('migration_ledger:')?error.code.split(':').slice(0,2).join(':')
  :error.code==='schema_mismatch:uncertain_migrations'?'migration_ledger:uncertain':'migration_ledger:incompatible';
 // Only checkout-owned names may accompany the constant category. A ledger
 // entry with no matching file or declared alias can contain private values.
 const name=error.code.split(':').slice(2).join(':');
 const identity=['migration_ledger:unknown','migration_ledger:ambiguous','migration_ledger:conflict'].includes(code) && name && files.some(file=>file.name===name || file.aliases?.includes(name))?name:undefined;
 return Object.assign(new PortabilityError(code,409),error.migration===undefined?{}:{migration:error.migration},identity?{identity}:{});
}

// For adapters with their own archive format: the entries of a migration ledger
// ([{name,sha256}], as RER Platform's rer_migrations records them or as an
// archive carries them) named by the checkout's migration files, matched by
// SHA-256 and refused when a name or hash differs from the checkout's. The
// result is the native-equivalent ledger: write it to an export, or compare it
// with the archive on import, instead of comparing ledger controllers.
// Declared data-only entries keep their own names. Reads files only.
export async function mapMigrationLedger({root,binding='DB',platformMigrations,entries}) {
 const declaration=platformMigrationDeclaration(platformMigrations);
 insist(Array.isArray(entries) && entries.every(entry=>entry && typeof entry.name==='string' && typeof entry.sha256==='string' && /^[a-f0-9]{64}$/.test(entry.sha256)) && new Set(entries.map(entry=>entry.name)).size===entries.length,'migration_ledger:incompatible',409);
 const files=await migrationInventory(root,binding,declaration);
 try {
  const mapped=entries.map(({name,sha256})=>({name:matchMigrationLedger([{name,sha256}],files,declaration)[0]??name,sha256}));
  insist(new Set(mapped.map(entry=>entry.name)).size===mapped.length,'migration_ledger:ambiguous',409);
  return mapped;
 } catch(error) { throw constantRefusal(error,files); }
}

// Older runners leave Wrangler's bookkeeping beside their authoritative hashed
// history. A tracked D1 ledger is another history and must agree with it.
async function legacyPairPreflight(db) {
 const columns=await all(db,'PRAGMA table_info(_rer_deploy_migrations)');
 insist(['name','sha256','state'].every(name=>columns.some(column=>column.name===name)),'migration_ledger:incompatible',409);
 const history=await all(db,'SELECT name,sha256,state FROM _rer_deploy_migrations ORDER BY name');
 insist(history.every(row=>row.state==='applied'),'migration_ledger:uncertain',409);
 insist(history.every(row=>typeof row.name==='string' && typeof row.sha256==='string' && /^[a-f0-9]{64}$/.test(row.sha256)) && new Set(history.map(row=>row.name)).size===history.length,'migration_ledger:incompatible',409);
 const nativeColumns=(await all(db,'PRAGMA table_info(d1_migrations)')).map(column=>column.name);
 const tracked=nativeColumns.includes('state') || nativeColumns.includes('sha256');
 insist(['id','name','applied_at'].every(name=>nativeColumns.includes(name)) && (!tracked || nativeColumns.includes('state') && nativeColumns.includes('sha256')),'migration_ledger:incompatible',409);
 const native=await all(db,`SELECT name${tracked?',sha256,state':''} FROM d1_migrations ORDER BY id`);
 insist(native.every(row=>typeof row.name==='string') && new Set(native.map(row=>row.name)).size===native.length,'migration_ledger:incompatible',409);
 if(tracked) {
  insist(native.every(row=>row.state==='applied'),'migration_ledger:uncertain',409);
  insist(native.every(row=>typeof row.sha256==='string' && /^[a-f0-9]{64}$/.test(row.sha256)),'migration_ledger:incompatible',409);
  insist(native.length===history.length && native.every((row,index)=>row.name===history[index].name && row.sha256===history[index].sha256),'migration_ledger:multiple',409);
 } else insist(native.every(row=>history.some(prior=>prior.name===row.name)),'migration_ledger:multiple',409);
}

// Adapter entry point, before *any* native Wrangler apply. The caller supplies
// the real target binding and keeps its writers stopped through apply/transfer.
// This only reads: it never repairs history or creates a second ledger.
export async function nativeMigrationPreflight({root,db,binding='DB',platformMigrations}) {
 const declaration=platformMigrationDeclaration(platformMigrations);
 const tables=await all(db,`SELECT type,name FROM sqlite_master WHERE lower(name) IN (${ledgerNames.map(name=>`'${name}'`).join(',')})`);
 const legacyPair=tables.length===2 && ['_rer_deploy_migrations','d1_migrations'].every(name=>tables.some(row=>row.name===name));
 if(tables.length>1 && !legacyPair)throw Object.assign(new PortabilityError('migration_ledger:multiple',409),tables.some(row=>row.name==='rer_migrations')?{identity:'rer_migrations'}:{});
 insist(tables.every(row=>row.type==='table' && ledgerNames.includes(row.name)),'migration_ledger:incompatible',409);
 const table=legacyPair?'_rer_deploy_migrations':tables[0]?.name;
 if(!table)return {nativeApply:true};
 // This runner's history cannot authorize Wrangler to apply the same files.
 insist(table!=='_rer_deploy_migrations' || legacyPair,'migration_ledger:runner',409);
 const files=await migrationInventory(root,binding,declaration);
 let nativeApply=false;
 try {
  if(legacyPair)await legacyPairPreflight(db);
  const ledger=await destinationLedger(db),applied=matchMigrationLedger(ledger,files,declaration);
  // Wrangler skips only literal filenames, not transfer aliases or hashes.
  if(table==='d1_migrations')insist(ledger.every(row=>files.some(file=>file.name===row.name)),'migration_ledger:incompatible',409);
  nativeApply=table==='d1_migrations' && files.some(file=>!applied.includes(file.name));
  // The checkout file is named: it is the seed's own, never a ledger value.
  if(table!=='d1_migrations')for(const file of files)if(!applied.includes(file.name))throw Object.assign(new PortabilityError('migration_ledger:unapplied',409),{migration:file.name});
 } catch(error) { throw constantRefusal(error,files); }
 return {nativeApply};
}
