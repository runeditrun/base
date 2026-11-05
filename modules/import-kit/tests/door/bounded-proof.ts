import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { door } from './fixture.ts';
import { boundedCliProof } from './bounded-cli-proof.ts';
import { createImportDoorHandler, importDoorBoundedWavesMigration, waveInventoryHash } from '../../src/door/index.ts';
import type { ImportDoorBoundedSource, WaveCensus, WaveBinding, DoorGrant, ImportDoorPackageSource } from '../../src/door/index.ts';
import { canonicalJson, sha256 } from '../../src/provenance/identity.ts';
import { retireD1ImportCustody, readD1ImportOriginals, applyD1ImportBatches } from '../../src/d1/index.ts';
import { sqliteTargets } from '../d1/sqlite-runtime.ts';
import { buildPackage, transferPackage } from '../../../../cli/business/package-transfer.mjs';
import { sendBoundedWaves } from '../../../../cli/business/bounded-waves.mjs';
import { door as networkDoor } from '../../../../cli/business/vendor-door.mjs';
import type { D1TargetAdapter } from '../../src/d1/types.ts';
const protocol='rer-bounded-waves/1' as const;
const hash=(value:unknown)=>sha256(canonicalJson(value));
const quota={maxBytes:65_536,maxChunks:1,maxRecords:3};
const binding={protocol,migration:'migration-1',revision:'revision-1',policy:'policy-1'};

export async function boundedProof(t: TestContext) {
 const d=await door(t);await d.enable();const db=d.runtime.native();
 for(const trigger of db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name GLOB 'ik_door_wave*'").all())db.exec(`DROP TRIGGER ${trigger.name}`);
 db.exec('DROP TABLE ik_door_wave_erased_aliases; DROP TABLE ik_door_wave_origins; DROP TABLE ik_door_wave_approvals; DROP TABLE ik_door_wave_members; DROP TABLE ik_door_wave_children; DROP TABLE ik_door_wave_roots');
 const legacyUpload=await d.upload([{id:'prior',title:'Existing history'}],{namespace:'prior-history'});
 const legacy=await d.call('plan',{uploadId:legacyUpload},{namespace:'prior-history'});assert.equal(legacy.status,200);
 await d.apply(legacy.body,{namespace:'prior-history'});
 const priorRows=()=>['ik_jobs','ik_originals','ik_provenance'].map(table=>db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
 const previousData=hash(priorRows());
 await d.db.batch(importDoorBoundedWavesMigration.map(q=>d.db.prepare(q)));
 await d.db.batch(importDoorBoundedWavesMigration.map(q=>d.db.prepare(q)));
 assert.equal(hash(priorRows()),previousData);
 await d.call('undo',{planId:legacy.body.planId},{namespace:'prior-history'});
 t.diagnostic('MECHANICAL additive wave schema applied twice over a completed ordinary import; previous job/original/provenance rows byte-identical');
 db.exec('CREATE TABLE native_blob_chunks(id TEXT,ordinal INTEGER,base64 TEXT,PRIMARY KEY(id,ordinal)); CREATE TABLE native_links(id TEXT PRIMARY KEY,parent TEXT); CREATE TABLE native_wave_permissions(fingerprint TEXT PRIMARY KEY,enabled INTEGER)');
 const targets:D1TargetAdapter={...sqliteTargets,preparePreservedUndo:undefined,
  async read(database,destination,kind,id) {
   const row=await sqliteTargets.read(database,destination,kind,id); if(!row)return;
   const chunks=await database.prepare('SELECT base64 FROM native_blob_chunks WHERE id=? ORDER BY ordinal').bind(id).all<any>();
   if(chunks.results.length) {const bytes=Buffer.concat(chunks.results.map(r=>Buffer.from(r.base64,'base64')));row.attachment={base64:bytes.toString('base64'),sha256:sha256(bytes),mediaType:'application/octet-stream'};}
   return row;
  },
  matches(row,destination,kind,id) {const base=sqliteTargets.matches(row,destination,kind,id);return {sql:`(${base.sql}) AND COALESCE((SELECT parent FROM native_links WHERE id=?),'')=? AND COALESCE((SELECT group_concat(base64,'') FROM (SELECT base64 FROM native_blob_chunks WHERE id=? ORDER BY ordinal)),'')=?`,params:[...base.params!,id,(row?.value as any)?.depends ?? '',id,row?.attachment?.base64 ?? '']};},
  write(row) {const bytes=row.attachment?Buffer.from(row.attachment.base64,'base64'):Buffer.alloc(0);return [...sqliteTargets.write(row),{sql:'DELETE FROM native_blob_chunks WHERE id=?',params:[row.targetId]},...Array.from({length:Math.ceil(bytes.length/60_000)},(_,ordinal)=>({sql:'INSERT INTO native_blob_chunks VALUES(?,?,?)',params:[row.targetId,ordinal,bytes.subarray(ordinal*60_000,(ordinal+1)*60_000).toString('base64')]})),
   {sql:'DELETE FROM native_links WHERE id=?',params:[row.targetId]},...((row.value as any).depends?[{sql:'INSERT INTO native_links VALUES(?,?)',params:[row.targetId,(row.value as any).depends]}]:[])];},
  remove(destination,kind,id) {return [{sql:'INSERT INTO ik_d1_assertions(ok) SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM native_links WHERE parent=?) THEN 1 ELSE 0 END',params:[id]}, {sql:'DELETE FROM native_links WHERE id=?',params:[id]},{sql:'DELETE FROM native_blob_chunks WHERE id=?',params:[id]},...sqliteTargets.remove(destination,kind,id)];},
  async list(database,destination) {const rows=await sqliteTargets.list(database,destination);return Promise.all(rows.map(row=>this.read(database,destination,row.targetKind,row.targetId).then(r=>r!)));},
 };
 const root=await mkdtemp(join(tmpdir(),'bounded-door-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const media=Buffer.from('original-object-'.repeat(5300)), sourceRows=Array.from({length:4},(_,i)=>({kind:'document',sourceId:String(i),payload:{id:String(i),title:`Bounded ${i}`,...(i?{depends:'0'}:{media:'object.bin'})}}));
 const files:{path:string;file:string;bytes:number;sha256:string}[]=[];
 for(const [i,row] of sourceRows.entries()){const bytes=Buffer.from(JSON.stringify([row])),path=`rows-${i}.json`,file=join(root,path);await writeFile(file,bytes);files.push({path,file,bytes:bytes.length,sha256:sha256(bytes)});}
 await writeFile(join(root,'object.bin'),media);files.push({path:'object.bin',file:join(root,'object.bin'),bytes:media.length,sha256:sha256(media)});
 const contextBytes=Buffer.from(JSON.stringify([{kind:'context-person',id:'context-only',name:'Context-only fixture person'}]));await writeFile(join(root,'context.json'),contextBytes);files.push({path:'context.json',file:join(root,'context.json'),bytes:contextBytes.length,sha256:sha256(contextBytes)});
 const aliases=[{kind:'context-person',sourceId:'context-only',role:'context' as const,files:['context.json']}];
 const stored=files.reduce((n,f)=>n+f.bytes,0);
 const totals:WaveCensus={source:4,native:9,aliases:1,objects:1,logicalBytes:stored,storedBytes:stored,nativeBytes:0,blobBytes:media.length,contextBytes:contextBytes.length,children:4,byKind:{document:4},nativeByTable:{native_records:4,native_blob_chunks:2,native_links:3},inventoryHash:hash(files),relationshipsHash:hash(['shared-0']),baselineHash:hash([]),sourceMode:'complete',highWater:'snapshot-1',accountingVersion:'schema-1'};
 let expansion=0,grouped=false,rowLimit=4;
 const groups=()=>grouped?[sourceRows.slice(0,1),sourceRows.slice(1,3),sourceRows.slice(3,4)]:sourceRows.slice(0,rowLimit).map(row=>[row]);
 const bounded:ImportDoorBoundedSource={protocol,
  async describe(upload){
   const native=bounded.native({entries:sourceRows.slice(0,rowLimit).map(r=>({source:{...r,payloadHash:hash(r.payload)}}))} as any);
   const previous=db.prepare('SELECT r.fingerprint FROM ik_door_namespaces n JOIN ik_door_wave_roots r ON r.id=n.head_id').get();
   return {...totals,source:rowLimit,children:groups().length,native:native.length,byKind:{document:rowLimit},nativeByTable:Object.fromEntries([...new Set(native.map(r=>r.table))].map(table=>[table,native.filter(r=>r.table===table).length])),storedBytes:upload.files.reduce((n,f)=>n+f.bytes,0),logicalBytes:upload.files.reduce((n,f)=>n+f.bytes,0),nativeBytes:native.reduce((n,r)=>n+r.storedBytes,0),inventoryHash:waveInventoryHash({source:sourceRows.slice(0,rowLimit).map(r=>({...r,payloadHash:hash(r.payload)})),native,aliases,files:upload.files.map(f=>({...f,role:f.path==='object.bin'?'object':f.path==='context.json'?'context':'source',logicalBytes:f.bytes}))}),relationshipsHash:hash(groups().map((_,i)=>hash(i?['shared-0']:[]))),baselineHash:previous?.fingerprint as string ?? hash([])};
  },
  async page(pkg,ordinal){const selected=groups()[ordinal],parsed=[];for(const row of selected)parsed.push(...JSON.parse(Buffer.from(await pkg.read(`rows-${row.sourceId}.json`)).toString()));return {id:`unit-${ordinal}`,dependsOn:ordinal?['unit-0']:[],records:parsed,aliases:ordinal?[]:aliases,relationshipsHash:hash(ordinal?['shared-0']:[]),files:[...selected.map(row=>({path:`rows-${row.sourceId}.json`,role:'source' as const,logicalBytes:files[Number(row.sourceId)].bytes})),...(ordinal?[]:[{path:'object.bin',role:'object' as const,logicalBytes:media.length},{path:'context.json',role:'context' as const,logicalBytes:contextBytes.length}])]};},
  native(plan){return plan.entries.flatMap(entry=>[{table:'native_records',key:entry.source.sourceId,valueHash:entry.source.payloadHash,storedBytes:Buffer.byteLength(canonicalJson(entry.source.payload)),blobBytes:0},...((entry.source.payload as any).depends?[{table:'native_links',key:entry.source.sourceId,valueHash:hash([entry.source.sourceId,(entry.source.payload as any).depends]),storedBytes:entry.source.sourceId.length+String((entry.source.payload as any).depends).length,blobBytes:0}]:[]),...((entry.source.payload as any).media?Array.from({length:2+expansion},(_,i)=>({table:'native_blob_chunks',key:`${entry.source.sourceId}-${i}`,valueHash:sha256(media.subarray(i*60_000,(i+1)*60_000)),storedBytes:Buffer.byteLength(media.subarray(i*60_000,(i+1)*60_000).toString('base64')),blobBytes:Math.max(0,Math.min(60_000,media.length-i*60_000))})):[])]);},
  authority(b){const approved=[b.parentFingerprint,b.childFingerprint].filter(Boolean);return {sql:`EXISTS(SELECT 1 FROM native_authority WHERE id='owner' AND enabled=1)${approved.map(()=> ' AND EXISTS(SELECT 1 FROM native_wave_permissions WHERE fingerprint=? AND enabled=1)').join('')}`,params:approved};},
 };
 const pkg:ImportDoorPackageSource={formats:['bounded-fixture/1'],maxBytes:2**20,maxSegments:32,async read(upload){const rows=[];for(let i=0;i<4;i++)rows.push(...JSON.parse(Buffer.from(await upload.read(`rows-${i}.json`)).toString()));return rows;}};
 const options={...d.options,targets,package:pkg,bounded,mapping:{version:'v1',map:(record:any)=>({effects:[{targetKind:'record',targetId:record.sourceId,value:record.payload,...(record.payload.media?{attachment:{base64:media.toString('base64'),sha256:sha256(media),mediaType:'application/octet-stream'}}:{})}]})}};
 d.mount(createImportDoorHandler(options));
 const prepared=await buildPackage({files,quota:quota.maxBytes,directory:join(root,'package'),source:{format:'bounded-fixture/1'},records:{total:4,byKind:{document:4}},totals:{},signal:new AbortController().signal});
 const signal=new AbortController().signal;
 const fresh=async(action:string,extra:any={})=>({action,destination:`${d.origin}/api/rer/import/${action}`,authorization:'Bearer '+await d.token(action as any,{...quota,...extra} as Partial<DoorGrant>)});
 const send=async(action:string,input:any,b:WaveBinding=binding,approval:any={})=>d.call(action as any,input,{...quota,bounded:b,...approval});
 const uploaded=await transferPackage({prepared,signal,fresh:(action:string)=>fresh(action,action==='prepare'?{bounded:binding}:{}),request:networkDoor,checkpoint:async()=>{},planAction:'prepare',planInput:{ordinal:0}});
 assert.equal(prepared.segments.length,2,'object spans real transport segments');
 const ordinary=await d.call('plan',{uploadId:uploaded.uploadId},quota);assert.equal(ordinary.body.error,'plan_exceeds_grant_quota');
 expansion=1;const over=await send('prepare',{uploadId:uploaded.uploadId,ordinal:0});assert.equal(over.body.error,'child_exceeds_native_quota');const rejectedParent=db.prepare('SELECT id FROM ik_door_wave_roots').get()!.id;assert.equal((await send('prepare',{parentId:rejectedParent,cancel:true})).body.state,'cancelled');expansion=0;binding.revision='revision-fixed';
 let parentId='';
 for(let ordinal=0;ordinal<4;ordinal++) {const response=await send('prepare',{...(parentId?{parentId}:{uploadId:uploaded.uploadId}),ordinal});assert.equal(response.status,200,JSON.stringify(response.body));parentId=response.body.parentId;if(ordinal===0){const resumed=await sendBoundedWaves({arrangement:{...binding,parentId},uploadId:uploaded.uploadId,signal,request:networkDoor,fresh:(action:string,extra:any)=>fresh(action,{bounded:extra.bounded})});assert.equal(resumed.aggregateSuccess,false);assert.equal(resumed.state,'awaiting_parent_approval');assert.equal(db.prepare('SELECT count(*) n FROM native_records').get()!.n,0);}}
 const sealed=await send('seal-parent',{parentId});assert.equal(sealed.status,200,JSON.stringify(sealed.body));
 assert.equal(db.prepare('SELECT count(*) n FROM native_records').get()!.n,0);
 assert.equal(db.prepare("SELECT head_id FROM ik_door_namespaces WHERE namespace='knowledge'").get()!.head_id,null);
 const fp=sealed.body.fingerprint, children=sealed.body.children, at=new Date().toISOString();
 const pb={...binding,parentFingerprint:fp,parentApprovalRecordId:'parent-approval',parentApprovedAt:at};
 const approval={fingerprint:fp,approvalRecordId:'parent-approval',approvedAt:at};
 const child=(i:number,b:any=pb)=>send('apply-child',{parentId,ordinal:i,reviewedFingerprint:children[i].fingerprint},{...b,childFingerprint:children[i].fingerprint},{fingerprint:children[i].fingerprint,approvalRecordId:`child-${i}`,approvedAt:at});
 assert.equal((await child(0)).status,403,'unapproved parent');
 db.prepare('INSERT INTO native_wave_permissions VALUES(?,1)').run(fp);
 assert.equal((await send('review-parent',{parentId},pb,approval)).status,200);
 assert.equal((await child(0)).status,403,'no child approval at upstream authority');
 for(const c of children)db.prepare('INSERT INTO native_wave_permissions VALUES(?,1)').run(c.fingerprint);
 assert.equal((await child(1)).body.error,'child_dependency_incomplete');
 const foreignChild=await d.call('apply-child',{parentId,ordinal:0,reviewedFingerprint:children[0].fingerprint},{...quota,namespace:'foreign-child',bounded:{...pb,childFingerprint:children[0].fingerprint},fingerprint:children[0].fingerprint,approvalRecordId:'child-0',approvedAt:at});assert.equal(foreignChild.body.error,'parent_not_found');
 assert.throws(()=>db.prepare("UPDATE ik_door_wave_children SET fingerprint=? WHERE parent_id=? AND ordinal=0").run('0'.repeat(64),parentId),/IMPORT_WAVE_MEMBERSHIP_IMMUTABLE/);
 assert.equal(db.prepare('SELECT count(*) n FROM native_records').get()!.n,0);
 const altered=await send('apply-child',{parentId,ordinal:0,reviewedFingerprint:'0'.repeat(64)},{...pb,childFingerprint:children[0].fingerprint},{fingerprint:children[0].fingerprint,approvalRecordId:'child-0',approvedAt:at});assert.equal(altered.body.error,'child_fingerprint_mismatch');
 const first=await child(0);assert.equal(first.status,200,JSON.stringify(first.body));assert.equal(first.body.childSuccess,true);assert.equal(first.body.aggregateSuccess,false);
 const journalCount=db.prepare('SELECT count(*) n FROM ik_provenance').get()!.n;
 assert.equal((await child(0)).body.job.id,first.body.job.id);assert.equal(db.prepare('SELECT count(*) n FROM ik_provenance').get()!.n,journalCount);
 const linked=db.prepare('SELECT p.job_id FROM ik_door_plans p JOIN ik_door_wave_children c ON c.plan_id=p.id WHERE c.parent_id=? AND ordinal=0').get(parentId)!.job_id as string;
 await assert.rejects(applyD1ImportBatches(linked,{...d.runtime.context(),namespace:first.body.job.namespace,storage:{database:d.db,targets}}),/IMPORT_ATOMIC_GUARD/);
 const originals=await readD1ImportOriginals(linked,{...d.runtime.context(),namespace:first.body.job.namespace,storage:{database:d.db,targets}});
 assert.ok(originals.some(o=>o.sha256===sha256(media) && o.original.status==='retained' && Buffer.from(o.original.base64,'base64').equals(media)));
 assert.equal((await send('finalize-parent',{parentId},pb)).body.error,'aggregate_children_missing');
 assert.equal(db.prepare("SELECT head_id FROM ik_door_namespaces WHERE namespace='knowledge'").get()!.head_id,null);
 for(let i=1;i<4;i++)assert.equal((await child(i)).status,200);
 for(const kind of ['native','custody']) {
  const nativeBefore=hash(db.prepare('SELECT * FROM native_records ORDER BY id').all()),chunksBefore=db.prepare('SELECT count(*) n FROM ik_d1_original_chunks').get()!.n;
  const mutation=kind==='native'?"UPDATE native_records SET value_json='{}' WHERE id='3';":`DELETE FROM ik_d1_original_chunks WHERE job_id IN (SELECT p.job_id FROM ik_door_wave_children c JOIN ik_door_plans p ON p.id=c.plan_id WHERE c.parent_id='${parentId}' AND c.ordinal=0);`;
  db.exec(`CREATE TRIGGER fixture_final_${kind} AFTER UPDATE ON ik_door_namespaces WHEN new.head_id='${parentId}' BEGIN ${mutation} END`);
  const refused=await send('finalize-parent',{parentId},pb);assert.equal(refused.status,409,JSON.stringify(refused.body));
  db.exec(`DROP TRIGGER fixture_final_${kind}`);
  assert.equal(db.prepare("SELECT head_id FROM ik_door_namespaces WHERE namespace='knowledge'").get()!.head_id,null);
  assert.equal(hash(db.prepare('SELECT * FROM native_records ORDER BY id').all()),nativeBefore);assert.equal(db.prepare('SELECT count(*) n FROM ik_d1_original_chunks').get()!.n,chunksBefore);
 }
 t.diagnostic('PROBE 3 final head-update triggers that change native values or remove original bytes abort and roll back the entire finalization; no complete head or lost custody');
 const complete=await send('finalize-parent',{parentId},pb);assert.equal(complete.status,200,JSON.stringify(complete.body));assert.equal(complete.body.aggregateSuccess,true);assert.equal(complete.body.counts.native,9);assert.equal(db.prepare('SELECT (SELECT count(*) FROM native_records)+(SELECT count(*) FROM native_blob_chunks)+(SELECT count(*) FROM native_links) n').get()!.n,9);
 const arrangement={...binding,parentId,parentApproval:{fingerprint:fp,id:'parent-approval',at},children:children.map((c:any)=>({ordinal:c.ordinal,fingerprint:c.fingerprint,approval:{id:`child-${c.ordinal}`,at}}))};
 const fromCli=await sendBoundedWaves({arrangement,uploadId:uploaded.uploadId,signal,request:networkDoor,fresh:(action:string,extra:any)=>fresh(action,{bounded:extra.bounded,...(action==='review-parent'?approval:action==='apply-child'?{fingerprint:extra.bounded.childFingerprint,approvalRecordId:`child-${children.findIndex((c:any)=>c.fingerprint===extra.bounded.childFingerprint)}`,approvedAt:at}:{})})});
 assert.equal(fromCli.aggregateSuccess,true);
 t.diagnostic('PROBE 1/2/3/5 mounted ES256 door + SQLite + Business sender: source=4 native=9 above grant=3; 2 segments; exact original/blob bytes; no effects before review; parent/child/dependency refusals; idempotent child; missing final child leaves head=null; destination aggregate receipt consumed');
 const catchBinding={...binding,revision:'revision-catchup'};let catchId='';
 for(let ordinal=0;ordinal<4;ordinal++){const r=await send('prepare',{...(catchId?{parentId:catchId}:{uploadId:uploaded.uploadId,catchup:true}),ordinal},catchBinding,{catchup:'bounded',approvalRecordId:'standing',approvedAt:at});assert.equal(r.status,200,JSON.stringify(r.body));catchId=r.body.parentId;}
 const catchSeal=await send('seal-parent',{parentId:catchId},catchBinding);assert.equal(catchSeal.status,200,JSON.stringify(catchSeal.body));
 const catchFp=catchSeal.body.fingerprint, catchParent={...catchBinding,parentFingerprint:catchFp,parentApprovalRecordId:'catch-parent',parentApprovedAt:at};
 db.prepare('INSERT INTO native_wave_permissions VALUES(?,1)').run(catchFp);
 assert.equal((await send('review-parent',{parentId:catchId},catchParent,{fingerprint:catchFp,approvalRecordId:'catch-parent',approvedAt:at})).status,200);
 const beforeCatchNative=hash(db.prepare('SELECT * FROM native_records ORDER BY id').all()),beforeOwners=hash(db.prepare('SELECT * FROM ik_provenance WHERE reversed=0 ORDER BY id').all());
 for(const c of catchSeal.body.children){db.prepare('INSERT INTO native_wave_permissions VALUES(?,1)').run(c.fingerprint);const r=await send('apply-child',{parentId:catchId,ordinal:c.ordinal,reviewedFingerprint:c.fingerprint},{...catchParent,childFingerprint:c.fingerprint},{fingerprint:c.fingerprint,approvalRecordId:`catch-${c.ordinal}`,approvedAt:at});assert.equal(r.status,200,JSON.stringify(r.body));}
 assert.equal((await send('finalize-parent',{parentId:catchId},catchParent)).body.aggregateSuccess,true);
 assert.equal(hash(db.prepare('SELECT * FROM native_records ORDER BY id').all()),beforeCatchNative);assert.equal(hash(db.prepare('SELECT * FROM ik_provenance WHERE reversed=0 ORDER BY id').all()),beforeOwners);
 assert.equal((await send('reverse-parent',{parentId},pb)).body.error,'parent_superseded');
 for(let i=0;i<5;i++){const r=await send('reverse-parent',{parentId:catchId},catchParent);assert.equal(r.status,200,JSON.stringify(r.body));}
 assert.equal(hash(db.prepare('SELECT * FROM native_records ORDER BY id').all()),beforeCatchNative);assert.equal(db.prepare("SELECT head_id FROM ik_door_namespaces WHERE namespace='knowledge'").get()!.head_id,parentId);
 t.diagnostic('PROBE 3 global zero-change cumulative catch-up preserves all original native revisions/journal owners; later-head reverse is refused; catch-up Undo retains original targets and restores prior complete head');
 // A genuinely smaller COMPLETE snapshot: routine catch-up refuses global
 // absence; an independently reviewed proposal retains the absent native rows.
 rowLimit=3;
 const smaller=await buildPackage({files:files.filter(f=>f.path!=='rows-3.json'),quota:quota.maxBytes,directory:join(root,'smaller'),source:{format:'bounded-fixture/1'},records:{total:3,byKind:{document:3}},totals:{},signal});
 const goneBinding={...binding,revision:'revision-gone-routine'};
 const smallUpload=await transferPackage({prepared:smaller,signal,fresh:(action:string)=>fresh(action,action==='prepare'?{bounded:goneBinding,catchup:'bounded',approvalRecordId:'standing-gone',approvedAt:at}:{}),request:networkDoor,checkpoint:async()=>{},catchup:true,planAction:'prepare',planInput:{ordinal:0}});
 let rejectedGone='';for(let ordinal=0;ordinal<3;ordinal++){const r=await send('prepare',{...(rejectedGone?{parentId:rejectedGone}:{uploadId:smallUpload.uploadId,catchup:true}),ordinal},goneBinding,{catchup:'bounded',approvalRecordId:'standing-gone',approvedAt:at});assert.equal(r.status,200,JSON.stringify(r.body));rejectedGone=r.body.parentId;}
 assert.equal((await send('seal-parent',{parentId:rejectedGone},goneBinding)).body.error,'catchup_requires_proposal:source_records_gone');
 assert.equal((await send('prepare',{parentId:rejectedGone,cancel:true},goneBinding)).body.state,'cancelled');
 const proposalBinding={...binding,revision:'revision-gone-proposal'};let proposalId='';
 for(let ordinal=0;ordinal<3;ordinal++){const r=await send('prepare',{...(proposalId?{parentId:proposalId}:{uploadId:smallUpload.uploadId,catchup:true}),ordinal},proposalBinding);assert.equal(r.status,200,JSON.stringify(r.body));proposalId=r.body.parentId;}
 const proposalSeal=await send('seal-parent',{parentId:proposalId},proposalBinding);assert.equal(proposalSeal.status,200,JSON.stringify(proposalSeal.body));
 const proposalFp=proposalSeal.body.fingerprint,proposalParent={...proposalBinding,parentFingerprint:proposalFp,parentApprovalRecordId:'gone-parent',parentApprovedAt:at};db.prepare('INSERT INTO native_wave_permissions VALUES(?,1)').run(proposalFp);
 assert.equal((await send('review-parent',{parentId:proposalId},proposalParent,{fingerprint:proposalFp,approvalRecordId:'gone-parent',approvedAt:at})).status,200);
 for(const c of proposalSeal.body.children){db.prepare('INSERT INTO native_wave_permissions VALUES(?,1)').run(c.fingerprint);const r=await send('apply-child',{parentId:proposalId,ordinal:c.ordinal,reviewedFingerprint:c.fingerprint},{...proposalParent,childFingerprint:c.fingerprint},{fingerprint:c.fingerprint,approvalRecordId:`gone-${c.ordinal}`,approvedAt:at});assert.equal(r.status,200,JSON.stringify(r.body));if(c.ordinal===0){const status=await send('wave-status',{parentId:proposalId},proposalParent);assert.equal(status.body.aggregateSuccess,false);assert.equal(status.body.goneButRetained,undefined);assert.equal(db.prepare("SELECT head_id FROM ik_door_namespaces WHERE namespace='knowledge'").get()!.head_id,parentId);}}
 const goneReceipt=await send('finalize-parent',{parentId:proposalId},proposalParent);assert.equal(goneReceipt.status,200,JSON.stringify(goneReceipt.body));assert.deepEqual(goneReceipt.body.goneButRetained,[{kind:'document',sourceId:'3'}]);assert.equal(db.prepare('SELECT count(*) n FROM native_records').get()!.n,4);
 for(let i=0;i<4;i++)assert.equal((await send('reverse-parent',{parentId:proposalId},proposalParent)).status,200);
 rowLimit=4;
 t.diagnostic('PROBE 3 complete 4-to-3 source snapshot: routine global gone exclusion refuses; separately reviewed proposal withholds gone/head while partial, then reports gone-but-retained at final reconciliation; no native deletion and reverse restores complete baseline');
 // A native edit is preserved, and strict root reverse refuses before deleting
 // any shared ancestor. Repairing that test edit permits dependent-first undo.
 const original=db.prepare("SELECT value_json FROM native_records WHERE id='3'").get()!.value_json;
 db.prepare("UPDATE native_records SET value_json='{}' WHERE id='3'").run();
 assert.equal((await send('reverse-parent',{parentId},pb)).body.error,'native_edit_conflict');assert.equal(db.prepare('SELECT count(*) n FROM native_records').get()!.n,4);
 db.prepare("UPDATE native_records SET value_json=? WHERE id='3'").run(original);
 for(let i=0;i<5;i++) {const reverse=await send('reverse-parent',{parentId},pb);assert.equal(reverse.status,200,JSON.stringify(reverse.body));}
 assert.equal(db.prepare('SELECT count(*) n FROM native_records').get()!.n,0);assert.equal(db.prepare('SELECT count(*) n FROM native_blob_chunks').get()!.n,0);
 assert.equal(db.prepare("SELECT head_id FROM ik_door_namespaces WHERE namespace='knowledge'").get()!.head_id,null);
 t.diagnostic('PROBE 4 native edit/strict root reverse: known conflict preserves all 4 records; descending dependent-first reversal removes own records/blob chunks and restores previous head only after all children');
 // A grouped child commits one ordinary batch, then a genuine SQLite write
 // failure leaves an honest partial job. Root rollback uses that journal.
 grouped=true;bounded.batchSize=1;const partialBinding={...binding,revision:'revision-partial'};let partialId='';
 for(let ordinal=0;ordinal<3;ordinal++){const r=await send('prepare',{...(partialId?{parentId:partialId}:{uploadId:uploaded.uploadId}),ordinal},partialBinding,{maxRecords:5});assert.equal(r.status,200,JSON.stringify(r.body));partialId=r.body.parentId;}
 const partialSeal=await send('seal-parent',{parentId:partialId},partialBinding);assert.equal(partialSeal.status,200,JSON.stringify(partialSeal.body));
 const partialFp=partialSeal.body.fingerprint,partialParent={...partialBinding,parentFingerprint:partialFp,parentApprovalRecordId:'partial-parent',parentApprovedAt:at};
 db.prepare('INSERT INTO native_wave_permissions VALUES(?,1)').run(partialFp);
 assert.equal((await send('review-parent',{parentId:partialId},partialParent,{fingerprint:partialFp,approvalRecordId:'partial-parent',approvedAt:at})).status,200);
 for(const c of partialSeal.body.children)db.prepare('INSERT INTO native_wave_permissions VALUES(?,1)').run(c.fingerprint);
 const partialChild=(i:number)=>{const c=partialSeal.body.children[i];return send('apply-child',{parentId:partialId,ordinal:i,reviewedFingerprint:c.fingerprint},{...partialParent,childFingerprint:c.fingerprint},{fingerprint:c.fingerprint,approvalRecordId:`partial-${i}`,approvedAt:at,maxRecords:5});};
 assert.equal((await partialChild(0)).body.childSuccess,true);const half=await partialChild(1);assert.equal(half.status,200,JSON.stringify(half.body));assert.equal(half.body.job.checkpoint,1);assert.equal(half.body.childSuccess,false);
 db.exec("CREATE TRIGGER fixture_partial_failure BEFORE INSERT ON native_records WHEN new.id='2' BEGIN SELECT RAISE(ABORT,'fixture write failure'); END");
 assert.equal((await partialChild(1)).status,409);db.exec('DROP TRIGGER fixture_partial_failure');assert.equal((await partialChild(1)).body.error,'import_door_plan_failed');
 db.prepare('UPDATE ik_door_wave_approvals SET revoked=1 WHERE parent_id=? AND ordinal=0').run(partialId);assert.equal((await partialChild(0)).status,409);
 assert.equal(db.prepare("SELECT head_id FROM ik_door_namespaces WHERE namespace='knowledge'").get()!.head_id,null);
 let reversedPartial:any;for(let i=0;i<6;i++){reversedPartial=await send('reverse-parent',{parentId:partialId},partialParent);assert.equal(reversedPartial.status,200,JSON.stringify(reversedPartial.body));if(reversedPartial.body.state==='reversed')break;}assert.equal(reversedPartial.body.progress.skipped,1);assert.equal(reversedPartial.body.progress.pending,0);assert.equal(reversedPartial.body.children[2].skipped,true);const reversedReplay=await send('reverse-parent',{parentId:partialId},partialParent);assert.equal(reversedReplay.status,200);assert.deepEqual(reversedReplay.body,reversedPartial.body);
 assert.equal(reversedPartial.body.state,'reversed');assert.equal(db.prepare('SELECT count(*) n FROM native_records').get()!.n,0);assert.equal(db.prepare('SELECT count(*) n FROM native_blob_chunks').get()!.n,0);
 grouped=false;bounded.batchSize=20;
 t.diagnostic('PROBE 4 grouped child checkpoint=1/2 after genuine SQLite write failure; ordinary rollback removes partial effects, skips unstarted child, reverses shared ancestor last; complete head remains null');
 // Erasure after a complete root and during a dependent catch-up withdraws
 // the aggregate, existing byte custody and the already-started child together.
 const reviewed=async(rev:string,catchup=false,applyCount=4)=>{
  const b={...binding,revision:rev};let id='';
  for(let ordinal=0;ordinal<4;ordinal++){const r=await send('prepare',{...(id?{parentId:id}:{uploadId:uploaded.uploadId,...(catchup?{catchup:true}:{})}),ordinal},b);assert.equal(r.status,200,JSON.stringify(r.body));id=r.body.parentId;}
  const sealed=await send('seal-parent',{parentId:id},b);assert.equal(sealed.status,200,JSON.stringify(sealed.body));const fp=sealed.body.fingerprint,parent={...b,parentFingerprint:fp,parentApprovalRecordId:`parent-${rev}`,parentApprovedAt:at};
  db.prepare('INSERT INTO native_wave_permissions VALUES(?,1)').run(fp);
  assert.equal((await send('review-parent',{parentId:id},parent,{fingerprint:fp,approvalRecordId:`parent-${rev}`,approvedAt:at})).status,200);
  for(const c of sealed.body.children)db.prepare('INSERT INTO native_wave_permissions VALUES(?,1)').run(c.fingerprint);
  const apply=(ordinal:number)=>{const c=sealed.body.children[ordinal];return send('apply-child',{parentId:id,ordinal,reviewedFingerprint:c.fingerprint},{...parent,childFingerprint:c.fingerprint},{fingerprint:c.fingerprint,approvalRecordId:`${rev}-${ordinal}`,approvedAt:at});};
  for(let i=0;i<applyCount;i++){const r=await apply(i);assert.equal(r.status,200,JSON.stringify(r.body));}
  return {id,b,parent,apply};
 };
 const durable=await reviewed('erasure-complete');assert.equal((await send('finalize-parent',{parentId:durable.id},durable.parent)).body.aggregateSuccess,true);
 const pending=await reviewed('erasure-during',true,1);
 d.mount(createImportDoorHandler({...options,destination:'foreign-workspace'}));const foreignId=await d.upload([{id:'foreign',title:'Foreign custody remains'}],{namespace:'foreign-wave'});d.mount(createImportDoorHandler(options));
 const foreign=hash(db.prepare('SELECT * FROM ik_door_chunks WHERE upload_id=?').all(foreignId));
 const erasure=await retireD1ImportCustody({target:{kind:'record',id:'3'}},targets.remove('workspace','record','3'),{...d.runtime.context(),originalErasurePolicy:'withdraw-all-job-artifacts',storage:{database:d.db,targets}},[{sql:'UPDATE native_authority SET enabled=enabled'}]);
 assert.equal(erasure.phase,'complete');assert.ok(erasure.jobsRetired>0);
 for(const r of [durable,pending]){const status=await send('wave-status',{parentId:r.id},r.parent);assert.equal(status.body.state,'withdrawn');assert.equal(status.body.aggregateSuccess,false);assert.equal((await send('finalize-parent',{parentId:r.id},r.parent)).status,410);}
 assert.equal((await pending.apply(1)).status,410);assert.throws(()=>db.prepare("UPDATE ik_door_wave_roots SET state='completed' WHERE id=?").run(durable.id),/IMPORT_WAVE_ERASURE_FENCE/);
 assert.equal(db.prepare('SELECT count(*) n FROM native_records').get()!.n,3,'other people remain');assert.equal(hash(db.prepare('SELECT * FROM ik_door_chunks WHERE upload_id=?').all(foreignId)),foreign);
 assert.equal(db.prepare("SELECT count(*) n FROM ik_d1_original_chunks c JOIN ik_jobs j ON j.id=c.job_id WHERE j.destination='workspace' AND j.namespace LIKE 'door-wave:%'").get()!.n,0,'affected root original/blob custody is retired');
 const replayBinding={...binding,revision:'erasure-corrected'},replayed=await transferPackage({prepared,signal,fresh:(action:string)=>fresh(action,action==='prepare'?{bounded:replayBinding}:{}),request:networkDoor,checkpoint:async()=>{},planAction:'prepare',planInput:{ordinal:0}});
 const replay=await send('prepare',{uploadId:replayed.uploadId,ordinal:0},replayBinding);assert.equal(replay.body.error,'source_erased');assert.equal((await d.call('uploads',{uploadId:replayed.uploadId},quota)).status,404);
 assert.equal(hash(db.prepare('SELECT * FROM ik_door_chunks WHERE upload_id=?').all(foreignId)),foreign);
 t.diagnostic('PROBE 4 erasure after complete/during child: root and reused journals/original/blob custody retired, later child/finalize=410; stale root restore fails erasure trigger; corrected re-upload is refused/cleaned before new effects; 3 peer native records and foreign-destination custody preserved');
 const aliasNamespace='alias-before-preparation';
 const aliasErasure=await retireD1ImportCustody({aliases:[{installationId:d.options.claim.installationId,namespace:aliasNamespace,kind:'context-person',sourceId:'context-only'}]},[],{...d.runtime.context(),storage:{database:d.db,targets}},[{sql:'UPDATE native_authority SET enabled=enabled'}]);assert.equal(aliasErasure.phase,'complete');
 const aliasBinding={...binding,revision:'alias-revision'},aliasFresh=(action:string)=>fresh(action,{namespace:aliasNamespace,...(action==='prepare'?{bounded:aliasBinding}:{})});
 const aliasUpload=await transferPackage({prepared,signal,fresh:aliasFresh,request:networkDoor,checkpoint:async()=>{},planAction:'prepare',planInput:{ordinal:0}});
 const aliasRefused=await d.call('prepare',{uploadId:aliasUpload.uploadId,ordinal:0},{...quota,namespace:aliasNamespace,bounded:aliasBinding});assert.equal(aliasRefused.body.error,'source_erased');
 assert.equal((await d.call('uploads',{uploadId:aliasUpload.uploadId},{...quota,namespace:aliasNamespace})).status,404);
 t.diagnostic('PROBE 1/4 context-only subject indexed separately from 4 primary/9 native units; pre-preparation erasure persists scoped alias digest with no native target; later preparation refuses and removes exact package custody');
 await boundedCliProof(t);
}
