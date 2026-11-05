import {inventoryMember, type WaveInventoryMember} from './digests.ts';
import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type { DoorRequest, DoorSnapshot } from '../types.ts';
import type { MappingResult, SourceBundle } from '../../types.ts';
import { limitsFor, RecordCollector } from '../../readers/records.ts';
import { planD1Import } from '../../d1/jobs.ts';
import { packageUpload } from '../package.ts';
import { bundleBytes, uploadRow, text } from '../uploads.ts';
import { DoorError } from '../protocol.ts';
import { sourceRefusal } from '../refusals.ts';
import { assertion, lineage, sql, transact } from '../store.ts';
import { forget, refuseErased } from '../planning.ts';
import { recordKey, importedTargets } from '../inventory.ts';
import { BOUNDED_WAVES, totalKeys, zeroTotals, type WaveCensus, type WaveDescriptor, type WaveMetadata, type WaveRoot } from './types.ts';
import { authority, children, hash, opaque, revision, rootFence, rootRow, saveChild } from './store.ts';
import { prior, snapshotRecords } from './inventory.ts';

const count = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number)>=0;
const digest = (s: unknown): s is string => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
const byKind = (v: Record<string,number>) => v && typeof v==='object' && !Array.isArray(v) && Object.entries(v).every(([k,n])=>k.length>0 && count(n));
function census(value: WaveCensus): WaveCensus {
  if (!value || Object.keys(value).some(k=>![...totalKeys,'children','byKind','nativeByTable','inventoryHash','relationshipsHash','baselineHash','sourceMode','highWater','accountingVersion'].includes(k)) || !totalKeys.every(k=>count(value[k])) || !count(value.children) || !value.children || value.sourceMode !== 'complete'
    || !byKind(value.byKind) || !byKind(value.nativeByTable) || Object.values(value.byKind).reduce((a,b)=>a+b,0)!==value.source
    || Object.values(value.nativeByTable).reduce((a,b)=>a+b,0)!==value.native
    || ![value.inventoryHash,value.relationshipsHash,value.baselineHash].every(digest) || !opaque(value.accountingVersion) || !opaque(value.highWater)) throw new DoorError('invalid_complete_census',422);
  return JSON.parse(JSON.stringify(value));
}
export function planningContext(request: DoorRequest, namespace: string) {
  return {destination:request.options.destination,namespace,mappingVersion:request.options.mapping.version,
    storage:{database:request.options.database,targets:request.options.targets},authorization:{principalId:request.options.ownerPrincipalId,predicate:()=>authority(request)}};
}
async function begin(request: DoorRequest, input: Record<string,unknown>) {
  const b = revision(request), upload = await uploadRow(request,text(input.uploadId,'upload_id'));
  const pkg = await packageUpload(request,upload), totals = census(await request.options.bounded!.describe(pkg));
  if (pkg.manifest.records.total!==null && (totals.source!==pkg.manifest.records.total || hash(totals.byKind)!==hash(pkg.manifest.records.byKind))) throw new DoorError('package_record_count_mismatch',422);
  const binding = {protocol:BOUNDED_WAVES,migration:b.migration,revision:b.revision,policy:b.policy};
  const priorRoot = await request.options.database.prepare("SELECT * FROM ik_door_wave_roots WHERE installation_id=? AND namespace=? AND json_extract(binding_json,'$.migration')=? AND json_extract(binding_json,'$.revision')=?")
    .bind(request.access.installationId,request.access.namespace,b.migration,b.revision).first<WaveRoot>();
  if (priorRoot) {
    if (priorRoot.bundle_sha256!==upload.bundle_sha256 || priorRoot.binding_json!==JSON.stringify(binding) || priorRoot.state==='cancelled') throw new DoorError('parent_revision_immutable',409);
    return rootRow(request,{parentId:priorRoot.id});
  }
  const current = await lineage(request);
  if (current.pending_id || current.head_id) {
    const held=await request.options.database.prepare('SELECT state,epoch FROM ik_door_wave_roots WHERE id=?').bind(current.pending_id ?? current.head_id).first<any>();
    if (held && (held.state==='withdrawn' || held.epoch!==request.epoch)) throw new DoorError('source_erased',410);
  }
  if (current.pending_id) throw new DoorError('namespace_has_pending_import',409);
  if (!!current.head_id !== (input.catchup === true)) throw new DoorError(current.head_id?'catchup_required':'catchup_requires_baseline',409);
  const root: WaveRoot = {id:randomUUID(),installation_id:request.access.installationId,namespace:request.access.namespace,destination:request.options.destination,
    owner:request.access.email,mapping_version:request.options.mapping.version,bundle_sha256:upload.bundle_sha256,upload_id:upload.id,previous_id:current.head_id,
    epoch:request.epoch,binding_json:JSON.stringify(binding),census_json:JSON.stringify(totals),fingerprint:null,state:'preparing',pages:0,chain:hash([]),catchup:input.catchup===true?(request.access.catchup==='bounded'?1:2):0};
  // No implicit conversion of an ordinary or withdrawn baseline.
  if (root.previous_id) {
    await prior(request,root);
    const previous=await request.options.database.prepare('SELECT binding_json FROM ik_door_wave_roots WHERE id=?').bind(root.previous_id).first<any>();
    if (!previous || JSON.parse(previous.binding_json).migration!==b.migration) throw new DoorError('migration_lineage_changed',409);
  }
  await transact(request.options.database,authority(request),[
    sql('INSERT OR IGNORE INTO ik_door_namespaces(installation_id,namespace) VALUES(?,?)',root.installation_id,root.namespace),
    assertion(sql('EXISTS(SELECT 1 FROM ik_door_namespaces WHERE installation_id=? AND namespace=? AND head_id IS ? AND pending_id IS NULL)',root.installation_id,root.namespace,root.previous_id)),
    assertion(sql("? IS NULL OR EXISTS(SELECT 1 FROM ik_door_wave_roots WHERE id=? AND state='completed' AND fingerprint=? AND epoch=?)",root.previous_id,root.previous_id,totals.baselineHash,root.epoch)),
    sql(`INSERT INTO ik_door_wave_roots(id,installation_id,namespace,destination,owner,mapping_version,bundle_sha256,upload_id,previous_id,epoch,binding_json,census_json,fingerprint,state,pages,chain,catchup) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,...Object.values(root)),
    sql('UPDATE ik_door_namespaces SET pending_id=? WHERE installation_id=? AND namespace=?',root.id,root.installation_id,root.namespace),
  ]);
  return root;
}
export async function prepare(request: DoorRequest, input: Record<string,unknown>) {
  if (input.cancel===true) {
    const root=await rootRow(request,input);
    const clear=sql("NOT EXISTS(SELECT 1 FROM ik_door_wave_approvals WHERE parent_id=?) AND NOT EXISTS(SELECT 1 FROM ik_door_wave_children c JOIN ik_jobs j ON j.operation_key='door:'||c.plan_id WHERE c.parent_id=?)",root.id,root.id);
    await transact(request.options.database,authority(request,clear),[
      assertion(rootFence(root)),
      sql('DELETE FROM ik_door_plan_chunks WHERE plan_id IN (SELECT plan_id FROM ik_door_wave_children WHERE parent_id=?)',root.id),
      sql("UPDATE ik_door_wave_roots SET state='cancelled' WHERE id=?",root.id),
      sql('UPDATE ik_door_namespaces SET pending_id=NULL WHERE installation_id=? AND namespace=? AND pending_id=?',root.installation_id,root.namespace,root.id),
    ]);
    return {protocol:BOUNDED_WAVES,parentId:root.id,state:'cancelled',aggregateSuccess:false};
  }
  try { return await preparePage(request,input); }
  catch (caught) {
    const refused=caught instanceof DoorError ? caught : sourceRefusal(caught);
    if (refused && ['source_erased','source_credential','source_invalid_or_credential_source_data'].includes(refused.code)) {
      const row=input.parentId ? await request.options.database.prepare('SELECT upload_id,id FROM ik_door_wave_roots WHERE id=? AND installation_id=? AND namespace=?').bind(input.parentId,request.access.installationId,request.access.namespace).first<any>() : null;
      const upload=await uploadRow(request,text(row?.upload_id ?? input.uploadId,'upload_id'));
      const segments: import('../uploads.ts').UploadRow[]=[];
      try { await packageUpload(request,upload,rows=>segments.push(...rows)); } catch { /* Already missing custody stays missing. */ }
      await forget(request,upload,segments);
      const root=row ?? await request.options.database.prepare('SELECT id FROM ik_door_wave_roots WHERE upload_id=? AND installation_id=? AND namespace=?').bind(upload.id,request.access.installationId,request.access.namespace).first<any>();
      if (root) await transact(request.options.database,authority(request),[
        sql('DELETE FROM ik_door_plan_chunks WHERE plan_id IN (SELECT plan_id FROM ik_door_wave_children WHERE parent_id=?)',root.id),
        sql("UPDATE ik_door_wave_roots SET state='withdrawn' WHERE id=?",root.id),
      ]);
    }
    throw refused ?? caught;
  }
}
async function preparePage(request: DoorRequest, input: Record<string,unknown>) {
  if (Object.keys(input).some(k=>!['parentId','uploadId','ordinal','catchup'].includes(k)) || !count(input.ordinal) || input.catchup!==undefined && typeof input.catchup!=='boolean') throw new DoorError('invalid_prepare_input',400);
  const root = input.parentId ? await rootRow(request,input) : await begin(request,input);
  const expected = JSON.parse(root.census_json) as WaveCensus;
  if (input.ordinal < root.pages) {
    const child = (await children(request,root))[input.ordinal];
    return {protocol:BOUNDED_WAVES,parentId:root.id,state:root.state,next:root.pages,child:{ordinal:child.ordinal,fingerprint:child.fingerprint}};
  }
  if (root.state !== 'preparing' || input.ordinal !== root.pages || root.pages >= expected.children) throw new DoorError('preparation_cursor_mismatch',409);
  const upload = await uploadRow(request,root.upload_id), segments: any[]=[];
  const pkg = await packageUpload(request,upload,rows=>segments.push(...rows));
  if (hash(census(await request.options.bounded!.describe(pkg))) !== hash(expected)) throw new DoorError('preparation_census_changed',409);
  const limits = limitsFor({...request.options.limits,maxRecords:Math.min(request.access.maxRecords,request.options.limits?.maxRecords ?? request.access.maxRecords)});
  const unit = await request.options.bounded!.page(pkg,root.pages,Object.freeze({...limits}));
  if (!unit || Object.keys(unit).some(k=>!['id','dependsOn','records','files','aliases','relationshipsHash'].includes(k)) || !opaque(unit.id) || !Array.isArray(unit.dependsOn) || unit.dependsOn.some(d=>!opaque(d)) || new Set(unit.dependsOn).size!==unit.dependsOn.length
    || !Array.isArray(unit.aliases) || unit.aliases.some(a=>!a || Object.keys(a).some(k=>!['kind','sourceId','role','files'].includes(k)) || typeof a.kind!=='string' || !a.kind || typeof a.sourceId!=='string' || !a.sourceId || !['context','archive','rejected','metadata'].includes(a.role) || !Array.isArray(a.files) || a.files.some(path=>typeof path!=='string' || !pkg.files.some(f=>f.path===path)))
    || !Array.isArray(unit.records) || !unit.records.length || unit.records.some(r=>!r || Object.keys(r).some(k=>!['kind','sourceId','payload','pointer'].includes(k))) || !Array.isArray(unit.files) || unit.files.some(f=>!f || Object.keys(f).some(k=>!['path','role','logicalBytes'].includes(k))) || !digest(unit.relationshipsHash)) throw new DoorError('invalid_native_work_unit',422);
  if (unit.records.length>limits.maxRecords) throw new DoorError('child_exceeds_source_quota',413,{source:unit.records.length,limit:limits.maxRecords});
  const metadata={id:unit.id,dependsOn:[...unit.dependsOn],relationshipsHash:unit.relationshipsHash,files:unit.files.map(f=>({...f})),aliases:unit.aliases.map(a=>({...a,files:[...a.files]}))},sourceCount=unit.records.length;
  const previousChildren = await children(request,root), dependsOn = metadata.dependsOn.map(hash);
  if (dependsOn.some(dep=>!previousChildren.some(child=>child.unit_hash===dep))) throw new DoorError('child_dependency_unprepared',409);
  const namespace = 'door-wave:' + hash([root.installation_id,root.namespace,root.destination,JSON.parse(root.binding_json).migration,JSON.parse(root.binding_json).revision]);
  const collector = new RecordCollector(namespace,limits);
  collector.add(unit.records,{artifact:'rer-package.json'},root.bundle_sha256);
  const totals = zeroTotals(), members: WaveInventoryMember[] = [];
  const source: SourceBundle = collector.bundle;
  source.artifacts.push({name:'rer-package.json',sha256:root.bundle_sha256,size:upload.total_bytes,original:{status:'available' as const,base64:Buffer.from(await bundleBytes(request,upload)).toString('base64')}});
  const fileRoles = new Set<string>();
  for (const file of metadata.files) {
    const declared = pkg.files.find(f=>f.path===file.path);
    if (!declared || fileRoles.has(file.path) || !['source','object','context'].includes(file.role) || !count(file.logicalBytes)) throw new DoorError('invalid_work_unit_file',422);
    fileRoles.add(file.path);
    const bytes = await pkg.read(file.path);
    source.artifacts.push({name:file.path,sha256:declared.sha256,size:bytes.length,original:{status:'available',base64:Buffer.from(bytes).toString('base64')}});
    members.push(inventoryMember('file',file.path,[declared.sha256,declared.bytes,file.role,file.logicalBytes]));
    totals.storedBytes+=bytes.length; totals.logicalBytes+=file.logicalBytes;
    if (file.role==='object') totals.objects++;
    if (file.role==='context') totals.contextBytes+=bytes.length;
  }
  const old = await prior(request,root), id = randomUUID();
  const differences: DoorSnapshot['differences'] = {additions:[],replacements:[],unchanged:[],gone:[],conflicts:[]};
  const mapper = {version:root.mapping_version,map(record: SourceBundle['records'][number]): MappingResult {
    const key=recordKey(record), before=old.get(key);
    if (before && before.sourceHash===hash([record.payloadHash,metadata.relationshipsHash,root.mapping_version])) {
      differences.unchanged.push(key); return {effects:[],unmapped:[{reason:'Unchanged source; exact earlier journal retained.'}]};
    }
    const mapped=request.options.mapping.map(record);
    if (before?.targets.length && !mapped.rejection) {
      const keys=mapped.effects.map(e=>hash([e.targetKind,e.targetId])).sort(), previous=before.targets.map(t=>hash([t.kind,t.id])).sort();
      if (hash(keys)!==hash(previous)) throw new DoorError('changed_target_set_requires_proposal',409);
    }
    if (mapped.rejection) differences.conflicts.push(key);
    else if (mapped.effects.length) (before?.targets.length?differences.replacements:differences.additions).push(key);
    return mapped;
  }};
  // Establish earlier ownership before deriving replacement revisions.
  const oldTargets=[...old.values()].flatMap(r=>r.targets), found=await importedTargets(request,oldTargets);
  if (found.some(row=>!row.matches)) throw new DoorError('native_edit_conflict',409);
  const revisions=new Map(oldTargets.map((t,i)=>[hash([t.kind,t.id]),found[i].provenance.appliedRevision]));
  const mapping={...mapper,map(record:typeof source.records[number]) {const mapped=mapper.map(record);return {...mapped,effects:mapped.effects.map(e=>revisions.has(hash([e.targetKind,e.targetId]))?{...e,expectedRevision:revisions.get(hash([e.targetKind,e.targetId]))}:e)};}};
  const plan = await planD1Import(source,mapping,planningContext(request,namespace));
  if (plan.counts.duplicates || plan.entries.length!==sourceCount) throw new DoorError('duplicate_source_membership',422);
  await refuseErased(request,upload,plan,segments);
  const suppliedNative = request.options.bounded!.native(plan);
  const native = Array.isArray(suppliedNative) ? suppliedNative.map(row=>({...row})) : suppliedNative;
  if (!Array.isArray(native) || native.some(n=>!n || Object.keys(n).some(k=>!['table','key','valueHash','storedBytes','blobBytes'].includes(k)) || typeof n.table!=='string' || !n.table || typeof n.key!=='string' || !n.key || !digest(n.valueHash) || !count(n.storedBytes) || !count(n.blobBytes))
    || native.length<plan.counts.effects) throw new DoorError('invalid_native_accounting',422);
  totals.source=plan.counts.unique; totals.native=native.length;
  const nativeByTable:Record<string,number>=Object.create(null);
  for (const row of native) { nativeByTable[row.table]=(nativeByTable[row.table] ?? 0)+1; totals.blobBytes+=row.blobBytes;totals.nativeBytes+=row.storedBytes; members.push(inventoryMember('native',[row.table,row.key],row)); }
  totals.aliases=metadata.aliases.length;
  for (const alias of metadata.aliases) members.push(inventoryMember('alias',[alias.kind,alias.sourceId],alias));
  const stable=[...plan.entries.map(entry=>hash([entry.source.kind,entry.source.sourceId])),...metadata.aliases.map(a=>hash([a.kind,a.sourceId]))];
  const withdrawn=await request.options.database.prepare("SELECT 1 FROM ik_door_wave_members m JOIN ik_door_wave_roots r ON r.id=m.parent_id WHERE r.installation_id=? AND r.namespace=? AND r.destination=? AND r.state='withdrawn' AND r.epoch<? AND m.type IN ('source','alias') AND m.identity IN (SELECT value FROM json_each(?)) LIMIT 1").bind(root.installation_id,root.namespace,root.destination,root.epoch,JSON.stringify(stable)).first();
  const erasedAlias=await request.options.database.prepare('SELECT 1 FROM ik_door_wave_erased_aliases WHERE installation_id=? AND namespace=? AND destination=? AND identity IN (SELECT value FROM json_each(?)) LIMIT 1').bind(root.installation_id,root.namespace,root.destination,JSON.stringify(stable)).first();
  if (withdrawn || erasedAlias) throw new DoorError('source_erased',410);
  for (const entry of plan.entries) members.push(inventoryMember('source',[entry.source.kind,entry.source.sourceId],entry.source.payloadHash));
  if (totals.native>limits.maxRecords) throw new DoorError('child_exceeds_native_quota',413,{native:totals.native,limit:limits.maxRecords});
  for (const effect of plan.entries.flatMap(e=>e.effects)) if (effect.attachment && !source.artifacts.some(a=>a.sha256===effect.attachment!.sha256)) throw new DoorError('attachment_original_not_accounted',422);
  const baseline=[];
  for (const effect of plan.entries.flatMap(e=>e.effects)) baseline.push({kind:effect.targetKind,id:effect.targetId,row:await request.options.targets.read(request.options.database,root.destination,effect.targetKind,effect.targetId) ?? null});
  if (totalKeys.some(k=>!count(totals[k]))) throw new DoorError('native_accounting_overflow',413);
  const descriptor: WaveDescriptor = {...totals,ordinal:root.pages,unitHash:hash(metadata.id),dependsOn,membershipHash:hash(members),planFingerprint:plan.fingerprint,
    relationshipsHash:metadata.relationshipsHash,nativeByTable,baseline,projections:native,fingerprint:''};
  const {fingerprint:_fingerprint,...reviewed}=descriptor;
  descriptor.fingerprint=hash(reviewed);
  const snapshot: DoorSnapshot & {wave:WaveMetadata} = {id,namespace:root.namespace,bundleSha256:root.bundle_sha256,kitNamespace:namespace,
    previous:root.previous_id,records:[],sourceCount:totals.source,plan,differences,standingApproval:null,wave:{unit:metadata,descriptor}};
  snapshot.records=snapshotRecords(snapshot,old,metadata.relationshipsHash);
  await saveChild(request,root,snapshot,members,hash([root.chain,descriptor.fingerprint]));
  return {protocol:BOUNDED_WAVES,parentId:root.id,state:'preparing',next:root.pages+1,child:{ordinal:root.pages,fingerprint:descriptor.fingerprint,totals}};
}
