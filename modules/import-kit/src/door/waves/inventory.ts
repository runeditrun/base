import type { DoorRecord, DoorRequest, DoorSnapshot } from '../types.ts';
import type { D1Sql } from '../../d1/types.ts';
import { canonicalJson, attachmentHash, sha256 } from '../../provenance/identity.ts';
import { importedTargets, recordKey } from '../inventory.ts';
import { DoorError } from '../protocol.ts';
import { authorized, sql } from '../store.ts';
import { childSnapshot, children, hash } from './store.ts';
import type { WaveRoot } from './types.ts';

/** Snapshot pages are read independently. Request budgets are never waived for
 * a large inventory or a native adapter lacking compact exact predicates. */
export async function records(request: DoorRequest, id: string | null, retained = true): Promise<DoorRecord[]> {
  if (!id) return [];
  const root = await request.options.database.prepare('SELECT * FROM ik_door_wave_roots WHERE id=? AND installation_id=? AND namespace=? AND destination=? AND state=\'completed\'')
    .bind(id,request.access.installationId,request.access.namespace,request.options.destination).first<WaveRoot>();
  if (!root) throw new DoorError('complete_parent_baseline_required',409);
  const result: DoorRecord[] = [];
  for (const child of await children(request,root)) result.push(...(await childSnapshot(request,child)).records);
  // Retained-gone ownership is cumulative, but never counted as delivered source.
  const seen = new Set(result.map(recordKey));
  for (const old of retained ? await records(request,root.previous_id) : []) if (!seen.has(recordKey(old))) result.push(old);
  return result;
}
export async function prior(request: DoorRequest, root: WaveRoot) {
  return new Map((await records(request,root.previous_id)).map(record=>[recordKey(record),record]));
}
/** Re-read exact journal ownership and byte-bearing native values. The kit's
 * read fences the complete native set, rather than accepting a client receipt. */
export async function ownedFence(request: DoorRequest, rows: DoorRecord[]): Promise<D1Sql[]> {
  const targets = rows.flatMap(row=>row.targets);
  const found = await importedTargets(request,targets).catch(async error=>{
    if (error instanceof Error && error.message==='IMPORT_ATOMIC_GUARD') {await authorized(request);throw new DoorError('native_edit_conflict',409);}
    throw error;
  });
  if (found.some(row=>!row.matches)) throw new DoorError('native_edit_conflict',409);
  const predicates: D1Sql[] = [];
  for (let i=0;i<targets.length;i++) {
    const t = targets[i], p = found[i].provenance;
    const current = await request.options.targets.read(request.options.database,request.options.destination,t.kind,t.id);
    if (!current || current.revision !== p.appliedRevision || sha256(canonicalJson(current.value)) !== p.valueHash
      || attachmentHash(current.attachment) !== p.attachmentHash) throw new DoorError('native_edit_conflict',409);
    predicates.push(request.options.targets.matches(current,request.options.destination,t.kind,t.id),
      sql(`EXISTS(SELECT 1 FROM ik_provenance WHERE id=? AND job_id=? AND reversed=0 AND json_extract(record_json,'$.appliedRevision')=? AND json_extract(record_json,'$.valueHash')=? AND json_extract(record_json,'$.attachmentHash') IS ?)`,p.id,p.jobId,p.appliedRevision,p.valueHash,p.attachmentHash));
  }
  return predicates;
}
export function conjunction(predicates: D1Sql[]): D1Sql {
  return predicates.length ? sql(predicates.map(p=>`(${p.sql})`).join(' AND '),...predicates.flatMap(p=>p.params ?? [])) : sql('1');
}
/** Before every child batch, future baselines and earlier siblings are checked
 * together. A sibling's actual journal replaces only its reviewed baselines. */
export async function executionFence(request: DoorRequest, root: WaveRoot, executingOrdinal = -1) {
  const predicates: D1Sql[] = [], completed: DoorRecord[] = [], replacing = new Set<string>();
  for (const child of await children(request,root)) {
    const snapshot = await childSnapshot(request,child);
    for (const record of snapshot.records) replacing.add(recordKey(record));
    const job = child.job_id ? await request.options.database.prepare('SELECT state,checkpoint FROM ik_jobs WHERE id=?').bind(child.job_id).first<any>() : null;
    if (job?.state === 'completed') { if (child.ordinal!==executingOrdinal) completed.push(...snapshot.records); continue; }
    for (const baseline of snapshot.wave.descriptor.baseline) {
      // A partially committed child's own completed targets are fenced by its
      // actual journal below; its uncommitted targets keep the prepared baseline.
      const provenance = child.job_id ? await request.options.database.prepare("SELECT json_extract(record_json,'$.appliedRevision') AS applied_revision,json_extract(record_json,'$.valueHash') AS value_hash,json_extract(record_json,'$.attachmentHash') AS attachment_hash FROM ik_provenance WHERE job_id=? AND target_kind=? AND target_id=? AND reversed=0").bind(child.job_id,baseline.kind,baseline.id).first<any>() : null;
      const current = await request.options.targets.read(request.options.database,root.destination,baseline.kind,baseline.id);
      if (provenance) {
        if (!current || current.revision !== provenance.applied_revision || hash(current.value) !== provenance.value_hash || attachmentHash(current.attachment) !== provenance.attachment_hash) throw new DoorError('native_edit_conflict',409);
        if (child.ordinal!==executingOrdinal) predicates.push(request.options.targets.matches(current,root.destination,baseline.kind,baseline.id));
      } else {
        if (canonicalJson(current ?? null) !== canonicalJson(baseline.row)) throw new DoorError('native_edit_conflict',409);
        if (child.ordinal!==executingOrdinal) predicates.push(request.options.targets.matches(baseline.row,root.destination,baseline.kind,baseline.id));
      }
    }
  }
  const retained = [...(await prior(request,root)).values()].filter(record=>!replacing.has(recordKey(record)));
  predicates.push(...await ownedFence(request,[...completed,...retained]));
  return conjunction(predicates);
}
export function snapshotRecords(snapshot: DoorSnapshot, old: Map<string,DoorRecord>, relationshipHash: string): DoorRecord[] {
  return snapshot.plan.entries.map(entry=>{
    const previous = old.get(recordKey(entry.source));
    return {kind:entry.source.kind,sourceId:entry.source.sourceId,sourceHash:entry.rejection && previous ? previous.sourceHash : hash([entry.source.payloadHash,relationshipHash,snapshot.plan.mappingVersion]),
      targets:entry.effects.length ? entry.effects.map(effect=>({kind:effect.targetKind,id:effect.targetId,ownerPlanId:snapshot.id,sourceIdentity:entry.identity})) : previous?.targets ?? [],
      ...(entry.rejection || entry.unmapped.length ? {explanation:entry.rejection ?? entry.unmapped.map(u=>u.reason).join('; ')} : {})};
  });
}
