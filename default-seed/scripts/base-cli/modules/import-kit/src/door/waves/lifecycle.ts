import {childJournalGuards} from './journal.ts';
import {storedInventoryHash} from './digests.ts';
import { Buffer } from 'node:buffer';
import type { DoorRequest } from '../types.ts';
import type { D1ImportContext } from '../../d1/types.ts';
import { createD1ImportJob, readD1ImportJob } from '../../d1/jobs.ts';
import { applyD1ImportBatches } from '../../d1/apply.ts';
import { rollbackD1Import, undoD1Import } from '../../d1/reverse.ts';
import { readD1ImportOriginals } from '../../d1/originals.ts';
import { assertion, authorized, sql, transact } from '../store.ts';
import { DoorError } from '../protocol.ts';
import { failedPlan, reasonCode, requireNewPlan } from '../failures.ts';
import { sizeLimitError } from '../limits.ts';
import { sha256 } from '../../provenance/identity.ts';
import { bindWaveContext } from '../../d1/wave-boundary.ts';
import { BOUNDED_WAVES, totalKeys, zeroTotals, type WaveCensus, type WaveChild, type WaveRoot } from './types.ts';
import { activeParent, approve, assertPredicate, authority, childSnapshot, children, hash, parentFingerprint, rootFence, rootRow } from './store.ts';
import { conjunction, executionFence, ownedFence, prior, records } from './inventory.ts';

async function transition(request: DoorRequest, root: WaveRoot, state: string, extra = sql('1')) {
  await transact(request.options.database,authority(request,extra),[
    assertion(rootFence(root)),sql('UPDATE ik_door_wave_roots SET state=? WHERE id=?',state,root.id),
  ]);
  root.state=state;
}
export async function seal(request: DoorRequest, input: Record<string,unknown>) {
  const root=await rootRow(request,input), expected=JSON.parse(root.census_json) as WaveCensus;
  if (root.state!=='preparing') return parentView(request,root);
  if (root.pages!==expected.children) throw new DoorError('complete_census_required',409);
  const upload = await request.options.database.prepare('SELECT total_bytes FROM ik_door_uploads WHERE id=?').bind(root.upload_id).first<any>();
  if (!upload) throw new DoorError('parent_custody_missing',410);
  const totals=zeroTotals(), byKind:Record<string,number>=Object.create(null), nativeByTable:Record<string,number>=Object.create(null);
  const relationships:string[]=[];
  const seen=new Set<string>(), changes={additions:0,replacements:0,unchanged:0,rejected:0,unmapped:0};
  for (const child of await children(request,root)) {
    for (const key of totalKeys) totals[key]+=child[key];
    const snapshot=await childSnapshot(request,child), d=snapshot.wave.descriptor;
    for (const [kind,n] of Object.entries(snapshot.plan.counts.byKind)) byKind[kind]=(byKind[kind] ?? 0)+n;
    for (const [table,n] of Object.entries(d.nativeByTable)) nativeByTable[table]=(nativeByTable[table] ?? 0)+n;
    relationships.push(d.relationshipsHash);
    for (const record of snapshot.records) seen.add(hash([record.kind,record.sourceId]));
    changes.additions+=snapshot.differences.additions.length;changes.replacements+=snapshot.differences.replacements.length;changes.unchanged+=snapshot.differences.unchanged.length;
    changes.rejected+=snapshot.plan.counts.rejected;
    changes.unmapped+=snapshot.records.filter(r=>!r.targets.length).length;
  }
  if (totalKeys.some(k=>totals[k]!==expected[k]) || hash(byKind)!==hash(expected.byKind) || hash(nativeByTable)!==hash(expected.nativeByTable)) throw new DoorError('aggregate_census_mismatch',422);
  // Every verified indexed file, including context and objects, has one custody
  // owner. Transport bytes remain distinct from logical original/native bytes.
  const {packageUpload}=await import('../package.ts'), {uploadRow}=await import('../uploads.ts');
  const pkg=await packageUpload(request,await uploadRow(request,root.upload_id));
  const member=await request.options.database.prepare("SELECT count(*) n FROM ik_door_wave_members WHERE parent_id=? AND type='file'").bind(root.id).first<any>();
  if (member?.n!==pkg.files.length || totals.storedBytes!==pkg.files.reduce((n,f)=>n+f.bytes,0)) throw new DoorError('complete_file_coverage_required',422);
  const inventoryHash=await storedInventoryHash(request.options.database,root.id);
  const previousRoot=root.previous_id ? await request.options.database.prepare('SELECT fingerprint FROM ik_door_wave_roots WHERE id=?').bind(root.previous_id).first<any>() : null;
  if (inventoryHash!==expected.inventoryHash || hash(relationships)!==expected.relationshipsHash || (previousRoot?.fingerprint ?? hash([]))!==expected.baselineHash) throw new DoorError('complete_inventory_hash_mismatch',422);
  if (root.catchup===1) {
    const previous=await request.options.database.prepare('SELECT census_json FROM ik_door_wave_roots WHERE id=? AND state=\'completed\'').bind(root.previous_id).first<any>();
    const baseline=previous && JSON.parse(previous.census_json).source;
    const gone=(await records(request,root.previous_id,false)).filter(r=>!seen.has(hash([r.kind,r.sourceId]))).length;
    const reason=!baseline?'empty_baseline':gone?'source_records_gone':changes.rejected || changes.unmapped?'rejected_or_unmapped_records':(changes.additions+changes.replacements)*100>=baseline*5?'change_must_be_under_five_percent':null;
    if (reason) throw new DoorError('catchup_requires_proposal:'+reason,409);
  }
  const fingerprint=parentFingerprint(root);
  await transact(request.options.database,authority(request),[
    assertion(rootFence(root)),sql("UPDATE ik_door_wave_roots SET fingerprint=?,state='sealed' WHERE id=?",fingerprint,root.id),
  ]);
  return parentView(request,{...root,fingerprint,state:'sealed'});
}
export async function reviewParent(request: DoorRequest, input: Record<string,unknown>) {
  const root=await rootRow(request,input);
  if (!['sealed','approved','applying','completed'].includes(root.state) || !root.fingerprint) throw new DoorError('sealed_parent_required',409);
  if (await storedInventoryHash(request.options.database,root.id)!==JSON.parse(root.census_json).inventoryHash) throw new DoorError('aggregate_census_mismatch',409);
  await approve(request,root,-1,root.fingerprint);
  if (root.state==='sealed') await transition(request,root,'approved');
  return parentView(request,root);
}
function approvalFence(request: DoorRequest, root: WaveRoot, child: WaveChild) {
  return conjunction([activeParent(request,root),sql(`EXISTS(SELECT 1 FROM ik_door_wave_approvals WHERE parent_id=? AND ordinal=? AND revoked=0 AND fingerprint=? AND approval_id=? AND approved_at=? AND owner=?)`,root.id,child.ordinal,child.fingerprint,request.access.approvalRecordId,request.access.approvedAt,request.access.email)]);
}
async function context(request: DoorRequest, root: WaveRoot, child: WaveChild, mode: 'apply'|'reverse'|'read'): Promise<D1ImportContext> {
  const snapshot=await childSnapshot(request,child);
  if (hash(request.options.bounded!.native(snapshot.plan))!==hash(snapshot.wave.descriptor.projections)) throw new DoorError('native_accounting_changed',409);
  const fence=mode==='read'?sql('1'):await executionFence(request,root,child.ordinal);
  const approved=mode==='apply'?approvalFence(request,root,child):activeParent(request,root);
  const externalChild=request.options.bounded!.authority({...request.access.bounded!,childFingerprint:child.fingerprint},request.access.action);
  const associated=sql("EXISTS(SELECT 1 FROM ik_door_plans p LEFT JOIN ik_jobs j ON j.id=p.job_id WHERE p.id=? AND p.fingerprint=? AND (p.job_id IS NULL OR (j.operation_key=? AND j.fingerprint=p.fingerprint)))",child.plan_id,snapshot.plan.fingerprint,'door:'+child.plan_id);
  const active=conjunction([approved,externalChild,associated,rootFence(root),fence,sql('EXISTS(SELECT 1 FROM ik_door_plan_chunks WHERE plan_id=?)',child.plan_id)]);
  const result: D1ImportContext={destination:root.destination,namespace:snapshot.kitNamespace,mappingVersion:root.mapping_version,
    operationKey:'door:'+child.plan_id,reviewedFingerprint:snapshot.plan.fingerprint,
    storage:{database:request.options.database,targets:request.options.targets},batchSize:request.options.bounded!.batchSize ?? 20,maxBatches:1,reversalPolicy:'strict',
    authorization:{principalId:request.options.ownerPrincipalId,predicate(action,destination) {
      if (destination!==root.destination || !['read',...(mode==='apply'?['create','apply']:mode==='reverse'?['undo','rollback']:[])].includes(action)) return sql('0');
      return authority(request,active);
    }}};
  bindWaveContext(result,root.id,mode);
  return result;
}
export async function applyChild(request: DoorRequest, input: Record<string,unknown>) {
  const root=await rootRow(request,input);
  if (!['approved','applying','completed'].includes(root.state)) throw new DoorError('approved_parent_required',409);
  if (!Number.isSafeInteger(input.ordinal) || (input.ordinal as number)<0) throw new DoorError('invalid_child_ordinal',400);
  const all=await children(request,root), child=all[input.ordinal as number];
  if (!child || request.access.bounded?.childFingerprint!==child.fingerprint || input.reviewedFingerprint!==child.fingerprint) throw new DoorError('child_fingerprint_mismatch');
  const failure=await failedPlan(request,child.plan_id);if (failure) requireNewPlan(child.plan_id,failure);
  if (child.source>Math.min(request.access.maxRecords,request.options.limits?.maxRecords ?? request.access.maxRecords) || child.native>Math.min(request.access.maxRecords,request.options.limits?.maxRecords ?? request.access.maxRecords)) throw new DoorError('child_exceeds_grant_quota',413);
  await assertPredicate(request,activeParent(request,root),'parent_approval_revoked');
  for (const predecessor of all.slice(0,child.ordinal)) {
    const job=predecessor.job_id && await request.options.database.prepare('SELECT state FROM ik_jobs WHERE id=?').bind(predecessor.job_id).first<any>();
    if (!job || job.state!=='completed') throw new DoorError('child_dependency_incomplete',409);
  }
  await approve(request,root,child.ordinal,child.fingerprint);
  if (root.state==='approved') await transition(request,root,'applying',activeParent(request,root));
  const snapshot=await childSnapshot(request,child), ctx=await context(request,root,child,'apply');
  const job=await createD1ImportJob(snapshot.plan,ctx);
  await transact(request.options.database,authority(request,approvalFence(request,root,child)),[
    sql('INSERT OR IGNORE INTO ik_door_wave_origins(job_id,parent_id,ordinal,plan_id,fingerprint) VALUES(?,?,?,?,?)',job.id,root.id,child.ordinal,child.plan_id,snapshot.plan.fingerprint),
    assertion(sql('EXISTS(SELECT 1 FROM ik_door_wave_origins WHERE job_id=? AND parent_id=? AND ordinal=? AND plan_id=? AND fingerprint=?)',job.id,root.id,child.ordinal,child.plan_id,snapshot.plan.fingerprint)),
    sql('UPDATE ik_door_plans SET job_id=? WHERE id=? AND (job_id IS NULL OR job_id=?)',job.id,child.plan_id,job.id),
    assertion(sql('EXISTS(SELECT 1 FROM ik_door_plans WHERE id=? AND job_id=?)',child.plan_id,job.id)),
  ]);
  const result=await applyD1ImportBatches(job.id,ctx).catch(async error=>{
    if (sizeLimitError(error)) throw error;
    const code=reasonCode(error);
    // Durable failure bookkeeping grants no native authority. A concurrent
    // successful batch or erasure prevents this exact pre-batch transition.
    await transact(request.options.database,sql('1'),[
      assertion(sql('(SELECT count(*) FROM ik_d1_erasure_journal WHERE destination=?)=?',root.destination,root.epoch)),
      assertion(sql('EXISTS(SELECT 1 FROM ik_door_plan_chunks WHERE plan_id=?)',child.plan_id)),
      assertion(sql("EXISTS(SELECT 1 FROM ik_door_grants WHERE installation_id=? AND jti=? AND action='apply-child' AND namespace=?)",root.installation_id,request.nonce!.jti,root.namespace)),
      assertion(sql("EXISTS(SELECT 1 FROM ik_jobs WHERE id=? AND fingerprint=? AND fence=? AND checkpoint=? AND state IN ('queued','applying'))",job.id,job.fingerprint,job.fence,job.checkpoint)),
      sql('INSERT INTO ik_door_apply_failures(plan_id,reason_code) VALUES(?,?)',child.plan_id,code),
      sql("UPDATE ik_jobs SET state='failed',error=?,fence=fence+1 WHERE id=?",code,job.id),
    ]);
    throw new DoorError(code,code==='import_door_apply_transient'?503:409,{parentId:root.id,ordinal:child.ordinal,requiresNewParent:true,requiresNewApproval:true});
  });
  return {protocol:BOUNDED_WAVES,parentId:root.id,ordinal:child.ordinal,fingerprint:child.fingerprint,job:result,
    childSuccess:result.state==='completed',aggregateSuccess:false};
}
export async function finalize(request: DoorRequest, input: Record<string,unknown>) {
  const root=await rootRow(request,input);
  if (!['applying','completed'].includes(root.state)) throw new DoorError('parent_not_applied',409);
  const parent=activeParent(request,root);
  await assertPredicate(request,parent,'parent_approval_revoked');
  const all=await children(request,root), expected=JSON.parse(root.census_json) as WaveCensus;
  if (await storedInventoryHash(request.options.database,root.id)!==expected.inventoryHash) throw new DoorError('aggregate_census_mismatch',409);
  if (all.length!==expected.children) throw new DoorError('aggregate_children_missing',409);
  const totals=zeroTotals(), guards=[parent,rootFence(root)];
  const dispositions={mapped:0,rejected:0,explained:0,reused:0};
  let protocolBytes=0;
  const delivered=[], old=await prior(request,root);
  for (const child of all) {
    if (!child.job_id) throw new DoorError('aggregate_children_missing',409);
    const revision=await request.options.database.prepare('SELECT revision FROM ik_d1_custody_states WHERE job_id=?').bind(child.job_id).first<{revision:number}>();
    if (!revision) throw new DoorError('aggregate_child_journal_mismatch',409);
    guards.push(sql('EXISTS(SELECT 1 FROM ik_d1_custody_states WHERE job_id=? AND revision=?)',child.job_id,revision.revision),
      sql('EXISTS(SELECT 1 FROM ik_door_wave_origins WHERE job_id=? AND parent_id=? AND ordinal=? AND plan_id=?)',child.job_id,root.id,child.ordinal,child.plan_id));
    const ctx=await context(request,root,child,'read'), job=await readD1ImportJob(child.job_id,ctx);
    if (job.state!=='completed' || job.checkpoint!==job.total) throw new DoorError('aggregate_children_incomplete',409);
    const snapshot=await childSnapshot(request,child);
    if (job.total!==snapshot.sourceCount) throw new DoorError('aggregate_child_journal_mismatch',409);
    const journal=childJournalGuards(job.id,snapshot.plan);
    for (const guard of journal) await assertPredicate(request,guard,'aggregate_child_journal_mismatch');
    guards.push(...journal);
    for (const original of await readD1ImportOriginals(child.job_id,ctx)) {
      if (original.original.status!=='retained') throw new DoorError('aggregate_bytes_unreadable',410);
      const bytes=Buffer.from(original.original.base64,'base64');
      if (bytes.length!==original.size || sha256(bytes)!==original.sha256) throw new DoorError('aggregate_bytes_unreadable',410);
    }
    guards.push(request.options.bounded!.authority({...request.access.bounded!,childFingerprint:child.fingerprint},'finalize-parent'),sql(`EXISTS(SELECT 1 FROM ik_jobs WHERE id=? AND state='completed' AND fingerprint=? AND fence=? AND checkpoint=?)`,job.id,job.fingerprint,job.fence,job.checkpoint),
      sql('EXISTS(SELECT 1 FROM ik_door_wave_approvals WHERE parent_id=? AND ordinal=? AND revoked=0 AND fingerprint=?)',root.id,child.ordinal,child.fingerprint));
    dispositions.mapped+=snapshot.plan.counts.mapped;dispositions.rejected+=snapshot.plan.counts.rejected;dispositions.explained+=snapshot.records.filter(r=>!r.targets.length && !snapshot.plan.entries.find(e=>e.source.kind===r.kind && e.source.sourceId===r.sourceId)?.rejection).length;dispositions.reused+=snapshot.differences.unchanged.length;
    protocolBytes+=snapshot.plan.source.artifacts.filter(a=>a.name==='rer-package.json').reduce((n,a)=>n+a.size,0);
    delivered.push(...snapshot.records);
    for (const key of totalKeys) totals[key]+=child[key];
  }
  if (totalKeys.some(k=>totals[k]!==expected[k])) throw new DoorError('aggregate_census_mismatch',409);
  const seen=new Set(delivered.map(r=>hash([r.kind,r.sourceId]))), gone=[...old.values()].filter(r=>!seen.has(hash([r.kind,r.sourceId])));
  guards.push(...await ownedFence(request,[...delivered,...gone]));
  const lineage=sql('EXISTS(SELECT 1 FROM ik_door_namespaces WHERE installation_id=? AND namespace=? AND ((pending_id=? AND head_id IS ?) OR (pending_id IS NULL AND head_id=?)))',root.installation_id,root.namespace,root.id,root.previous_id,root.id);
  await transact(request.options.database,authority(request,conjunction([...guards.slice(0,1),lineage])),[
    ...guards.slice(1).map(assertion),
    sql("UPDATE ik_door_wave_roots SET state='completed' WHERE id=?",root.id),
    sql('UPDATE ik_door_namespaces SET head_id=?,pending_id=NULL WHERE installation_id=? AND namespace=?',root.id,root.installation_id,root.namespace),
  ],[...guards.filter((_,i)=>i!==1),rootFence({...root,state:'completed'})]);
  return {protocol:BOUNDED_WAVES,parentId:root.id,fingerprint:root.fingerprint,aggregateSuccess:true,completeHead:root.id,
    counts:totals,dispositions,nativeSuccess:dispositions.rejected===0 && dispositions.explained===0,metadata:{manifestCopies:all.length,originalManifestBytes:protocolBytes},retainedNativeTargets:gone.reduce((n,r)=>n+r.targets.length,0),goneButRetained:gone.map(r=>({kind:r.kind,sourceId:r.sourceId})),children:all.length};
}
export async function reverseParent(request: DoorRequest, input: Record<string,unknown>) {
  const root=await rootRow(request,input), parent=activeParent(request,root);
  await assertPredicate(request,parent,'parent_approval_revoked');
  const line=await request.options.database.prepare('SELECT head_id,pending_id FROM ik_door_namespaces WHERE installation_id=? AND namespace=?').bind(root.installation_id,root.namespace).first<any>();
  if (!line || (line.pending_id!==root.id && line.head_id!==root.id) || line.pending_id && line.pending_id!==root.id) throw new DoorError('parent_superseded',409);
  if (root.state==='reversed') return parentView(request,root);
  if (!['approved','applying','completed','reversing'].includes(root.state)) throw new DoorError('parent_reverse_refused',409);
  // Full known-conflict preflight, followed by each ordinary strict transaction.
  // This is resumable partial reversal, never whole-database atomicity.
  await executionFence(request,root);
  if (root.state!=='reversing') await transition(request,root,'reversing',parent);
  const all=await children(request,root);
  for (const child of all.toReversed()) {
    if (!child.job_id) continue;
    const ctx=await context(request,root,child,'reverse'), job=await readD1ImportJob(child.job_id,ctx);
    if (['undone','rolled_back'].includes(job.state)) continue;
    const result=await (['completed','undoing'].includes(job.state)?undoD1Import:rollbackD1Import)(job.id,ctx);
    return {protocol:BOUNDED_WAVES,parentId:root.id,state:'reversing',ordinal:child.ordinal,job:result,aggregateSuccess:false};
  }
  await transact(request.options.database,authority(request,parent),[
    assertion(rootFence(root)),
    sql("UPDATE ik_door_wave_roots SET state='reversed' WHERE id=?",root.id),
    sql('UPDATE ik_door_namespaces SET head_id=CASE WHEN head_id=? THEN ? ELSE head_id END,pending_id=NULL WHERE installation_id=? AND namespace=?',root.id,root.previous_id,root.installation_id,root.namespace),
  ]);
  return parentView(request,{...root,state:'reversed'});
}
async function parentView(request: DoorRequest, root: WaveRoot) {
  const all=await children(request,root), states=[];
  for (const child of all) {
    const job=child.job_id ? await request.options.database.prepare('SELECT state,checkpoint,total,error FROM ik_jobs WHERE id=?').bind(child.job_id).first<any>() : null;
    states.push({ordinal:child.ordinal,fingerprint:child.fingerprint,source:child.source,native:child.native,job:job ?? null,childSuccess:job?.state==='completed'});
  }
  const withdrawn=root.state==='withdrawn' || root.epoch!==request.epoch;
  return {protocol:BOUNDED_WAVES,parentId:root.id,fingerprint:root.fingerprint,state:withdrawn?'withdrawn':root.state,
    census:JSON.parse(root.census_json),children:states,progress:{expected:JSON.parse(root.census_json).children,applied:states.filter(c=>c.childSuccess).length,pending:states.filter(c=>!c.job || ['queued','applying'].includes(c.job.state)).length,failed:states.filter(c=>c.job?.state==='failed').length,reversed:states.filter(c=>['undone','rolled_back'].includes(c.job?.state)).length,withdrawn},aggregateSuccess:false,completionRecorded:!withdrawn && root.state==='completed'};
}
export async function waveStatus(request: DoorRequest, input: Record<string,unknown>) {
  const root=await rootRow(request,input,true), result=await parentView(request,root);
  await authorized({...request,authority:authority(request)});
  return result;
}
