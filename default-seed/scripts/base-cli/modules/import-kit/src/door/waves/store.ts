import {canonicalHash} from '../../provenance/canonical-stream.ts';
import type {WaveInventoryMember} from './digests.ts';
import { canonicalJson } from '../../provenance/identity.ts';
import type { DoorRequest, DoorSnapshot } from '../types.ts';
import { DoorError } from '../protocol.ts';
import { assertion, erasures, loadSnapshot, sql, statement, transact } from '../store.ts';
import { BOUNDED_WAVES, totalKeys, type WaveChild, type WaveMetadata, type WaveRoot, type WaveBinding } from './types.ts';
import { text } from '../uploads.ts';

export const hash = canonicalHash;
export const opaque = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
export function revision(request: DoorRequest): WaveBinding {
  const binding = request.access.bounded;
  if (request.via !== 'grant' || !binding || binding.protocol !== BOUNDED_WAVES
    || !request.options.bounded) throw new DoorError('bounded_waves_not_adopted',409);
  return binding;
}
export async function rootRow(request: DoorRequest, input: Record<string,unknown>, allowWithdrawn = false): Promise<WaveRoot> {
  revision(request);
  const row = await request.options.database.prepare('SELECT * FROM ik_door_wave_roots WHERE id=? AND installation_id=? AND namespace=? AND destination=? AND owner=?')
    .bind(text(input.parentId,'parent_id'),request.access.installationId,request.access.namespace,request.options.destination,request.access.email).first<WaveRoot>();
  if (!row) throw new DoorError('parent_not_found',404);
  const b = revision(request), saved = JSON.parse(row.binding_json) as WaveBinding;
  if (['migration','revision','policy'].some(k=>b[k as keyof WaveBinding] !== saved[k as keyof WaveBinding])
    || row.mapping_version !== request.options.mapping.version) throw new DoorError('parent_revision_changed',409);
  if (row.state === 'withdrawn' || row.epoch !== await erasures(request.options.database,row.destination)) {
    if (!allowWithdrawn) throw new DoorError('parent_withdrawn',410);
  }
  if (row.fingerprint && parentFingerprint(row)!==row.fingerprint) throw new DoorError('parent_layout_changed',409);
  if (b.parentFingerprint !== undefined && b.parentFingerprint !== row.fingerprint) throw new DoorError('parent_fingerprint_mismatch');
  return row;
}
export function rootFence(row: WaveRoot) {
  const settled=row.state==='completed' || row.state==='reversed';
  return sql(`EXISTS(SELECT 1 FROM ik_door_wave_roots WHERE id=? AND state=? AND pages=? AND chain=? AND fingerprint IS ? AND epoch=? AND content_revision=?)
    AND (SELECT count(*) FROM ik_d1_erasure_journal WHERE destination=?)=?
    AND EXISTS(SELECT 1 FROM ik_door_namespaces WHERE installation_id=? AND namespace=? AND pending_id IS ?
      AND (head_id IS ? OR (?=1 AND head_id=?)))`,row.id,row.state,row.pages,row.chain,row.fingerprint,row.epoch,row.content_revision ?? 0,row.destination,row.epoch,
    row.installation_id,row.namespace,settled?null:row.id,row.state==='completed'?row.id:row.previous_id,row.state==='reversing'?1:0,row.id);
}
export function activeParent(request: DoorRequest, root: WaveRoot) {
  const b = revision(request);
  if (b.parentFingerprint !== root.fingerprint || !b.parentApprovalRecordId || !b.parentApprovedAt) throw new DoorError('parent_approval_required');
  return sql(`EXISTS(SELECT 1 FROM ik_door_wave_approvals WHERE parent_id=? AND ordinal=-1 AND revoked=0 AND fingerprint=? AND approval_id=? AND approved_at=? AND owner=?)`,
    root.id,root.fingerprint,b.parentApprovalRecordId,b.parentApprovedAt,request.access.email);
}
export function authority(request: DoorRequest, extra = sql('1')) {
  const b = revision(request), upstream = request.options.bounded!.authority(b,request.access.action);
  if (!upstream?.sql?.trim()) throw new DoorError('bounded_authority_unavailable',503);
  return sql(`(${request.authority.sql}) AND (${upstream.sql}) AND (${extra.sql})`,...request.authority.params ?? [],...upstream.params ?? [],...extra.params ?? []);
}
export async function children(request: DoorRequest, root: WaveRoot): Promise<WaveChild[]> {
  const {results} = await request.options.database.prepare('SELECT c.*,p.job_id FROM ik_door_wave_children c JOIN ik_door_plans p ON p.id=c.plan_id WHERE c.parent_id=? ORDER BY c.ordinal').bind(root.id).all<WaveChild>();
  if (results.length !== root.pages || results.some((c,i)=>c.ordinal !== i)) throw new DoorError('parent_layout_changed',409);
  let chain=hash([]);for(const child of results)chain=hash([chain,child.fingerprint]);
  if (chain!==root.chain) throw new DoorError('parent_layout_changed',409);
  return results;
}
export async function childSnapshot(request: DoorRequest, child: WaveChild) {
  const row = await request.options.database.prepare('SELECT * FROM ik_door_plans WHERE id=? AND installation_id=? AND namespace=? AND complete=1')
    .bind(child.plan_id,request.access.installationId,request.access.namespace).first<any>();
  if (!row) throw new DoorError('child_custody_missing',410);
  const snapshot = await loadSnapshot(request,row) as DoorSnapshot & {wave: WaveMetadata};
  if (!snapshot.wave || hash(snapshot.wave.descriptor) !== child.descriptor_hash || snapshot.wave.descriptor.fingerprint !== child.fingerprint) throw new DoorError('child_membership_changed',409);
  const {fingerprint,...descriptor}=snapshot.wave.descriptor;
  if (totalKeys.some(k=>descriptor[k]!==child[k]) || descriptor.ordinal!==child.ordinal || descriptor.unitHash!==child.unit_hash || descriptor.source!==snapshot.plan.counts.unique || hash(descriptor)!==fingerprint || descriptor.planFingerprint!==snapshot.plan.fingerprint || hash(snapshot.wave.unit.id)!==descriptor.unitHash) throw new DoorError('child_membership_changed',409);
  return snapshot;
}
/** Bounded snapshot chunks reuse the door's existing erasure and restore
 * inventory. They are not another apply journal or byte store. */
export async function saveChild(request: DoorRequest, root: WaveRoot, snapshot: DoorSnapshot & {wave: WaveMetadata}, members: WaveInventoryMember[], nextChain: string) {
  const db = request.options.database, d = snapshot.wave.descriptor, body = canonicalJson(snapshot);
  const rows: {ordinal:number;body:string}[] = [];
  for (let start = 0; start < body.length;) {
    let end = Math.min(start+24_000,body.length);
    if (end<body.length && /[\uD800-\uDBFF]/.test(body[end-1])) end--;
    rows.push({ordinal:rows.length,body:body.slice(start,end)}); start=end;
  }
  // A work unit is bounded by the existing plan/value/request limits, including
  // its originals. An indivisible unit that cannot fit is refused, never split.
  await transact(db,authority(request),[
    assertion(rootFence(root)),
    sql('INSERT INTO ik_door_plans(id,installation_id,namespace,bundle_sha256,fingerprint,previous_id,snapshot_hash,complete) VALUES(?,?,?,?,?,?,?,1)',snapshot.id,root.installation_id,root.namespace,root.bundle_sha256,snapshot.plan.fingerprint,root.previous_id,hash(snapshot)),
    ...rows.map(row=>sql('INSERT INTO ik_door_plan_chunks(plan_id,ordinal,body) VALUES(?,?,?)',snapshot.id,row.ordinal,row.body)),
    sql(`INSERT INTO ik_door_wave_children(parent_id,ordinal,plan_id,unit_hash,fingerprint,descriptor_hash,source,native,aliases,objects,logicalBytes,storedBytes,nativeBytes,blobBytes,contextBytes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,root.id,d.ordinal,snapshot.id,d.unitHash,d.fingerprint,hash(d),d.source,d.native,d.aliases,d.objects,d.logicalBytes,d.storedBytes,d.nativeBytes,d.blobBytes,d.contextBytes),
    sql(`INSERT INTO ik_door_wave_members(parent_id,type,identity,digest,ordinal) SELECT ?,json_extract(value,'$.type'),json_extract(value,'$.identity'),json_extract(value,'$.digest'),? FROM json_each(?)`,root.id,d.ordinal,JSON.stringify(members)),
    sql('UPDATE ik_door_wave_roots SET pages=pages+1,chain=? WHERE id=?',nextChain,root.id),
  ]);
}
/** Provisioning revocation is server-only, checked in every execution batch. */
export async function revokeImportDoorWaveApproval(request: DoorRequest, parentId: string, ordinal: number) {
  const root = await rootRow(request,{parentId});
  await transact(request.options.database,authority(request),[
    sql('UPDATE ik_door_wave_approvals SET revoked=1 WHERE parent_id=? AND ordinal=?',root.id,ordinal),
  ]);
}
export async function assertPredicate(request: DoorRequest, predicate: ReturnType<typeof sql>, code: string) {
  if ((await statement(request.options.database,sql(`SELECT (${predicate.sql}) AS ok`,...predicate.params ?? [])).first())?.ok !== 1) throw new DoorError(code);
}
export async function approve(request: DoorRequest, root: WaveRoot, ordinal: number, fingerprint: string) {
  const g=request.access;
  if (g.fingerprint !== fingerprint || !g.approvalRecordId || !g.approvedAt) throw new DoorError('exact_approval_required');
  await transact(request.options.database,authority(request,rootFence(root)),[
    sql('INSERT OR IGNORE INTO ik_door_wave_approvals(parent_id,ordinal,approval_id,approved_at,owner,fingerprint) VALUES(?,?,?,?,?,?)',root.id,ordinal,g.approvalRecordId,g.approvedAt,g.email,fingerprint),
    assertion(sql('EXISTS(SELECT 1 FROM ik_door_wave_approvals WHERE parent_id=? AND ordinal=? AND approval_id=? AND approved_at=? AND owner=? AND fingerprint=? AND revoked=0)',root.id,ordinal,g.approvalRecordId,g.approvedAt,g.email,fingerprint)),
  ]);
}

export function parentFingerprint(root: WaveRoot) {
  return hash({protocol:BOUNDED_WAVES,binding:JSON.parse(root.binding_json),installation:root.installation_id,destination:root.destination,owner:root.owner,
    namespace:root.namespace,mapping:root.mapping_version,package:root.bundle_sha256,previous:root.previous_id,census:JSON.parse(root.census_json),children:root.chain,epoch:root.epoch,catchup:root.catchup});
}
