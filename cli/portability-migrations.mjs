import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { migrationStatements } from '../modules/portability/migration-sql.mjs';
import { destinationLedger, ledgerNames, matchMigrationLedger } from '../modules/portability/ledgers.mjs';
import { all, insist, PortabilityError } from '../modules/portability/storage.mjs';
import { parseJsonc } from './jsonc.mjs';

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
async function inventory(root,binding,{prefix},split) {
 const config=parseJsonc(await readFile(join(root,'wrangler.jsonc'),'utf8'));
 const bindings=config.d1_databases?.filter(entry=>entry.binding===binding) ?? [];
 insist(bindings.length===1,'migration_ledger:binding',409);
 const directory=join(root,bindings[0].migrations_dir ?? 'migrations');
 return Promise.all((await readdir(directory)).filter(name=>name.endsWith('.sql')).sort().map(async name=>{
  const bytes=await readFile(join(directory,name));
  return {name,...(split?{statements:migrationStatements(bytes.toString('utf8'),split)}:{}),sha256:createHash('sha256').update(bytes).digest('hex'),...(prefix===undefined?{}:{aliases:[prefix+name]})};
 }));
}

// Preserve the runner's applied order, resolving file identities by hash.
export async function appliedMigrations(root,db,binding,declaration,split) {
 const ledger=await destinationLedger(db) ?? [],files=await inventory(root,binding,declaration,split);
 return matchMigrationLedger(ledger,files,declaration).map(name=>files.find(file=>file.name===name));
}

// Ledger contents can contain private values. Report constant categories,
// retaining the transfer's canonical compatibility and hash-matching policy.
function constantRefusal(error) {
 if(!(error instanceof PortabilityError))return error;
 const code=error.code.startsWith('migration_ledger:')?error.code.split(':').slice(0,2).join(':')
  :error.code==='schema_mismatch:uncertain_migrations'?'migration_ledger:uncertain':'migration_ledger:incompatible';
 return Object.assign(new PortabilityError(code,409),error.migration===undefined?{}:{migration:error.migration});
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
 const files=await inventory(root,binding,declaration);
 try {
  const mapped=entries.map(({name,sha256})=>({name:matchMigrationLedger([{name,sha256}],files,declaration)[0]??name,sha256}));
  insist(new Set(mapped.map(entry=>entry.name)).size===mapped.length,'migration_ledger:ambiguous',409);
  return mapped;
 } catch(error) { throw constantRefusal(error); }
}

// Adapter entry point, before *any* native Wrangler apply. The caller supplies
// the real target binding and keeps its writers stopped through apply/transfer.
// This only reads: it never repairs history or creates a second ledger.
export async function nativeMigrationPreflight({root,db,binding='DB',platformMigrations}) {
 const declaration=platformMigrationDeclaration(platformMigrations);
 const tables=await all(db,`SELECT type,name FROM sqlite_master WHERE lower(name) IN (${ledgerNames.map(name=>`'${name}'`).join(',')})`);
 insist(tables.length<=1,'migration_ledger:multiple',409);
 insist(tables.every(row=>row.type==='table' && ledgerNames.includes(row.name)),'migration_ledger:incompatible',409);
 const table=tables[0]?.name;
 if(!table)return {nativeApply:true};
 // This runner's history cannot authorize Wrangler to apply the same files.
 insist(table!=='_rer_deploy_migrations','migration_ledger:runner',409);
 const files=await inventory(root,binding,declaration);
 try {
  const ledger=await destinationLedger(db),applied=matchMigrationLedger(ledger,files,declaration);
  // Wrangler skips only literal filenames, not transfer aliases or hashes.
  if(table==='d1_migrations')insist(ledger.every(row=>files.some(file=>file.name===row.name)),'migration_ledger:incompatible',409);
  // The checkout file is named: it is the seed's own, never a ledger value.
  if(table==='rer_migrations')for(const file of files)if(!applied.includes(file.name))throw Object.assign(new PortabilityError('migration_ledger:unapplied',409),{migration:file.name});
 } catch(error) { throw constantRefusal(error); }
 return {nativeApply:table==='d1_migrations'};
}
