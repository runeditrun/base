import { checkManifest, checkPart, ContentVerifier, ArchiveVerifier } from './format.mjs';
import { archivedLedgerTables, archivedHistory, ledgerReader, matchMigrationLedger } from './ledgers.mjs';
import { appliedMigrations } from './bridge.mjs';
import { canonicalJson } from './hash.mjs';
import { insist, statement } from './storage.mjs';
import { libraryMigrations } from './library-history.mjs';

// A ledger carried in parts cannot authorize a durable job at create time.
// Collect this legacy upload in the service instance, authenticate it in full,
// then enter the ordinary durable import path. A lost collector is re-uploaded;
// it owns no destination data, lock, staging table or job to recover.
export function libraryImports(context,direct,migrationRoot) {
  const pending=new Map();
  const status=row=>({id:row.id,kind:'import',phase:row.phase,completed:row.parts.length,total:row.manifest.partCount,contentHash:null,requiredConfiguration:[]});
  return {
    ...direct,
    async create(manifest,actor='direct',options={}) {
      if(manifest?.version!==2 || manifest.schemaObjects!==undefined || options.acknowledgeUnverifiedSchemaObjects || options.ledgers)return direct.create(manifest,actor,options);
      await checkManifest(manifest);
      if(!archivedLedgerTables(manifest).length)return direct.create(manifest,actor,options);
      insist(manifest.product===context.config.product,'wrong_product');
      await appliedMigrations(context.db);
      insist(!(await statement(context.db,'SELECT import_job FROM rer_portability_state WHERE id=1').first())?.import_job && ![...pending.values()].some(row=>row.phase==='staging'),'import_running',409);
      context.migrations??=await libraryMigrations(context.db,context.inputPolicy,migrationRoot);
      const id=crypto.randomUUID();pending.set(id,{id,manifest:structuredClone(manifest),actor,parts:[],phase:'staging'});return id;
    },
    async uploadPart(id,index,part) {
      const row=pending.get(id);if(!row)return direct.uploadPart(id,index,part);
      insist(row.phase==='staging','import_phase',409);await checkPart(part,index,context.config.partBytes);
      if(row.parts[index]){insist(row.parts[index].sha256===part.sha256,'part_conflict',409);return status(row);}
      insist(index===row.parts.length && index<row.manifest.partCount,'part_order',409);
      row.parts.push(structuredClone(part));return status(row);
    },
    async finalize(id,options={}) {
      const row=pending.get(id);if(!row)return direct.finalize(id,options);
      const {manifest,parts}=row;insist(row.phase==='staging','import_phase',409);insist(parts.length===manifest.partCount,'parts_missing');
      const content=new ContentVerifier(manifest),archive=new ArchiveVerifier(manifest),reader=ledgerReader();reader.add(manifest);
      for(const part of parts){archive.add(part);reader.add(part);for(const item of part.items)content.add(item);}
      const digest=content.digest();
      if(options.contentHash!==undefined)insist(digest===options.contentHash,'content_checksum');
      insist(options.archiveHash===archive.digest(),'archive_checksum',409);
      const ledgers=reader.ledgers(),history=archivedHistory(manifest,ledgers);
      insist(history?.length && history.every(entry=>entry.sha256),'schema_mismatch:legacy_schema',409);
      const replay=await context.migrations(),files=replay.names.map(name=>({name,sha256:replay.sha256?.(name),aliases:replay.aliases?.(name)}));
      const recorded=matchMigrationLedger(history,files,replay);
      insist(canonicalJson(recorded)===canonicalJson(replay.names.slice(0,recorded.length)),'schema_mismatch:migration_history',409);
      const actual=await direct.create(manifest,row.actor,{ledgers,id});
      pending.delete(id);
      for(const part of parts)await direct.uploadPart(actual,part.index,part);
      return direct.finalize(actual,options);
    },
    async status(id){return pending.has(id)?status(pending.get(id)):direct.status(id);},
    async active(actor='direct'){const row=[...pending.values()].find(row=>row.actor===actor && row.phase==='staging');return row?status(row):direct.active(actor);},
    async abort(id){const row=pending.get(id);if(!row)return direct.abort(id);row.phase='aborted';row.parts=[];return status(row);},
    async lookup(id){return pending.has(id)?status(pending.get(id)):direct.lookup(id);},
    async actor(id){return pending.get(id)?.actor??direct.actor(id);},
  };
}
