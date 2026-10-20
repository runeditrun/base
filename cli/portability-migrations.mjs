import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { migrationStatements } from '../modules/portability/migration-sql.mjs';
import { destinationLedger, matchMigrationLedger } from '../modules/portability/ledgers.mjs';
import { all, insist } from '../modules/portability/storage.mjs';
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
 const directory=join(root,config.d1_databases.find(entry=>entry.binding===binding).migrations_dir ?? 'migrations');
 return Promise.all((await readdir(directory)).filter(name=>name.endsWith('.sql')).sort().map(async name=>{
  const bytes=await readFile(join(directory,name));
  return {name,statements:migrationStatements(bytes.toString('utf8'),split),sha256:createHash('sha256').update(bytes).digest('hex'),...(prefix===undefined?{}:{aliases:[prefix+name]})};
 }));
}

// Preserve the runner's applied order, resolving file identities by hash.
export async function appliedMigrations(root,db,binding,declaration,split) {
 const ledger=await destinationLedger(db) ?? [],files=await inventory(root,binding,declaration,split);
 return matchMigrationLedger(ledger,files,declaration).map(name=>files.find(file=>file.name===name));
}

// Wrangler cannot see Platform's ledger. Keep Platform as the sole authority;
// pending files must be applied by that runner before a local transfer.
export async function platformMigrationPreflight(root,db,binding,declaration,split) {
 const tables=(await all(db,"SELECT name FROM sqlite_master WHERE type='table' AND name IN ('rer_migrations','d1_migrations','_rer_deploy_migrations')")).map(row=>row.name);
 if(!tables.includes('rer_migrations'))return {platformLedger:false};
 insist(tables.length===1,'migration_ledger:multiple:rer_migrations',409);
 const files=await inventory(root,binding,declaration,split),ledger=await destinationLedger(db);
 const applied=matchMigrationLedger(ledger,files,declaration);
 for(const file of files)insist(applied.includes(file.name),'migration_ledger:unapplied:'+file.name,409);
 return {platformLedger:true};
}
