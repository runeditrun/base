import { parseJsonc } from '../../cli/jsonc.mjs';
import { sha256 } from './hash.mjs';
import { destinationLedger, matchMigrationLedger } from './ledgers.mjs';
import { splitStatements } from './sql-text.mjs';
import { insist, PortabilityError } from './storage.mjs';
import { policy, schemaIdentity, catalogue } from './catalogue.mjs';

// Replays a chosen set of the destination's migrations, in its applied order,
// into a scratch database and returns the resulting archive schema identity.
// Node runners only: restore uses it to place an older archive within the
// destination's history (see bridge.mjs). plan: [{name,statements,sha256?}],
// sha256 being the migration file's hash where the runner read the file.
export function migrationReplay(plan,input,{dataOnly=[]}={}) {
  const config=policy(input),sqlite='node:sqlite';
  return {names:plan.map(migration=>migration.name),dataOnly,aliases:name=>plan.find(m=>m.name===name).aliases,statements:name=>plan.find(m=>m.name===name).statements,sha256:name=>plan.find(m=>m.name===name).sha256,async schemaAfter(names,options) {
    const {DatabaseSync}=await import(sqlite);
    const scratch=new DatabaseSync(':memory:');
    const db={prepare:sql=>{const query=scratch.prepare(sql);let values=[];return {bind(...args){values=args;return this;},async all(){return {results:query.all(...values)};}};}};
    try {
      for(const migration of plan.filter(m=>names.includes(m.name)))for(const sql of migration.statements)scratch.exec(sql);
      return await schemaIdentity(db,config,options);
    }finally{scratch.close();}
  },
  // The rows the whole replay leaves in each requested table, as sorted images (legacy-safety.mjs).
  // A table the replay lacks, or one holding more than `limit` rows, has no entry.
  async rowImages(requests,limit) {
    const {DatabaseSync}=await import(sqlite);
    const scratch=new DatabaseSync(':memory:'),found=new Map();
    try {
      for(const migration of plan)for(const sql of migration.statements)scratch.exec(sql);
      for(const {name,columns} of requests) {
        try {
          const rows=scratch.prepare(`SELECT json_array(${columns.map(c=>`quote("${c.replaceAll('"','""')}")`).join(',')}) AS image FROM "${name.replaceAll('"','""')}" LIMIT ?`).all(limit+1).map(r=>r.image);
          if(rows.length<=limit)found.set(name,rows.sort());
        }catch{}
      }
      return found;
    }finally{scratch.close();}
  }};
}

// Node library callers have the same checkout evidence as the runner. Resolve
// only its single declared D1 migration directory, never an archive-supplied path.
// Variable imports keep Node builtins out of a Worker's module graph.
const nodeModule = name => import(name);
export async function libraryMigrations(db,config,root) {
  try{return await checkoutMigrations(db,config,root);}
  catch(error){if(error instanceof PortabilityError)throw error;throw new PortabilityError('schema_mismatch:legacy_evidence',409);}
}
async function checkoutMigrations(db,config,root) {
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
  insist(await replay.schemaAfter(replay.names)===(await catalogue(db,policy(config))).identity,'schema_mismatch');
  return async()=>replay;
}
