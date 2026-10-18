import test from 'node:test';
import assert from 'node:assert/strict';
import { door, documents } from './door/fixture.ts';
import { createImportDoorHandler, importDoorSchema, readImportDoorHistory, writeImportDoorSettings } from '../src/door/index.ts';
import { readD1ImportOriginals, readD1ErasureJournal, retireD1ImportCustody, undoD1Import } from '../src/d1/index.ts';
import { canonicalJson, sha256 } from '../src/provenance/identity.ts';

test('HTTP import door is absent until the installation opts in',async t=>{
  const d=await door(t);
  for (const action of ['uploads','plan','apply','status','reconcile','undo'] as const) assert.equal((await d.call(action,{})).status,404);
  assert.equal(d.runtime.native().prepare('SELECT COUNT(*) n FROM ik_door_grants').get()!.n,0);
  assert.equal(d.runtime.native().prepare('SELECT COUNT(*) n FROM native_records').get()!.n,0);
  const erased=await retireD1ImportCustody({values:['absent@example.test']},[],d.runtime.context(),[]);
  assert.equal(erased.phase,'complete');
  assert.equal((await readD1ErasureJournal(d.runtime.context()))[0].receiptId,erased.receiptId);
});

test('HTTP door uploads and applied snapshots erase with their destination in the journal batch',async t=>{
  for (const mode of [{bounded:false,legacy:false},{bounded:true,legacy:false},{bounded:false,legacy:true},{bounded:true,legacy:true}]) {
    const {bounded,legacy}=mode;
    const d=await door(t);await d.enable();
    const secret='test-private-record-value',records=[{id:'private',title:secret,body:'Private imported knowledge'}];
    const planned=await d.plan(records);assert.equal(planned.status,200,JSON.stringify(planned.body));
    const job=await d.apply(planned.body);
    const other=createImportDoorHandler({...d.options,destination:'other-workspace'});
    const wrongDestination=await other(new Request(d.options.claim.appOrigin+'/api/rer/import/status',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+await d.token('status')},body:JSON.stringify({planId:planned.body.planId})}));
    assert.equal(wrongDestination!.status,403,'a namespace binding cannot move to another destination');
    const otherCall=async (action:'uploads'|'plan'|'apply',body:unknown,extra:Record<string,string>={})=>{
      const response=await other(new Request(d.options.claim.appOrigin+'/api/rer/import/'+action,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+await d.token(action,{namespace:'other',...extra})},body:JSON.stringify(body)}));
      assert.equal(response!.status,200);return response!.json() as Promise<any>;
    };
    const keptBytes=Buffer.from(JSON.stringify([{id:'kept',title:'Kept knowledge'}]));
    const kept=await otherCall('uploads',{name:'kept.json',bundleSha256:sha256(keptBytes),totalBytes:keptBytes.length,totalChunks:1,index:0,chunkSha256:sha256(keptBytes),base64:keptBytes.toString('base64')});
    const keptPlan=await otherCall('plan',{uploadId:kept.uploadId});
    await otherCall('apply',{planId:keptPlan.planId,reviewedFingerprint:keptPlan.fingerprint},{fingerprint:keptPlan.fingerprint,...d.approval});
    // Unplanned uploads have content too, including in a previously unused namespace.
    await d.upload(records,{namespace:legacy?'knowledge':'unplanned'});
    if (!bounded) await writeImportDoorSettings(d.db,d.options.claim.installationId,{enabled:false},d.ownerPredicate);
    const native=d.runtime.native();
    if (legacy) {
      native.exec('DROP TABLE ik_door_scopes');
      // Creation can commit before the door's job index update. Its immutable
      // operation key is still a real scope link in the legacy schema.
      native.prepare('UPDATE ik_door_plans SET job_id=NULL WHERE id=?').run(planned.body.planId);
    }
    const doorTables=()=>native.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'ik_door_%' ORDER BY name").all().map(r=>r.name as string);
    const contentTables=['ik_door_chunks','ik_door_plan_chunks','ik_door_uploads'];
    const before=new Map(doorTables().map(table=>[table,Number(native.prepare(`SELECT count(*) n FROM ${table}`).get()!.n)]));
    const erase=()=>retireD1ImportCustody({target:{kind:'record',id:'private'}},[{sql:"DELETE FROM native_records WHERE destination='workspace' AND id='private'"}],
      d.runtime.context(),[{sql:'UPDATE native_authority SET enabled=enabled'}],bounded?{operationKey:'door-erasure'}:{});
    native.exec("CREATE TRIGGER refuse_door_erasure BEFORE INSERT ON ik_d1_erasure_journal BEGIN SELECT RAISE(ABORT,'test journal failure'); END");
    await assert.rejects(erase());
    for (const table of contentTables) assert.equal(Number(native.prepare(`SELECT count(*) n FROM ${table}`).get()!.n),before.get(table),'a journal failure rolls back door custody');
    native.exec('DROP TRIGGER refuse_door_erasure');
    let erased;do {erased=await erase();} while(erased.phase==='pending');
    assert.equal(erased.phase,'complete');
    assert.equal((await readD1ErasureJournal(d.runtime.context()))[0].receiptId,erased.receiptId);
    for (const table of contentTables) {
      assert.equal(native.prepare(`SELECT count(*) n FROM ${table}`).get()!.n,1,`${table}: other destination survives`);
    }
    for (const table of doorTables()) {
      const removed=before.get(table)!-Number(native.prepare(`SELECT count(*) n FROM ${table}`).get()!.n);
      if (removed) assert.equal(erased.stores.find(row=>row.store===table)?.rows,removed,`${table} journal count`);
    }
    for (const table of doorTables()) {
      for (const row of native.prepare(`SELECT * FROM ${table}`).all()) {
        for (const value of Object.values(records[0])) {
          assert.ok(!JSON.stringify(row).includes(value),table);
          if (typeof row.base64==='string') assert.ok(!Buffer.from(row.base64,'base64').toString().includes(value),table);
        }
      }
    }
    assert.equal(native.prepare("SELECT count(*) n FROM native_records WHERE id='private'").get()!.n,0);
    assert.equal(native.prepare("SELECT count(*) n FROM native_records WHERE id='kept'").get()!.n,1);
    await assert.rejects(retireD1ImportCustody({target:{kind:'record',id:'private'}},[],d.runtime.context(),[]),/IMPORT_RETIREMENT_CHECKPOINT_REQUIRED/);
    native.exec('CREATE TABLE ik_unknown_unscoped(body TEXT)');
    await assert.rejects(retireD1ImportCustody({target:{kind:'record',id:'private'}},[],d.runtime.context(),[{sql:'UPDATE native_authority SET enabled=enabled'}]),/IMPORT_RETIREMENT_UNSCOPED_STORE:ik_unknown_unscoped/);
    t.diagnostic(JSON.stringify({...mode,jobId:job.id,receiptId:erased.receiptId,stores:erased.stores.filter(row=>row.store.startsWith('ik_door_'))}));
  }
  // The previous Base schema has no ik_door_scopes. An upload no destination
  // ever applied is withdrawn and tallied by any erasure, never refused.
  const d=await door(t);await d.enable();
  await d.upload([{id:'never-planned',title:'test-private-legacy-upload'}],{namespace:'legacy-unplanned'});
  const native=d.runtime.native();native.exec('DROP TABLE ik_door_scopes');
  const erased=await retireD1ImportCustody({target:{kind:'record',id:'never-planned'}},[],{...d.runtime.context(),destination:'other-workspace'},[{sql:'UPDATE native_authority SET enabled=enabled'}]);
  assert.equal(erased.stores.find(row=>row.store==='ik_door_chunks')?.rows,1);
  assert.equal(erased.stores.find(row=>row.store==='ik_door_uploads')?.rows,1);
  assert.equal(native.prepare('SELECT count(*) n FROM ik_door_chunks').get()!.n,0);
  // The additive migration still applies over that schema.
  await d.db.batch(importDoorSchema.map(q=>d.db.prepare(q)));
  assert.equal(native.prepare('SELECT count(*) n FROM ik_door_scopes').get()!.n,0);
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

const checkpoint=[{sql:'UPDATE native_authority SET enabled=enabled'}];
type Native=ReturnType<Awaited<ReturnType<typeof door>>['runtime']['native']>;
const doorCounts=(native:Native)=>Object.fromEntries(native.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'ik_door_%' ORDER BY name").all()
  .map(r=>[r.name as string,Number(native.prepare(`SELECT count(*) n FROM ${r.name}`).get()!.n)]));
// Every door row, with base64 decoded, holds none of these values.
function assertNoResidue(native:Native,values:string[]) {
  for (const table of Object.keys(doorCounts(native))) for (const row of native.prepare(`SELECT * FROM ${table}`).all()) for (const value of values) {
    assert.ok(!JSON.stringify(row).includes(value),`${table}: ${value}`);
    if (typeof row.base64==='string') assert.ok(!Buffer.from(row.base64,'base64').toString().includes(value),`${table} base64: ${value}`);
  }
}
// The journal counts exactly the rows each door table lost.
function assertJournal(erased:{stores:{store:string;rows:number}[]},before:Record<string,number>,after:Record<string,number>) {
  for (const table of Object.keys(before)) assert.equal(erased.stores.find(row=>row.store===table)?.rows ?? 0,before[table]-after[table],`${table} journal count`);
}

test('Erasure withdraws door rows the previous Base wrote without a destination binding, in any destination',async t=>{
  const d=await door(t);await d.enable();
  const native=d.runtime.native(),other={...d.runtime.context(),destination:'other-workspace'};
  // The previous Base door wrote these same rows without ik_door_scopes; a
  // rolled-back previous Worker keeps doing so on the migrated schema.
  const unbind=()=>native.exec('DELETE FROM ik_door_scopes WHERE destination=\'workspace\'');
  const planIn=async (records:unknown[],namespace:string)=>{
    const planned=await d.call('plan',{uploadId:await d.upload(records,{namespace})},{namespace});assert.equal(planned.status,200,JSON.stringify(planned.body));return planned;
  };
  const applied=await planIn([{id:'legacy-applied',title:'legacy-applied-secret'},{id:'legacy-kept',title:'legacy-kept-secret'}],'applied');
  await d.apply(applied.body,{namespace:'applied'});
  const planned=await planIn([{id:'legacy-planned',title:'legacy-planned-secret'}],'planned');
  await d.upload([{id:'legacy-unplanned',title:'legacy-unplanned-secret'}],{namespace:'unplanned'});
  unbind();
  // An unrelated destination's values-only erasure withdraws what no destination applied.
  await assert.rejects(retireD1ImportCustody({values:['nobody@example.test']},[],other,[]),/IMPORT_RETIREMENT_CHECKPOINT_REQUIRED/);
  let before=doorCounts(native);
  const unrelated=await retireD1ImportCustody({values:['nobody@example.test']},[],other,checkpoint);
  assert.equal(unrelated.phase,'complete');assertJournal(unrelated,before,doorCounts(native));
  assertNoResidue(native,['legacy-planned-secret','legacy-unplanned-secret']);
  assert.equal(native.prepare("SELECT count(*) n FROM ik_door_uploads WHERE namespace='applied'").get()!.n,1,'the applied namespace belongs to its destination');
  assert.equal(native.prepare("SELECT count(*) n FROM ik_door_plans WHERE namespace='planned'").get()!.n,1,'the plan record stays');
  assert.equal((await d.call('status',{planId:planned.body.planId},{namespace:'planned'})).body.error,'snapshot_withdrawn');
  // Another destination's bound rows survive the owning destination's erasures.
  const otherHandler=createImportDoorHandler({...d.options,destination:'other-workspace'});
  const otherBytes=Buffer.from(JSON.stringify([{id:'bound',title:'other-bound-value'}]));
  assert.equal((await otherHandler(new Request(d.options.claim.appOrigin+'/api/rer/import/uploads',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+await d.token('uploads',{namespace:'other'})},
    body:JSON.stringify({name:'o.json',bundleSha256:sha256(otherBytes),totalBytes:otherBytes.length,totalChunks:1,index:0,chunkSha256:sha256(otherBytes),base64:otherBytes.toString('base64')})})))!.status,200);
  // The owning destination's target erasure, bounded, with a rolled-back Worker's upload.
  await d.upload([{id:'rollback-1',title:'rollback-secret-1'}],{namespace:'rollback-1'});unbind();
  before=doorCounts(native);
  let owned;do {owned=await retireD1ImportCustody({target:{kind:'record',id:'legacy-applied'}},[{sql:"DELETE FROM native_records WHERE id='legacy-applied'"}],d.runtime.context(),checkpoint,{operationKey:'legacy-door-erasure'});} while(owned.phase==='pending');
  assertJournal(owned,before,doorCounts(native));
  assertNoResidue(native,['legacy-applied-secret','legacy-kept-secret','rollback-secret-1']);
  // The owning destination's values-only erasure.
  await d.upload([{id:'rollback-2',title:'rollback-secret-2'}],{namespace:'rollback-2'});unbind();
  await assert.rejects(retireD1ImportCustody({values:['nobody@example.test']},[],d.runtime.context(),[]),/IMPORT_RETIREMENT_CHECKPOINT_REQUIRED/);
  before=doorCounts(native);
  const values=await retireD1ImportCustody({values:['nobody@example.test']},[],d.runtime.context(),checkpoint);
  assert.equal(values.phase,'complete');assertJournal(values,before,doorCounts(native));
  assertNoResidue(native,['rollback-secret-2']);
  for (const table of ['ik_door_chunks','ik_door_uploads']) assert.equal(native.prepare(`SELECT count(*) n FROM ${table}`).get()!.n,1,`${table}: the other destination's bound upload survives`);
  assert.equal(native.prepare("SELECT count(*) n FROM native_records WHERE id='legacy-kept'").get()!.n,1);
  assert.equal((await readD1ErasureJournal(d.runtime.context())).length,2);
});

test('A values-only erasure that withdraws door content requires and commits the restore checkpoint',async t=>{
  for (const bounded of [false,true]) {
    const d=await door(t);await d.enable();
    const native=d.runtime.native(),options=bounded?{operationKey:'values-only'}:{};
    await d.upload([{id:'values-only',title:'values-only-secret'}]);
    // Another destination's erasure does not touch this bound upload and needs no checkpoint.
    const elsewhere=await retireD1ImportCustody({values:['absent@example.test']},[],{...d.runtime.context(),destination:'other-workspace'},[],options);
    assert.equal(elsewhere.phase,'complete');assert.equal(native.prepare('SELECT count(*) n FROM ik_door_chunks').get()!.n,1);
    await assert.rejects(retireD1ImportCustody({values:['absent@example.test']},[],d.runtime.context(),[],options),/IMPORT_RETIREMENT_CHECKPOINT_REQUIRED/);
    assert.equal(native.prepare('SELECT count(*) n FROM ik_door_chunks').get()!.n,1);
    native.exec("CREATE TRIGGER count_checkpoint AFTER UPDATE ON native_authority BEGIN INSERT INTO ik_door_revoked_keys VALUES('checkpoint','committed'); END");
    const before=doorCounts(native);
    let erased;do {erased=await retireD1ImportCustody({values:['absent@example.test']},[],d.runtime.context(),checkpoint,options);} while(erased.phase==='pending');
    assert.equal(erased.phase,'complete');
    assert.equal(native.prepare("SELECT count(*) n FROM ik_door_revoked_keys WHERE installation_id='checkpoint'").get()!.n,1,'the checkpoint commits in the erasure batch');
    const after=doorCounts(native);after.ik_door_revoked_keys--;
    assertJournal(erased,before,after);assertNoResidue(native,['values-only-secret']);
    assert.equal(after.ik_door_chunks,0);
  }
});

test('Erasing one person keeps the surviving door import history, status and undo',async t=>{
  const d=await door(t);await d.enable();
  const native=d.runtime.native();
  const planned=await d.plan([{id:'erased',title:'history-erased-secret'},{id:'kept',title:'history-kept'}]);assert.equal(planned.status,200);
  const job=await d.apply(planned.body);
  const before=doorCounts(native);
  const erased=await retireD1ImportCustody({target:{kind:'record',id:'erased'}},[{sql:"DELETE FROM native_records WHERE id='erased'"}],d.runtime.context(),checkpoint);
  const after=doorCounts(native);
  assertJournal(erased,before,after);assertNoResidue(native,['history-erased-secret','history-kept']);
  assert.deepEqual(erased.stores.filter(row=>row.store.startsWith('ik_door_')).map(row=>row.store),['ik_door_chunks','ik_door_plan_chunks','ik_door_uploads']);
  for (const table of ['ik_door_plans','ik_door_approvals','ik_door_namespaces','ik_door_scopes']) assert.equal(after[table],before[table],`${table} is bookkeeping`);
  const history=await readImportDoorHistory(d.db,d.options.claim.installationId,d.ownerPredicate);
  assert.equal(history.length,1);assert.equal(history[0].jobId,job.id);assert.match(history[0].caption,/^approved via Business by owner@example\.test/);
  const status=await d.call('status',{planId:planned.body.planId});
  assert.equal(status.status,200,JSON.stringify(status.body));assert.equal(status.body.job.state,'completed');assert.match(status.body.caption,/via Business/);
  // Replaying apply after a lost response answers the completed job, still bound to the reviewed plan and approval.
  const replay=await d.call('apply',{planId:planned.body.planId,reviewedFingerprint:planned.body.fingerprint},{fingerprint:planned.body.fingerprint,...d.approval});
  assert.deepEqual([replay.status,replay.body.job?.id,replay.body.job?.state],[200,job.id,'completed'],JSON.stringify(replay.body));
  const reconcile=await d.call('reconcile',{planId:planned.body.planId});
  assert.equal(reconcile.status,410);assert.equal(reconcile.body.error,'snapshot_withdrawn');
  const catchup=await d.call('plan',{uploadId:await d.upload([{id:'kept',title:'history-kept'},{id:'new',title:'New'}]),catchup:true});
  assert.equal(catchup.status,410);assert.equal(catchup.body.error,'snapshot_withdrawn');
  assert.equal(native.prepare("SELECT count(*) n FROM native_records WHERE id='kept'").get()!.n,1);
  await d.undo(planned.body.planId);
  assert.equal(native.prepare('SELECT count(*) n FROM native_records').get()!.n,0);
  assert.equal((await readImportDoorHistory(d.db,d.options.claim.installationId,d.ownerPredicate))[0].state,'undone');
  // Undo moved the namespace head back, so a new baseline plans there again.
  const again=await d.plan([{id:'kept',title:'history-kept'}]);assert.equal(again.status,200,JSON.stringify(again.body));
});

test('A person erased while a catch-up plan for their import is being saved never comes back',async t=>{
  for (const when of [1,2]) {
    const d=await door(t);await d.enable();
    const native=d.runtime.native(),secret='catchup-erased-secret';
    // Padding makes the snapshot span several chunk batches.
    const base=[{id:'person',title:secret},{id:'kept',title:'catchup-kept'},...Array.from({length:40},(_,i)=>({id:'pad'+i,title:'pad '+i,body:'x'.repeat(7000)}))];
    const baseline=await d.plan(base);assert.equal(baseline.status,200,JSON.stringify(baseline.body));await d.apply(baseline.body);
    const uploadId=await d.upload([...base,{id:'new',title:'catchup-new'}]);
    // The erasure commits as a separate request between the door's own batches, as D1 allows.
    let batches=0,staged=false,fired=false;
    const database=new Proxy(d.db,{get(target,prop) {
      if (prop==='prepare') return (query:string)=>{if (query.startsWith('INSERT INTO ik_door_plan_chunks')) staged=true;return target.prepare(query);};
      if (prop==='batch') return async (statements:Parameters<typeof target.batch>[0])=>{
        if (staged && ++batches===when && !fired) {
          fired=true;
          let erased;do {erased=await retireD1ImportCustody({target:{kind:'record',id:'person'}},[{sql:"DELETE FROM native_records WHERE id='person'"}],d.runtime.context(),checkpoint);} while(erased.phase==='pending');
        }
        staged=false;return target.batch(statements);
      };
      const value=Reflect.get(target,prop);return typeof value==='function'?value.bind(target):value;
    }});
    const handler=createImportDoorHandler({...d.options,database});
    const response=await handler(new Request(d.options.claim.appOrigin+'/api/rer/import/plan',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+await d.token('plan')},body:JSON.stringify({uploadId,catchup:true})}));
    const body=await response!.json() as any;
    assert.ok(fired);assert.equal((await readD1ErasureJournal(d.runtime.context())).length,1);
    assert.equal(response!.status,410,JSON.stringify(body));assert.equal(body.error,'snapshot_withdrawn');
    for (const {name} of native.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
      for (const row of native.prepare(`SELECT * FROM "${name}"`).all()) assert.ok(!JSON.stringify(row).includes(secret),`${name} holds the erased value`);
    }
    // The interrupted staging cancels, and the surviving import keeps its status.
    assert.equal((await d.call('undo',{planId:body.details.planId})).body.state,'cancelled');
    assert.equal((await d.call('status',{planId:baseline.body.planId})).body.job.state,'completed');
  }
});

// Every row of every table, with base64 text and bytes decoded, holds none of these values.
function assertNowhere(native:Native,values:string[]) {
  for (const {name} of native.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) for (const row of native.prepare(`SELECT * FROM "${name}"`).all()) for (const [column,cell] of Object.entries(row)) {
    const texts=[String(cell)];
    if (typeof cell==='string' && /^[A-Za-z0-9+/=]{8,}$/.test(cell)) texts.push(Buffer.from(cell,'base64').toString('latin1'));
    if (cell instanceof Uint8Array) texts.push(Buffer.from(cell).toString('latin1'));
    for (const value of values) assert.ok(!texts.some(text=>text.includes(value)),`${name}.${column} holds ${value}`);
  }
}

test('Erasing a person unchanged in a door catch-up leaves no copy in the catch-up job, which keeps its status and undo',async t=>{
  for (const variant of ['target','seed-shaped','after-undo','bounded'] as const) {
    const d=await door(t);await d.enable();
    const native=d.runtime.native(),secret='catchup-unchanged-'+variant;
    const base=[{id:'person',title:secret},{id:'kept',title:'catchup-kept'}];
    const baseline=await d.plan(base);assert.equal(baseline.status,200,JSON.stringify(baseline.body));await d.apply(baseline.body);
    const catchup=await d.plan([...base,{id:'new',title:'catchup-new'}],{catchup:true});assert.equal(catchup.status,200,JSON.stringify(catchup.body));
    assert.deepEqual(catchup.body.summary,{sourceRecords:3,created:1,updated:0,unchanged:2,gone:0});
    const job=await d.apply(catchup.body);
    if (variant==='after-undo') await d.undo(catchup.body.planId);
    const remove=[{sql:"DELETE FROM native_records WHERE id='person'"}];
    let erased;
    if (variant==='seed-shaped') {
      // The default seed's own call: target, the email as a value, optional reference fields, resumable redaction.
      const person={target:{kind:'record',id:'person'},values:['person@example.test'],related:{fields:[{path:['details','reactions','*','users','*'],value:'person',optional:true}]}};
      let continuation:string|undefined;
      do {erased=await retireD1ImportCustody(person,remove,d.runtime.context(),checkpoint,{resumable:true,continuation});continuation=erased.continuation;} while(erased.phase==='redacting');
    } else do {erased=await retireD1ImportCustody({target:{kind:'record',id:'person'}},remove,d.runtime.context(),checkpoint,variant==='bounded'?{operationKey:'catchup-erasure'}:{});} while(erased.phase==='pending');
    assert.equal(erased.phase,'complete',variant);
    assertNowhere(native,[secret]);
    const namespace=native.prepare('SELECT namespace FROM ik_jobs WHERE id=?').get(job.id)!.namespace as string;
    const originals=await readD1ImportOriginals(job.id,{...d.runtime.context(),namespace});
    assert.ok(!originals.some(o=>o.original?.status==='retained' && Buffer.from(o.original.base64,'base64').toString().includes(secret)),`${variant}: the catch-up keeps the erased person's original`);
    const status=await d.call('status',{planId:catchup.body.planId});
    assert.equal(status.status,200,JSON.stringify(status.body));assert.equal(status.body.job.state,variant==='after-undo'?'undone':'completed');
    if (variant!=='after-undo') {
      await d.undo(catchup.body.planId);
      assert.equal(native.prepare("SELECT count(*) n FROM native_records WHERE id='new'").get()!.n,0,'the catch-up undoes');
    }
    assert.equal(native.prepare("SELECT count(*) n FROM native_records WHERE id='kept'").get()!.n,1);
    // Every job stays indexed, so the next person's erasure needs no index upgrade.
    const next=await retireD1ImportCustody({target:{kind:'record',id:'kept'}},[{sql:"DELETE FROM native_records WHERE id='kept'"}],d.runtime.context(),checkpoint);
    assert.equal(next.phase,'complete');assertNowhere(native,['catchup-kept']);
  }
});

test('A door upload in flight across an erasure, or holding an erased person, leaves nothing of them behind',async t=>{
  for (const when of ['continuation','opening','after'] as const) {
    const d=await door(t);await d.enable();
    const native=d.runtime.native(),secret='upload-erased-'+when;
    const baseline=await d.plan([{id:'person',title:secret},{id:'kept',title:'upload-kept'}]);assert.equal(baseline.status,200);await d.apply(baseline.body);
    const erase=async ()=>{let erased;do {erased=await retireD1ImportCustody({target:{kind:'record',id:'person'}},[{sql:"DELETE FROM native_records WHERE id='person'"}],d.runtime.context(),checkpoint);} while(erased.phase==='pending');};
    // A second bundle holding the person, in another namespace; a continuation's record is in its last chunk.
    const records=[...(when==='continuation'?documents(12).map(r=>({...r,body:'x'.repeat(7000)})):[]),{id:'person',title:secret},{id:'other',title:'upload-other'}];
    const bytes=Buffer.from(JSON.stringify(records)),totalChunks=Math.ceil(bytes.length/65_536),bundleSha256=sha256(bytes);
    const chunk=(index:number)=>{const part=bytes.subarray(index*65_536,Math.min((index+1)*65_536,bytes.length));return {name:'again.json',bundleSha256,totalBytes:bytes.length,totalChunks,index,chunkSha256:sha256(part),base64:part.toString('base64')};};
    const fresh={namespace:'fresh'};
    if (when==='after') {
      await erase();
      let uploadId:string|undefined;
      for (let index=0;index<totalChunks;index++) {const r=await d.call('uploads',{...(uploadId?{uploadId}:{}),...chunk(index)},fresh);assert.equal(r.status,200);uploadId=r.body.uploadId;}
      const planned=await d.call('plan',{uploadId},fresh);
      assert.deepEqual([planned.status,planned.body.error],[409,'source_erased'],JSON.stringify(planned.body));
      assert.equal((await d.call('uploads',{uploadId},fresh)).status,404,'the upload holding the erased person goes');
    } else {
      let uploadId:string|undefined;
      if (when==='continuation') {
        assert.equal(totalChunks,2);assert.ok(Buffer.from(chunk(1).base64,'base64').toString().includes(secret));
        const opened=await d.call('uploads',chunk(0),fresh);assert.equal(opened.status,200);uploadId=opened.body.uploadId;
      }
      // The chunk is admitted, then the erasure commits before its batch, as D1 allows.
      let armed=false,fired=false;
      const database=new Proxy(d.db,{get(target,prop) {
        if (prop==='prepare') return (query:string)=>{if (query.startsWith('INSERT OR IGNORE INTO ik_door_chunks')) armed=true;return target.prepare(query);};
        if (prop==='batch') return async (statements:Parameters<typeof target.batch>[0])=>{if (armed && !fired) {fired=true;await erase();} return target.batch(statements);};
        const value=Reflect.get(target,prop);return typeof value==='function'?value.bind(target):value;
      }});
      const handler=createImportDoorHandler({...d.options,database});
      const late=await handler(new Request(d.options.claim.appOrigin+'/api/rer/import/uploads',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+await d.token('uploads',fresh)},
        body:JSON.stringify({...(uploadId?{uploadId}:{}),...chunk(totalChunks-1)})}));
      const body=await late!.json() as any;
      assert.ok(fired);assert.deepEqual([late!.status,body.error],[410,'erased_during_request'],JSON.stringify(body));
      if (uploadId) assert.equal((await d.call('uploads',{uploadId},fresh)).status,404,'the withdrawn upload does not come back');
    }
    assert.equal((await readD1ErasureJournal(d.runtime.context())).length,1);
    assertNowhere(native,[secret]);
    assert.equal(native.prepare("SELECT count(*) n FROM native_records WHERE id='kept'").get()!.n,1);
  }
});

test('The default seed\'s resumable erasure severs a door catch-up that an earlier redaction step read, on a destination with many jobs',async t=>{
  // A redaction step reads 25 jobs; the catch-up job must sort among the first step's jobs, which random job ids give most of the time.
  for (let attempt=0;attempt<12;attempt++) {
    const d=await door(t);await d.enable();
    const native=d.runtime.native(),secret='many-jobs-secret-'+attempt;
    const base=[{id:'person',title:secret},{id:'kept',title:'many-jobs-kept'}];
    const baseline=await d.plan(base);assert.equal(baseline.status,200,JSON.stringify(baseline.body));await d.apply(baseline.body);
    const catchup=await d.plan([...base,{id:'new',title:'many-jobs-new'}],{catchup:true});assert.equal(catchup.status,200,JSON.stringify(catchup.body));
    const job=await d.apply(catchup.body);
    // Other door imports in this destination, as daily catch-ups and other namespaces produce within a month.
    for (let i=0;i<26;i++) {
      const other=await d.call('plan',{uploadId:await d.upload([{id:'other-'+i,title:'other-'+i}],{namespace:'other-'+i})},{namespace:'other-'+i});
      assert.equal(other.status,200,JSON.stringify(other.body));await d.apply(other.body,{namespace:'other-'+i});
    }
    const jobs=native.prepare("SELECT id FROM ik_jobs WHERE destination='workspace' ORDER BY id").all().map(r=>r.id as string);
    assert.equal(jobs.length,28);
    if (jobs.indexOf(job.id)>=25) continue;
    const person={target:{kind:'record',id:'person'},values:['person@example.test'],related:{fields:[{path:['details','reactions','*','users','*'],value:'person',optional:true}]}};
    let erased,continuation:string|undefined,redacting=0;
    do {erased=await retireD1ImportCustody(person,[{sql:"DELETE FROM native_records WHERE id='person'"}],d.runtime.context(),checkpoint,{resumable:true,continuation});continuation=erased.continuation;if (erased.phase==='redacting') redacting++;} while(erased.phase==='redacting');
    assert.equal(erased.phase,'complete');assert.ok(redacting>0,'an earlier step read the catch-up job');
    assertNowhere(native,[secret]);
    const namespace=native.prepare('SELECT namespace FROM ik_jobs WHERE id=?').get(job.id)!.namespace as string;
    assert.ok(!(await readD1ImportOriginals(job.id,{...d.runtime.context(),namespace})).some(o=>o.original?.status==='retained' && Buffer.from(o.original.base64,'base64').toString().includes(secret)));
    const status=await d.call('status',{planId:catchup.body.planId});
    assert.equal(status.status,200,JSON.stringify(status.body));assert.equal(status.body.job.state,'completed');
    return;
  }
  assert.fail('no attempt placed the catch-up job in the first redaction step');
});

test('After an erasure, a plan of an upload holding the erased person deletes it even where the namespace snapshot is withdrawn',async t=>{
  const d=await door(t);await d.enable();
  const native=d.runtime.native(),secret='withdrawn-namespace-secret';
  const base=[{id:'person',title:secret},{id:'kept',title:'withdrawn-kept'}];
  const baseline=await d.plan(base);assert.equal(baseline.status,200,JSON.stringify(baseline.body));await d.apply(baseline.body);
  const erased=await retireD1ImportCustody({target:{kind:'record',id:'person'}},[{sql:"DELETE FROM native_records WHERE id='person'"}],d.runtime.context(),checkpoint);
  assert.equal(erased.phase,'complete');
  // A catch-up, a plain plan, and the baseline's own bundle uploaded again: each holds the person.
  for (const [records,input] of [[[...base,{id:'new',title:'withdrawn-new'}],{catchup:true}],[[...base,{id:'new',title:'withdrawn-new'}],{}],[base,{}]] as const) {
    const uploadId=await d.upload(records as unknown[]);
    const planned=await d.call('plan',{uploadId,...input});
    assert.deepEqual([planned.status,planned.body.error],[409,'source_erased'],JSON.stringify(planned.body));
    assert.equal((await d.call('uploads',{uploadId})).status,404,'the upload holding the erased person goes');
  }
  assertNowhere(native,[secret]);
  // A bundle without the person is refused for the withdrawn snapshot and kept.
  const uploadId=await d.upload([{id:'kept',title:'withdrawn-kept'},{id:'new',title:'withdrawn-new'}]);
  const withdrawn=await d.call('plan',{uploadId,catchup:true});
  assert.deepEqual([withdrawn.status,withdrawn.body.error],[410,'snapshot_withdrawn'],JSON.stringify(withdrawn.body));
  assert.equal((await d.call('uploads',{uploadId})).status,200);
});
