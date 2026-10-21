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
  const applied=matchMigrationLedger(await destinationLedger(db),files,declaration);
  if(table==='rer_migrations')for(const file of files)insist(applied.includes(file.name),'migration_ledger:unapplied',409);
 } catch(error) {
  // Ledger contents can contain private values. Report constant categories,
  // retaining the transfer's canonical compatibility and hash-matching policy.
  if(error instanceof PortabilityError) {
   const code=error.code.startsWith('migration_ledger:')?error.code.split(':').slice(0,2).join(':')
    :error.code==='schema_mismatch:uncertain_migrations'?'migration_ledger:uncertain':'migration_ledger:incompatible';
   throw new PortabilityError(code,409);
  }
  throw error;
 }
 return {nativeApply:table==='d1_migrations'};
}
