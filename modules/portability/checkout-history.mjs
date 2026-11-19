import { catalogue, policy } from './catalogue.mjs';
import { readLedger, matchMigrationLedger } from './ledgers.mjs';
import { nativeMigrationHistory, ownerMigrationPolicy } from './owner-history.mjs';
import { insist } from './storage.mjs';

// Both evidence adapters bind the seed's files to live history and the complete
// schema. Only an explicitly bundled Worker may bind plain Wrangler history:
// literal names must select an ordered checkout prefix, never aliases or gaps.
export async function checkoutHistory(db,input,files,replayFor,{nativeWrangler=false,ownerSources=[]}={}) {
 const history=await (ownerSources.length?nativeMigrationHistory(db,ownerSources):readLedger(db)),ledger=history?.entries??[];
 insist(ledger.length,'schema_mismatch:legacy_evidence',409);
 if(!ledger.every(row=>row.sha256)) {
  insist(nativeWrangler && history.table==='d1_migrations'
   && ledger.every((row,i)=>row.name===files[i]?.name && (history.owners || row.sha256===undefined)),
   'schema_mismatch:legacy_evidence',409);
 }
 const applied=matchMigrationLedger(ledger,files);
 const config=policy(ownerMigrationPolicy(input,ownerSources)),replay=await replayFor(applied,config);
 insist(await replay.schemaAfter(replay.names)===(await catalogue(db,config)).identity,'schema_mismatch');
 return ownerSources.length?{...replay,ownerSources,history}:replay;
}
