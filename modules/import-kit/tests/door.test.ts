import test from 'node:test';
import assert from 'node:assert/strict';
import { door, documents } from './door/fixture.ts';
import { importDoorApplyFailureMigration, importDoorSchema, readImportDoorHistory, writeImportDoorSettings } from '../src/door/index.ts';
import { readD1ImportOriginals, undoD1Import } from '../src/d1/index.ts';
import { canonicalJson, sha256 } from '../src/provenance/identity.ts';
import { sqliteTargets } from './d1/sqlite-runtime.ts';

test('HTTP import door is absent until the installation opts in',async t=>{
  const d=await door(t);
  for (const action of ['uploads','plan','apply','status','reconcile','undo'] as const) assert.equal((await d.call(action,{})).status,404);
  assert.equal(d.runtime.native().prepare('SELECT COUNT(*) n FROM ik_door_grants').get()!.n,0);
  assert.equal(d.runtime.native().prepare('SELECT COUNT(*) n FROM native_records').get()!.n,0);
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
  const failed=await d.call('status',{planId:guarded.body.planId});assert.equal(failed.body.job.state,'failed');
  assert.equal((await d.call('apply',{planId:guarded.body.planId,reviewedFingerprint:guarded.body.fingerprint},{fingerprint:guarded.body.fingerprint,...d.approval})).status,409);
  const replacement=await d.call('plan',{uploadId});assert.equal(replacement.status,200);assert.notEqual(replacement.body.planId,guarded.body.planId);
  await d.apply(replacement.body,{approvalRecordId:'test-replacement-approval'});await d.undo(replacement.body.planId);
  await writeImportDoorSettings(d.db,d.options.claim.installationId,{enabled:true,revokedKids:['test']},d.ownerPredicate);
  assert.equal((await d.call('plan',{})).status,403);
});

test('HTTP failed target writes keep approval evidence, roll back the batch and require a fresh plan and approval',async t=>{
  const d1=(message:string)=>new Error('D1_ERROR: '+message);
  // null is a real insert-only constraint failure; the rest are provider errors.
  const failures:[Error|null,string][]=[
    [null,'import_door_apply_constraint'],
    [new Error('test provider error',{cause:Object.assign(new Error('database is locked'),{code:'SQLITE_BUSY'})}),'import_door_apply_transient'],
    [Object.assign(new Error('database table is locked'),{code:'SQLITE_LOCKED'}),'import_door_apply_transient'],
    [d1('Network connection lost.'),'import_door_apply_transient'],
    [d1('D1 DB reset because its code was updated.'),'import_door_apply_transient'],
    [d1('Internal error in D1 DB storage caused object to be reset.'),'import_door_apply_transient'],
    [d1('Cannot resolve D1 DB due to transient issue on remote node.'),'import_door_apply_transient'],
    [d1('D1 DB is overloaded. Requests queued for too long.'),'import_door_apply_transient'],
    [d1('D1 DB is overloaded. Too many requests queued.'),'import_door_apply_transient'],
    [d1('D1 DB storage operation exceeded timeout which caused object to be reset.'),'import_door_apply_transient'],
    [d1('UNIQUE constraint failed: native_records.id: SQLITE_CONSTRAINT'),'import_door_apply_constraint'],
    [d1('no such column: legacy_title: SQLITE_ERROR'),'import_door_apply_failed'],
  ];
  for (const [providerError,reason] of failures) {
    const d=await door(t);await d.enable();
    const records=documents(2),baseline=await d.plan(records);assert.equal(baseline.status,200);await d.apply(baseline.body);
    // Exercise the upgrade with populated plans, chunks, approvals and enabled
    // foreign keys. The original schema's bundle uniqueness must be removed.
    d.runtime.native().exec('DROP TABLE ik_door_apply_failures; CREATE UNIQUE INDEX legacy_bundle ON ik_door_plans(installation_id,namespace,bundle_sha256)');
    // An outdated schema fails loudly: the door refuses every route, and
    // re-applying importDoorSchema instead of the migration is refused whole.
    assert.deepEqual(await d.call('status',{planId:baseline.body.planId}),{status:503,body:{error:'import_door_schema_outdated'}});
    await assert.rejects(d.db.batch(importDoorSchema.map(q=>d.db.prepare(q))),/IMPORT_ATOMIC_GUARD/);
    assert.equal(d.runtime.native().prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='ik_door_apply_failures'").get()!.n,0);
    await d.db.batch(importDoorApplyFailureMigration.map(q=>d.db.prepare(q)));
    await d.db.batch(importDoorSchema.map(q=>d.db.prepare(q)));
    assert.deepEqual(d.runtime.native().prepare('PRAGMA foreign_key_check').all(),[]);
    assert.equal((await d.call('status',{planId:baseline.body.planId})).body.job.state,'completed');
    const before=d.runtime.native().prepare('SELECT * FROM native_records ORDER BY id').all();
    const changed=[{id:'2',title:'New article'},...records.map(r=>r.id==='0'?{...r,title:'Updated source article'}:r)];
    const planned=await d.plan(changed,{catchup:true});assert.equal(planned.status,200,JSON.stringify(planned.body));
    let writes=0;
    d.options.targets={...sqliteTargets,write(row) {
      writes++;
      if(row.targetId!=='0') return sqliteTargets.write(row);
      if(providerError) throw providerError;
      // An insert-only adopter cannot replace this existing native id. SQLite
      // must roll back the addition earlier in the same real apply batch too.
      return [{sql:'INSERT INTO native_records VALUES(?,?,?,?,?)',params:[row.destination,row.targetKind,row.targetId,row.revision,canonicalJson(row.value)]}];
    }};
    const input={planId:planned.body.planId,reviewedFingerprint:planned.body.fingerprint};
    const grant={fingerprint:planned.body.fingerprint,...d.approval},signed=await d.token('apply',grant);
    const failed=await d.call('apply',input,{},signed);
    assert.equal(failed.status,reason==='import_door_apply_transient'?503:409,JSON.stringify(failed.body));assert.equal(failed.body.error,reason);
    assert.deepEqual(d.runtime.native().prepare('SELECT * FROM native_records ORDER BY id').all(),before);
    const status=await d.call('status',{planId:planned.body.planId});assert.equal(status.status,200);
    assert.equal(status.body.job.state,'failed');assert.equal(status.body.job.error,reason);assert.equal(status.body.job.checkpoint,0);
    assert.equal(status.body.failureCode,reason);assert.equal(status.body.approval.approval_id,d.approval.approvalRecordId);
    assert.equal(d.runtime.native().prepare('SELECT COUNT(*) n FROM ik_provenance WHERE job_id=?').get(status.body.job.id)!.n,0);
    assert.equal(d.runtime.native().prepare('SELECT COUNT(*) n FROM ik_batches WHERE job_id=?').get(status.body.job.id)!.n,0);
    const history=await readImportDoorHistory(d.db,d.options.claim.installationId,d.ownerPredicate),entry=history.find(r=>r.planId===planned.body.planId)!;
    assert.equal(entry.state,'failed');assert.equal(entry.error,reason);assert.equal(entry.failureCode,reason);
    assert.equal(entry.approvalRecordId,d.approval.approvalRecordId);assert.equal(entry.reviewer,d.approval.approvalRecordId);
    assert.equal((await d.call('apply',input,{},signed)).status,403);
    const writesAtFailure=writes;
    assert.equal((await d.call('apply',input,grant)).body.error,'import_door_plan_failed');
    assert.equal((await d.call('apply',input,{...grant,approvalRecordId:'test-new-approval-for-old-plan'})).body.error,'import_door_plan_failed');
    assert.equal(writes,writesAtFailure);
    // Retry the exact same bytes in the same logical namespace. Both the plan
    // and its reviewed fingerprint are new; the old approval cannot apply it.
    d.options.targets=sqliteTargets;
    const retry=await d.plan(changed,{catchup:true});assert.equal(retry.status,200,JSON.stringify(retry.body));
    assert.notEqual(retry.body.planId,planned.body.planId);assert.notEqual(retry.body.fingerprint,planned.body.fingerprint);
    const retryInput={planId:retry.body.planId,reviewedFingerprint:retry.body.fingerprint};
    const oldApproval=await d.call('apply',retryInput,{fingerprint:retry.body.fingerprint,...d.approval});
    assert.equal(oldApproval.status,409);assert.equal(oldApproval.body.error,'failed_approval_requires_new_approval');
    assert.equal((await d.call('apply',retryInput,{fingerprint:retry.body.fingerprint})).status,403);
    assert.deepEqual(d.runtime.native().prepare('SELECT * FROM native_records ORDER BY id').all(),before);
    await d.apply(retry.body,{approvalRecordId:'test-retry-owner-approval'});
    const reconciled=await d.call('reconcile',{planId:retry.body.planId});assert.equal(reconciled.body.ok,true);assert.equal(reconciled.body.counts.nativeTargets,3);
    assert.equal((await d.call('status',{planId:planned.body.planId})).body.job.state,'failed');
    assert.equal((await d.call('apply',input,grant)).body.error,'import_door_plan_failed');
    await d.undo(retry.body.planId);await d.undo(baseline.body.planId);
    assert.equal(d.runtime.native().prepare('SELECT COUNT(*) n FROM native_records').get()!.n,0);
  }
  // A later failed batch preserves earlier progress until the owner rolls it
  // back. That rollback must retain the failure audit and terminal plan fence.
  const d=await door(t);await d.enable();
  const records=documents(30),planned=await d.plan(records);assert.equal(planned.status,200);
  const input={planId:planned.body.planId,reviewedFingerprint:planned.body.fingerprint},grant={fingerprint:planned.body.fingerprint,...d.approval};
  const first=await d.call('apply',input,grant);assert.equal(first.status,200);assert.equal(first.body.job.state,'applying');
  const checkpoint=first.body.job.checkpoint;assert.ok(checkpoint>0 && checkpoint<records.length);
  d.options.targets={...sqliteTargets,write(){throw new Error('test unsupported native write');}};
  const failed=await d.call('apply',input,grant);assert.equal(failed.status,409);assert.equal(failed.body.error,'import_door_apply_failed');
  const status=await d.call('status',{planId:planned.body.planId});assert.equal(status.body.job.state,'failed');assert.equal(status.body.job.checkpoint,checkpoint);
  assert.equal(d.runtime.native().prepare('SELECT COUNT(*) n FROM native_records').get()!.n,checkpoint);
  assert.equal((await d.plan(records)).status,409);
  d.options.targets=sqliteTargets;
  await d.undo(planned.body.planId);assert.equal(d.runtime.native().prepare('SELECT COUNT(*) n FROM native_records').get()!.n,0);
  const rolledBack=await d.call('status',{planId:planned.body.planId});assert.equal(rolledBack.body.job.state,'rolled_back');assert.equal(rolledBack.body.failureCode,'import_door_apply_failed');
  const history=await readImportDoorHistory(d.db,d.options.claim.installationId,d.ownerPredicate);
  assert.equal(history[0].failureCode,'import_door_apply_failed');assert.equal(history[0].approvalRecordId,d.approval.approvalRecordId);
  assert.equal((await d.call('apply',input,grant)).body.error,'import_door_plan_failed');
  const retry=await d.plan(records);assert.equal(retry.status,200);assert.notEqual(retry.body.planId,planned.body.planId);
  await d.apply(retry.body,{approvalRecordId:'test-retry-after-rollback'});await d.undo(retry.body.planId);
  assert.equal(d.runtime.native().prepare('SELECT COUNT(*) n FROM native_records').get()!.n,0);
});
