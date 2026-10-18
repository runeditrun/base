import test from 'node:test';
import assert from 'node:assert/strict';
import { door, documents } from './door/fixture.ts';
import { createImportDoorHandler, readImportDoorHistory, writeImportDoorSettings } from '../src/door/index.ts';
import { readD1ImportOriginals, undoD1Import } from '../src/d1/index.ts';
import { canonicalJson, sha256 } from '../src/provenance/identity.ts';
import type { Json } from '../src/types.ts';

test('HTTP import door is absent until the installation opts in',async t=>{
  const d=await door(t);
  for (const action of ['uploads','plan','apply','status','reconcile','undo'] as const) assert.equal((await d.call(action,{})).status,404);
  assert.equal(d.runtime.native().prepare('SELECT COUNT(*) n FROM ik_door_grants').get()!.n,0);
  assert.equal(d.runtime.native().prepare('SELECT COUNT(*) n FROM native_records').get()!.n,0);
  await d.enable();
  delete (d.options.claim.publicKeys as Record<string, JsonWebKey>).test;
  for (const action of ['uploads','plan','apply','status','reconcile','undo'] as const) assert.equal((await d.call(action,{})).status,404);
  assert.equal(d.runtime.native().prepare('SELECT COUNT(*) n FROM ik_door_grants').get()!.n,0);
});

test('HTTP upload, reviewed plan, bounded apply, reconcile and owner-visible undo preserve original custody',async t=>{
  const d=await door(t);await d.enable();
  const badBytes=Buffer.from('[{"id":"bad","title":"Bad bundle"}]'),badUploadId=crypto.randomUUID();
  assert.equal((await d.call('uploads',{uploadId:badUploadId,name:'bad.json',bundleSha256:'0'.repeat(64),totalBytes:badBytes.length,totalChunks:1,index:0,chunkSha256:sha256(badBytes),base64:badBytes.toString('base64')})).status,409);
  const badStatus=await d.call('uploads',{uploadId:badUploadId});
  assert.notEqual(badStatus.body.complete,true);assert.equal(badStatus.status,409);
  assert.equal((await d.call('plan',{uploadId:badUploadId})).status,409);
  assert.equal((await d.call('uploads',{name:'bad.json',bundleSha256:sha256(badBytes),totalBytes:badBytes.length,totalChunks:1,index:0,chunkSha256:'0'.repeat(64),base64:badBytes.toString('base64')})).status,400);
  assert.equal((await d.call('uploads',{name:'bad.json',bundleSha256:sha256(badBytes),totalBytes:badBytes.length,totalChunks:1,index:0,chunkSha256:sha256(badBytes),base64:badBytes.toString('base64')},{maxBytes:1})).status,400);
  const records=[...documents(50,true),{id:'unsupported',title:'Unsupported',reject:true}];
  const planned=await d.plan(records);assert.equal(planned.status,200,JSON.stringify(planned.body));
  assert.equal(planned.body.rejected.length,1);assert.equal(d.runtime.native().prepare('SELECT COUNT(*) n FROM native_records').get()!.n,0);
  const job=await d.apply(planned.body);
  const status=await d.call('status',{planId:planned.body.planId});assert.equal(status.body.job.state,'completed');assert.ok(status.body.caption.includes(planned.body.fingerprint));
  const history=await readImportDoorHistory(d.db,d.options.claim.installationId,d.ownerPredicate);assert.equal(history[0].jobId,job.id);assert.equal(history[0].reviewer,d.approval.approvalRecordId);
  const reconciled=await d.call('reconcile',{planId:planned.body.planId});assert.equal(reconciled.status,200,JSON.stringify(reconciled.body));
  assert.equal(reconciled.body.ok,true);assert.equal(reconciled.body.counts.present,50);assert.equal(reconciled.body.counts.explained,1);assert.equal(reconciled.body.counts.nativeTargets,50);
  const catchupRecords=[...records.map(r=>r.id==='0'?{...r,title:'Updated at source'}:r),{id:'50',title:'New source article'}];
  const bounded={catchup:'bounded' as const,approvalRecordId:'test-standing-approval',approvedAt:d.approval.approvedAt};
  const catchup=await d.plan(catchupRecords,{catchup:true},bounded);assert.equal(catchup.status,200,JSON.stringify(catchup.body));
  assert.equal(catchup.body.summary.updated,1);assert.equal(catchup.body.summary.created,1);assert.equal(catchup.body.summary.unchanged,50);
  assert.equal(catchup.body.rejected.length,0);assert.equal(catchup.body.differences.conflicts.length,0);
  await d.apply(catchup.body,bounded);
  const caughtUp=await d.call('reconcile',{planId:catchup.body.planId});assert.equal(caughtUp.status,200,JSON.stringify(caughtUp.body));
  assert.equal(caughtUp.body.ok,true);assert.equal(caughtUp.body.counts.present,51);assert.equal(caughtUp.body.counts.explained,1);assert.equal(caughtUp.body.counts.nativeTargets,51);
  assert.equal(caughtUp.body.sourceIds.find((r:any)=>r.sourceId==='unsupported').reason,reconciled.body.sourceIds.find((r:any)=>r.sourceId==='unsupported').reason);
  await d.undo(catchup.body.planId);assert.equal(d.runtime.native().prepare('SELECT COUNT(*) n FROM native_records').get()!.n,50);
  await d.undo(planned.body.planId);assert.equal(d.runtime.native().prepare('SELECT COUNT(*) n FROM native_records').get()!.n,0);
  // The ordinary seed owner, with the exact existing actor binding, can inspect
  // originals and repeat undo without any Business grant or special kit bypass.
  const context={...d.runtime.context(),namespace:job.namespace};
  assert.equal((await undoD1Import(job.id,context)).state,'undone');
  const originals=await readD1ImportOriginals(job.id,context);
  assert.equal(originals[0].sha256,sha256(JSON.stringify(records)));assert.equal(originals[0].original.status,'retained');
  const returningRecords=documents(10),returningBase=await d.plan(returningRecords);
  assert.equal(returningBase.status,200,JSON.stringify(returningBase.body));await d.apply(returningBase.body);
  const absent=await d.plan(returningRecords.filter(r=>r.id!=='5'),{catchup:true});
  assert.equal(absent.status,200,JSON.stringify(absent.body));
  assert.deepEqual(absent.body.differences.gone,[canonicalJson(['document','5'])]);
  await d.apply(absent.body);
  const whileAbsent=await d.call('reconcile',{planId:absent.body.planId});
  assert.equal(whileAbsent.status,200,JSON.stringify(whileAbsent.body));
  assert.equal(whileAbsent.body.counts.nativeTargets,10);assert.equal(whileAbsent.body.counts.explained,1);
  assert.equal(whileAbsent.body.sourceIds.find((r:any)=>r.sourceId==='5').status,'explained');
  const returnedRecords=[...returningRecords,{id:'10',title:'New source article'}];
  const returned=await d.plan(returnedRecords,{catchup:true});
  assert.equal(returned.status,200,JSON.stringify(returned.body));
  assert.equal(returned.body.summary.created,1);assert.equal(returned.body.summary.unchanged,10);assert.equal(returned.body.summary.gone,0);
  await d.apply(returned.body);
  const present=await d.call('reconcile',{planId:returned.body.planId});
  assert.equal(present.status,200,JSON.stringify(present.body));assert.equal(present.body.ok,true);
  assert.equal(present.body.counts.present,11);assert.equal(present.body.counts.explained,0);assert.equal(present.body.counts.nativeTargets,11);
  assert.deepEqual(present.body.sourceIds.map((r:any)=>r.sourceId).sort(),returnedRecords.map(r=>r.id).sort());
  assert.ok(present.body.sourceIds.every((r:any)=>r.status==='present'));
  await d.undo(returned.body.planId);await d.undo(absent.body.planId);await d.undo(returningBase.body.planId);
  assert.equal(d.runtime.native().prepare('SELECT COUNT(*) n FROM native_records').get()!.n,0);
});

test('HTTP grants and bounded catch-up fail closed while valid snapshot replacements preserve undo lineage',async t=>{
  const d=await door(t);await d.enable();
  const forged=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
  assert.equal((await d.call('plan',{}, {},await d.token('plan',{},forged.privateKey))).status,403);
  assert.equal((await d.call('plan',{}, {installationId:'another-installation'})).status,403);
  const now=Math.floor(Date.now()/1000);
  assert.equal((await d.call('plan',{}, {iat:now-301,exp:now-1})).status,403);
  const baselineRecords=[...documents(50),{id:'unsupported',title:'Unsupported',reject:true}],baseline=await d.plan(baselineRecords);assert.equal(baseline.status,200);await d.apply(baseline.body);
  const replay=await d.token('status');assert.equal((await d.call('status',{planId:baseline.body.planId},{},replay)).status,200);
  assert.equal((await d.call('status',{planId:baseline.body.planId},{},replay)).status,403);
  const changed=[...baselineRecords.map(r=>r.id==='0'?{...r,title:'Updated at source'}:r),{id:'50',title:'New source article',body:'Historical knowledge.'}];
  const bounded={catchup:'bounded' as const,approvalRecordId:'test-standing-approval',approvedAt:d.approval.approvedAt};
  const planned=await d.plan(changed,{catchup:true},bounded);assert.equal(planned.status,200,JSON.stringify(planned.body));
  assert.equal(planned.body.summary.updated,1);assert.equal(planned.body.summary.created,1);
  assert.equal((await d.call('apply',{planId:planned.body.planId,reviewedFingerprint:planned.body.fingerprint},{fingerprint:'0'.repeat(64),...bounded})).status,403);
  await d.apply(planned.body,bounded);
  const reconciliation=await d.call('reconcile',{planId:planned.body.planId});assert.equal(reconciliation.body.ok,true);assert.equal(reconciliation.body.counts.nativeTargets,51);
  assert.equal((await d.call('undo',{planId:baseline.body.planId})).status,409);
  const tooMany=changed.map((r,i)=>i<3?{...r,title:'Another source change '+i}:r);
  const refused=await d.plan(tooMany,{catchup:true},bounded);assert.equal(refused.status,409);assert.match(refused.body.error,/change_must_be_under_five_percent/);
  const gone=await d.plan(changed.slice(1),{catchup:true},bounded);assert.equal(gone.status,409);assert.match(gone.body.error,/source_records_gone/);
  const rejected=await d.plan([...changed,{id:'new-unsupported',title:'New unsupported row',reject:true}],{catchup:true},bounded);
  assert.equal(rejected.status,409);assert.match(rejected.body.error,/native_or_mapping_conflict/);
  // A same-revision native edit is protected, too.
  const native=d.runtime.native().prepare("SELECT value_json FROM native_records WHERE id='0'").get()!;
  d.runtime.native().prepare("UPDATE native_records SET value_json=? WHERE id='0'").run(canonicalJson({local:'owner edit'}));
  const edited=await d.plan(changed.map(r=>r.id==='0'?{...r,title:'Source wants another update'}:r),{catchup:true},bounded);
  assert.equal(edited.status,409);assert.match(edited.body.error,/native_or_mapping_conflict/);
  assert.equal(JSON.parse(d.runtime.native().prepare("SELECT value_json FROM native_records WHERE id='0'").get()!.value_json as string).local,'owner edit');
  d.runtime.native().prepare("UPDATE native_records SET value_json=? WHERE id='0'").run(native.value_json);
  await d.undo(planned.body.planId);assert.equal(d.runtime.native().prepare('SELECT COUNT(*) n FROM native_records').get()!.n,50);
  await d.undo(baseline.body.planId);assert.equal(d.runtime.native().prepare('SELECT COUNT(*) n FROM native_records').get()!.n,0);
  const uploadId=await d.upload([{id:'guarded',title:'Guarded import'}]);
  d.runtime.native().exec("CREATE TRIGGER interrupt_plan BEFORE INSERT ON ik_door_plan_chunks BEGIN SELECT RAISE(ABORT,'test interruption'); END");
  assert.equal((await d.call('plan',{uploadId})).status,409);
  const interrupted=await d.call('plan',{uploadId});assert.equal(interrupted.status,409);assert.ok(interrupted.body.details.planId);
  assert.equal((await d.call('undo',{planId:interrupted.body.details.planId})).body.state,'cancelled');
  d.runtime.native().exec('DROP TRIGGER interrupt_plan');
  const guarded=await d.call('plan',{uploadId});assert.equal(guarded.status,200);
  d.runtime.native().exec("CREATE TRIGGER interrupt_index BEFORE UPDATE OF job_id ON ik_door_plans BEGIN SELECT RAISE(ABORT,'test interruption'); END");
  const interruptedApply=await d.call('apply',{planId:guarded.body.planId,reviewedFingerprint:guarded.body.fingerprint},{fingerprint:guarded.body.fingerprint,...d.approval});
  assert.equal(interruptedApply.status,409);assert.equal(d.runtime.native().prepare('SELECT COUNT(*) n FROM native_records').get()!.n,0);
  d.runtime.native().exec('DROP TRIGGER interrupt_index');
  const recovered=await d.call('status',{planId:guarded.body.planId});assert.equal(recovered.body.job.state,'queued');
  d.runtime.native().exec("CREATE TRIGGER revoke_door_during_write AFTER INSERT ON native_records BEGIN INSERT INTO ik_door_revoked_keys VALUES('test-installation','test'); END");
  const stopped=await d.call('apply',{planId:guarded.body.planId,reviewedFingerprint:guarded.body.fingerprint},{fingerprint:guarded.body.fingerprint,...d.approval});
  assert.equal(stopped.status,409);assert.equal(d.runtime.native().prepare('SELECT COUNT(*) n FROM native_records').get()!.n,0);
  d.runtime.native().exec('DROP TRIGGER revoke_door_during_write');
  await d.apply(guarded.body);await d.undo(guarded.body.planId);
  await writeImportDoorSettings(d.db,d.options.claim.installationId,{enabled:true,revokedKids:['test']},d.ownerPredicate);
  assert.equal((await d.call('plan',{})).status,403);
});


test('owner-session HTTP pipeline works in a seed with no owner-claim module or grant key ring',async t=>{
  const d=await door(t,'operator');
  for (const action of ['uploads','plan','apply','status','reconcile','undo']) {
    assert.equal((await fetch(d.origin+'/api/rer/import/'+action,{method:'POST'})).status,404);
  }
  const post=(body:unknown,headers:Record<string,string>)=>fetch(d.origin+'/api/operator/import/apply',{
    method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  assert.equal((await post({}, {Origin:d.origin,Authorization:'Bearer test-not-an-owner-session'})).status,401);
  assert.equal((await post({}, {Origin:'https://other.example.test',Cookie:'test-owner-session'})).status,403);
  const planned=await d.plan(documents(25,true));
  assert.equal(planned.status,200,JSON.stringify(planned.body));
  assert.equal(d.runtime.native().prepare('SELECT COUNT(*) n FROM native_records').get()!.n,0);
  assert.equal((await d.call('apply',{planId:planned.body.planId})).status,400);
  assert.equal((await d.call('apply',{planId:planned.body.planId,reviewedFingerprint:'0'.repeat(64)})).status,403);
  d.runtime.native().exec("CREATE TRIGGER revoke_owner_during_write AFTER INSERT ON native_records BEGIN UPDATE native_authority SET enabled=0 WHERE id='owner'; END");
  assert.equal((await d.call('apply',{planId:planned.body.planId,reviewedFingerprint:planned.body.fingerprint})).status,409);
  assert.equal(d.runtime.native().prepare('SELECT COUNT(*) n FROM native_records').get()!.n,0);
  d.runtime.native().exec('DROP TRIGGER revoke_owner_during_write');
  const job=await d.apply(planned.body);
  const status=await d.call('status',{planId:planned.body.planId});
  assert.equal(status.status,200);assert.equal(status.body.job.state,'completed');
  assert.match(status.body.caption,/^approved by /);
  const history=await readImportDoorHistory(d.db,d.options.claim.installationId,d.ownerPredicate);
  assert.equal(history[0].jobId,job.id);assert.notEqual(history[0].reviewer,history[0].approvalRecordId);
  const report=await d.call('reconcile',{planId:planned.body.planId});
  assert.equal(report.status,200,JSON.stringify(report.body));assert.equal(report.body.ok,true);
  assert.equal(report.body.counts.present,25);assert.equal(report.body.counts.nativeTargets,25);
  d.runtime.native().exec("UPDATE native_authority SET enabled=0 WHERE id='owner'");
  assert.equal((await d.call('undo',{planId:planned.body.planId})).status,403);
  d.runtime.native().exec("UPDATE native_authority SET enabled=1 WHERE id='owner'");
  await d.undo(planned.body.planId);
  assert.equal(d.runtime.native().prepare('SELECT COUNT(*) n FROM native_records').get()!.n,0);
  const originals=await readD1ImportOriginals(job.id,{...d.runtime.context(),namespace:job.namespace});
  assert.equal(originals[0].original.status,'retained');
  assert.equal(d.runtime.native().prepare('SELECT COUNT(*) n FROM ik_door_grants').get()!.n,0);
  assert.equal(d.runtime.native().prepare('SELECT enabled FROM ik_door_settings').get()!.enabled,0);
});

test('Business added later under a different RER claim id keeps the door key, owner history and catch-up lineage',async t=>{
  const d=await door(t,'operator'),key=d.options.claim.installationId,count=()=>d.runtime.native().prepare('SELECT COUNT(*) n FROM native_records').get()!.n;
  const kept=await d.plan(documents(5));assert.equal(kept.status,200,JSON.stringify(kept.body));await d.apply(kept.body);
  // RER supplies its own claim installation id later; the grant mount keeps the operator's door key.
  d.addGrants('rer-assigned');
  await writeImportDoorSettings(d.db,key,{enabled:true},d.ownerPredicate);
  assert.equal((await d.call('plan',{},{installationId:key})).status,403,'grants are still verified against the claim id');
  const history=await readImportDoorHistory(d.db,key,d.ownerPredicate);
  assert.equal(history.length,1);assert.equal(history[0].planId,kept.body.planId);assert.match(history[0].caption,/^approved by /);
  assert.equal((await readImportDoorHistory(d.db,'rer-assigned',d.ownerPredicate)).length,0);
  const records=documents(6),uploadId=await d.upload(records);
  const plain=await d.call('plan',{uploadId});assert.equal(plain.status,409);assert.equal(plain.body.error,'catchup_required');
  const catchup=await d.call('plan',{uploadId,catchup:true});assert.equal(catchup.status,200,JSON.stringify(catchup.body));
  assert.equal(catchup.body.summary.created,1);assert.equal(catchup.body.summary.unchanged,5);assert.equal(catchup.body.summary.updated,0);
  await d.apply(catchup.body);assert.equal(count(),6);
  const both=await readImportDoorHistory(d.db,key,d.ownerPredicate);
  assert.deepEqual(both.map(h=>[h.planId,h.caption.split(' by ')[0]]).sort(),[[kept.body.planId,'approved'],[catchup.body.planId,'approved via Business']].sort());
  assert.equal(d.runtime.native().prepare("SELECT COUNT(*) n FROM ik_door_grants WHERE installation_id<>?").get(key)!.n,0);
  assert.equal(d.runtime.native().prepare("SELECT COUNT(*) n FROM ik_door_namespaces").get()!.n,1);
  // The owner's own mount still undoes the newest snapshot, then the original.
  d.state.via='operator';
  await d.undo(catchup.body.planId);assert.equal(count(),5);await d.undo(kept.body.planId);assert.equal(count(),0);
});

test('one owner-session mount serves several import sources chosen per request from a server-side allow-list',async t=>{
  const d=await door(t,'operator'),count=(table:string)=>d.runtime.native().prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n;
  // ADOPTING.md steps 3 and 4: one server-owned allow-list picks namespace, parser and mapping for both mounts.
  const sources:Record<string,{parse(value:Json):{kind:string;sourceId:string;payload:Json}}>={
    wiki:{parse:value=>({kind:'document',sourceId:(value as {id:string}).id,payload:value})},
    tickets:{parse:value=>({kind:'ticket',sourceId:'t'+(value as {id:string}).id,payload:value})},
  };
  const importSource=(name:string)=>Object.hasOwn(sources,name)?{...sources[name],mapping:d.options.mapping}:null;
  const importDoor=async (request:Request)=>{
    const path=new URL(request.url).pathname;
    if (path.startsWith('/api/rer/import/')) return Response.json({error:'not_found'},{status:404});
    if (!path.startsWith('/api/operator/import/')) return null;
    const name=request.headers.get('X-Import-Source') ?? '',source=importSource(name);
    if (!source) return Response.json({error:'unknown_import_source'},{status:400});
    return d.operator({...source,namespace:name})(request);
  };
  d.mount(importDoor);
  // Until a grant mount with a key ring runs first, the door's grant routes answer 404, not the seed router.
  for (const action of ['uploads','plan','apply','status','reconcile','undo']) {
    const response=await fetch(d.origin+'/api/rer/import/'+action,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+await d.token(action as 'plan',{namespace:'wiki'})},body:'{}'});
    assert.equal(response.status,404);assert.deepEqual(await response.json(),{error:'not_found'});
  }
  for (const headers of [{},{'X-Import-Source':'other'},{'X-Import-Source':'__proto__'}] as Record<string,string>[]) {
    d.state.headers=headers;
    assert.equal((await d.call('uploads',{name:'x.json'})).status,400);assert.equal((await d.call('plan',{uploadId:'x'})).body.error,'unknown_import_source');
  }
  assert.equal(count('ik_door_uploads'),0);
  d.state.headers={'X-Import-Source':'wiki'};
  const wiki=await d.plan(documents(5));assert.equal(wiki.status,200,JSON.stringify(wiki.body));await d.apply(wiki.body);
  d.state.headers={'X-Import-Source':'tickets'};
  assert.equal((await d.call('status',{planId:wiki.body.planId})).status,404,'a plan is reachable only through its own source');
  assert.equal((await d.call('undo',{planId:wiki.body.planId})).status,404);
  const ticketUpload=await d.upload(documents(3));
  const tickets=await d.call('plan',{uploadId:ticketUpload});assert.equal(tickets.status,200,'a first import per source needs no catch-up');
  assert.equal(tickets.body.summary.created,3);await d.apply(tickets.body);
  assert.deepEqual(d.runtime.native().prepare("SELECT id FROM native_records ORDER BY id").all().map(r=>r.id),['0','1','2','3','4','t0','t1','t2']);
  d.state.headers={'X-Import-Source':'wiki'};
  assert.equal((await d.call('plan',{uploadId:ticketUpload})).status,404,'an upload is planned only in its own source');
  assert.deepEqual(d.runtime.native().prepare('SELECT namespace FROM ik_door_namespaces ORDER BY namespace').all().map(r=>r.namespace),['tickets','wiki']);
  const history=await readImportDoorHistory(d.db,d.options.claim.installationId,d.ownerPredicate);
  assert.deepEqual(history.map(h=>h.namespace).sort(),['tickets','wiki']);
  // Business arrives: the grant mount runs first and resolves each verified grant's namespace through the same allow-list.
  const {parse:_parse,mapping:_mapping,...mount}=d.options;
  d.mount(createImportDoorHandler({...mount,installationId:d.options.claim.installationId,source:importSource}),importDoor);
  await d.enable();d.state.via='grant';d.state.headers={};
  const rows=()=>['ik_door_grants','ik_door_uploads','ik_door_chunks','ik_door_plans','ik_door_namespaces','ik_jobs','native_records'].map(count);
  const before=rows();
  for (const namespace of ['other','knowledge','__proto__','toString','Tickets']) {
    const refused=await d.call('uploads',{name:'x.json'},{namespace});
    assert.equal(refused.status,403,namespace);assert.equal(refused.body.error,'unknown_import_source');
    assert.equal((await d.call('plan',{uploadId:ticketUpload},{namespace})).body.error,'unknown_import_source');
    assert.equal((await d.call('status',{planId:tickets.body.planId},{namespace})).status,403);
  }
  assert.deepEqual(rows(),before,'an unlisted namespace writes no grant, upload, plan, lineage, job or native row');
  // A tickets grant is parsed with the tickets parser: it catches up on the owner's tickets lineage.
  const ticketsGrant=await d.upload(documents(4),{namespace:'tickets'});
  assert.equal((await d.call('plan',{uploadId:ticketsGrant},{namespace:'tickets'})).body.error,'catchup_required');
  const businessTickets=await d.call('plan',{uploadId:ticketsGrant,catchup:true},{namespace:'tickets'});
  assert.equal(businessTickets.status,200,JSON.stringify(businessTickets.body));
  assert.deepEqual(businessTickets.body.summary,{sourceRecords:4,created:1,updated:0,unchanged:3,gone:0});
  assert.deepEqual(businessTickets.body.differences.additions,[canonicalJson(['ticket','t3'])]);
  await d.apply(businessTickets.body,{namespace:'tickets'});
  const wikiGrant=await d.upload(documents(6),{namespace:'wiki'});
  const businessWiki=await d.call('plan',{uploadId:wikiGrant,catchup:true},{namespace:'wiki'});
  assert.deepEqual(businessWiki.body.summary,{sourceRecords:6,created:1,updated:0,unchanged:5,gone:0});
  await d.apply(businessWiki.body,{namespace:'wiki'});
  assert.deepEqual(d.runtime.native().prepare("SELECT id FROM native_records ORDER BY id").all().map(r=>r.id),['0','1','2','3','4','5','t0','t1','t2','t3']);
  assert.deepEqual(d.runtime.native().prepare('SELECT DISTINCT namespace FROM ik_door_grants ORDER BY namespace').all().map(r=>r.namespace),['tickets','wiki']);
  // Each owner mount adopts only the plan its own source parsed.
  d.state.via='operator';d.state.headers={'X-Import-Source':'tickets'};
  const adopted=await d.call('status',{planId:businessTickets.body.planId});
  assert.equal(adopted.body.job.state,'completed');assert.match(adopted.body.caption,/^approved via Business by /);
  assert.equal((await d.call('status',{planId:businessWiki.body.planId})).status,404);
  d.state.headers={'X-Import-Source':'wiki'};
  assert.equal((await d.call('status',{planId:businessTickets.body.planId})).status,404);
  await d.undo(businessWiki.body.planId);await d.undo(wiki.body.planId);assert.equal(count('native_records'),4);
  d.state.headers={'X-Import-Source':'tickets'};await d.undo(businessTickets.body.planId);await d.undo(tickets.body.planId);assert.equal(count('native_records'),0);
});
