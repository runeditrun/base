import { parseJsonc } from '../../cli/jsonc.mjs';
import { sha256 } from './hash.mjs';
import { destinationLedger, matchMigrationLedger } from './ledgers.mjs';
import { migrationReplay } from './migration-history.mjs';
import { splitStatements } from './sql-text.mjs';
import { insist } from './storage.mjs';

// Node library callers have the same checkout evidence as the runner. Resolve
// only its single declared D1 migration directory, never an archive-supplied path.
// Variable imports keep Node builtins out of a Worker's module graph.
const nodeModule = name => import(name);
export async function libraryMigrations(db,config,root) {
  insist(typeof process!=='undefined' && process.versions?.node,'schema_mismatch:legacy_evidence',409);
  const [{readFile,readdir},{resolve,sep}]=await Promise.all([nodeModule('node:fs/promises'),nodeModule('node:path')]);
  root=resolve(root??process.cwd());
  const declaration=parseJsonc(await readFile(resolve(root,'wrangler.jsonc'),'utf8'));
  insist(declaration.d1_databases?.length===1,'schema_mismatch:legacy_evidence',409);
  const directory=resolve(root,declaration.d1_databases[0].migrations_dir??'migrations');
  insist(directory===root || directory.startsWith(root+sep),'schema_mismatch:legacy_evidence',409);
  const files=await Promise.all((await readdir(directory)).filter(name=>name.endsWith('.sql')).sort().map(async name=>{
    const bytes=await readFile(resolve(directory,name));
    return {name,sha256:await sha256(bytes),statements:splitStatements(bytes.toString('utf8'))};
  }));
  const ledger=await destinationLedger(db)??[];
  insist(ledger.length && ledger.every(row=>row.sha256),'schema_mismatch:legacy_evidence',409);
  const applied=matchMigrationLedger(ledger,files);
  const replay=migrationReplay(applied.map(name=>files.find(file=>file.name===name)),config);
  return async()=>replay;
}
