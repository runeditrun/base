import type { ImportPlan } from '../../types.ts';
import { jsonChunks } from '../../d1/sets.ts';
import { sql } from '../store.ts';
import { hash } from './store.ts';

/** A completed flag alone is not reconciliation. Every primary disposition,
 * including an archive/rejection with no native effect, needs its exact durable
 * decision and source claim. These predicates are rechecked at final commit. */
export function childJournalGuards(jobId: string, plan: ImportPlan) {
  const expected=plan.entries.map((entry,ordinal)=>[ordinal,entry.identity,entry.source.payloadHash,hash(entry.effects)]);
  return [
    sql('(SELECT count(*) FROM ik_d1_entries WHERE job_id=?)=?',jobId,expected.length),
    ...jsonChunks(expected).map(body=>sql(`NOT EXISTS(SELECT 1 FROM json_each(?) x WHERE NOT EXISTS(
      SELECT 1 FROM ik_d1_entries e JOIN ik_sources s ON s.identity=e.source_identity
      WHERE e.job_id=? AND e.ordinal=json_extract(x.value,'$[0]') AND e.source_identity=json_extract(x.value,'$[1]')
      AND e.effects_hash=json_extract(x.value,'$[3]') AND e.owner_job_id=? AND s.job_id=e.owner_job_id
      AND s.source_hash=json_extract(x.value,'$[2]') AND s.effects_hash=e.effects_hash AND s.mapping_version=?))`,body,jobId,jobId,plan.mappingVersion)),
  ];
}
