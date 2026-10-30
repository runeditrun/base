import {join} from 'node:path';
import {readFile} from 'node:fs/promises';
import {insist} from '../portability/storage.mjs';
import {parseJsonc} from './jsonc.mjs';

// Native archive/migration checks and deploy packaging use the same seed-owned
// directory declaration. Only packaging supplies its historical fallback.
export async function migrationDirectory(root,binding,{fallback}={}) {
 let config;
 try { config=parseJsonc(await readFile(join(root,'wrangler.jsonc'),'utf8')); }
 catch(error) { if(error.code!=='ENOENT' || fallback===undefined)throw error; return join(root,fallback); }
 const bindings=config.d1_databases?.filter(entry=>entry.binding===binding) ?? [];
 insist(bindings.length===1 || bindings.length===0 && fallback!==undefined,'migration_ledger:binding',409);
 return join(root,bindings[0]?.migrations_dir ?? fallback ?? 'migrations');
}

