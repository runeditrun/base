/** A compact monotonic snapshot fence for bounded multi-job privacy work.
 * It covers all custody fields, independently of the plan revision used by
 * ordinary apply. Backfilling never rewrites existing public custody. */
export const d1CustodyStateSchema = [
  'CREATE TABLE IF NOT EXISTS ik_d1_custody_states (job_id TEXT PRIMARY KEY REFERENCES ik_jobs(id) ON DELETE CASCADE,revision INTEGER NOT NULL DEFAULT 0)',
  'INSERT OR IGNORE INTO ik_d1_custody_states(job_id) SELECT id FROM ik_jobs',
  "CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_monotonic BEFORE UPDATE ON ik_d1_custody_states WHEN NEW.job_id IS NOT OLD.job_id OR NEW.revision<=OLD.revision BEGIN SELECT RAISE(ABORT,'IMPORT_CUSTODY_STATE_CHANGED'); END",
  "CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_delete BEFORE DELETE ON ik_d1_custody_states WHEN EXISTS(SELECT 1 FROM ik_jobs WHERE id=OLD.job_id) BEGIN SELECT RAISE(ABORT,'IMPORT_CUSTODY_STATE_CHANGED'); END",
  "CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_publication BEFORE UPDATE ON ik_d1_custody_states WHEN EXISTS(SELECT 1 FROM ik_d1_publication_fences f JOIN ik_d1_custody_revisions r ON r.job_id=f.job_id WHERE (f.job_id=OLD.job_id OR f.job_id=NEW.job_id) AND r.seal IS NOT NULL) BEGIN SELECT RAISE(ABORT,'IMPORT_PUBLICATION_CHANGED'); END",
  'CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_receipt AFTER UPDATE ON ik_d1_custody_states BEGIN UPDATE ik_d1_custody_revisions SET seal=NULL WHERE job_id=NEW.job_id; END',
  'CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_create AFTER INSERT ON ik_jobs BEGIN INSERT INTO ik_d1_custody_states(job_id) VALUES(NEW.id); END',
  ...[['ik_jobs','id'],...['ik_d1_plan_chunks','ik_d1_creation_plans','ik_d1_plan_index','ik_originals','ik_d1_original_chunks','ik_original_sets','ik_d1_indexed_jobs','ik_d1_reversal_reports','ik_provenance','ik_sources','ik_d1_entries','ik_d1_history','ik_batches','ik_d1_stream_pages'].map(table=>[table,'job_id'])].flatMap(([table,column])=>['INSERT','UPDATE','DELETE'].map(event=>{
    const refs=event==='INSERT'?`job_id=NEW.${column}`:event==='DELETE'?`job_id=OLD.${column}`:`job_id=OLD.${column} OR job_id=NEW.${column}`;
    return `CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_${table}_${event.toLowerCase()} AFTER ${event} ON ${table} BEGIN UPDATE ik_d1_custody_states SET revision=revision+1 WHERE ${refs}; END`;
  })),
  ...['UPDATE','DELETE'].map(event=>`CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_stream_${event.toLowerCase()} BEFORE ${event} ON ik_d1_streams BEGIN UPDATE ik_d1_custody_states SET revision=revision+1 WHERE job_id IN (SELECT job_id FROM ik_d1_stream_pages WHERE stream_id=OLD.id); END`),
  // Tombstones participate in a SELECT-only multi-batch custody snapshot too.
  ...[['ik_d1_erased_sources','source_identity'],['ik_d1_erased_targets','target_identity']].flatMap(([table,column])=>['INSERT','UPDATE','DELETE'].map(event=>{
    const match=(row:string)=>`i.${column}=${row}.identity AND j.destination=${row}.destination`;
    const predicate=event==='INSERT'?match('NEW'):event==='DELETE'?match('OLD'):`(${match('OLD')}) OR (${match('NEW')})`;
    return `CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_${table}_${event.toLowerCase()} AFTER ${event} ON ${table} BEGIN UPDATE ik_d1_custody_states SET revision=revision+1 WHERE job_id IN (SELECT i.job_id FROM ik_d1_plan_index i JOIN ik_jobs j ON j.id=i.job_id WHERE ${predicate}); END`;
  })),
];

/** Owners of the rows an insert or update would replace through a key other than its own job's. */
const replacedOwners: [table: string, owners: string][] = [
  ['ik_sources', 'SELECT job_id FROM ik_sources WHERE identity=NEW.identity'],
  ['ik_provenance', 'SELECT job_id FROM ik_provenance WHERE id=NEW.id UNION ALL SELECT job_id FROM ik_provenance WHERE NEW.reversed=0 AND reversed=0 AND destination=NEW.destination AND target_kind=NEW.target_kind AND target_id=NEW.target_id'],
  ['ik_d1_history', 'SELECT job_id FROM ik_d1_history WHERE id=NEW.id UNION ALL SELECT job_id FROM ik_d1_history WHERE successor_id=NEW.successor_id'],
  ['ik_d1_stream_pages', 'SELECT job_id FROM ik_d1_stream_pages WHERE stream_id=NEW.stream_id AND ordinal=NEW.ordinal'],
  ['ik_d1_streams', 'SELECT job_id FROM ik_d1_stream_pages WHERE stream_id=NEW.id UNION ALL SELECT p.job_id FROM ik_d1_streams s JOIN ik_d1_stream_pages p ON p.stream_id=s.id WHERE s.destination=NEW.destination AND s.principal_id=NEW.principal_id AND s.operation_key=NEW.operation_key'],
];

/** Additive step after `d1CustodyStateSchema` and `d1RetirementSchema`. SQLite's
 * REPLACE deletes the row it conflicts with without firing DELETE triggers, so
 * without it one statement could rewind a revision or move custody between jobs
 * while every revision the persisted read fenced stays the same.
 * - An insert over an existing counter is ignored; the backfill's INSERT OR IGNORE still adds missing ones.
 * - A job id that exists or was retired is never inserted again (`IMPORT_JOB_ID_REUSED`).
 * - An insert or update that would replace a claim, provenance, history, stream
 *   page or stream row first advances the revision of every job owning the
 *   replaced row (`UPDATE OR REPLACE` deletes the row its new key collides with
 *   the same way). An ordinary write replaces nothing beyond its own row, whose
 *   job its AFTER triggers advance anyway, and a refused one rolls the advance back. */
export const d1CustodyStateReplaceSchema = [
  'CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_insert BEFORE INSERT ON ik_d1_custody_states WHEN EXISTS(SELECT 1 FROM ik_d1_custody_states WHERE job_id=NEW.job_id) BEGIN SELECT RAISE(IGNORE); END',
  "CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_job_reuse BEFORE INSERT ON ik_jobs WHEN EXISTS(SELECT 1 FROM ik_jobs WHERE id=NEW.id) OR EXISTS(SELECT 1 FROM ik_d1_retirements WHERE id=NEW.id AND kind='job') BEGIN SELECT RAISE(ABORT,'IMPORT_JOB_ID_REUSED'); END",
  ...[['INSERT', 'replace'], ['UPDATE', 'update_replace']].flatMap(([event, name]) => replacedOwners.map(([table, owners]) => `CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_${table}_${name} BEFORE ${event} ON ${table} BEGIN UPDATE ik_d1_custody_states SET revision=revision+1 WHERE job_id IN (${owners}); END`)),
];
