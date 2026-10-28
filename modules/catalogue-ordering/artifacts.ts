import type { Context, Database, ExportArtifact, ExportRecord, Options, PartyRef, Result, Snapshot } from './types.ts';
import { snapshotStatements } from './commit.ts';
import { grant, project } from './selection.ts';
import { allowed, batch } from './store.ts';
import { bounded, canonical, fingerprint, integer, LIMITS, object, party, Refusal, refuse, text } from './validation.ts';

export async function read(options: Options,ctx: Context,input:{id:string}):Promise<Snapshot> {
  object(input,['id']);text(input.id);
  const row=await options.db.prepare('SELECT subject_kind,subject_id,body FROM co_snapshots WHERE installation=? AND id=? AND published=1').bind(ctx.installation,input.id).first<{subject_kind:string;subject_id:string;body:string}>();
  if(!row) refuse('not_found');
  const access=await grant(options,ctx,'snapshot',{kind:row.subject_kind,id:row.subject_id});
  return project(JSON.parse(row.body) as Snapshot,access.fields);
}
export async function exportRecords(options: Options,ctx: Context,input:{subject:PartyRef;after:string|null;limit:number}) {
  object(input,['subject','after','limit']); party(input.subject); integer(input.limit,1,LIMITS.page);if(input.after!==null)text(input.after);
  const access=await grant(options,ctx,'export',input.subject);
  const db=options.db;
  // All exported rows and the current permission predicate share a read batch.
  const pageSql='SELECT id FROM co_snapshots WHERE installation=? AND subject_kind=? AND subject_id=? AND published=1 AND id>? ORDER BY id LIMIT ?';
  const pageBindings=[ctx.installation,input.subject.kind,input.subject.id,input.after??'',input.limit];
  const results=await db.batch([
    db.prepare('SELECT id,body FROM co_snapshots WHERE installation=? AND subject_kind=? AND subject_id=? AND published=1 AND id>? ORDER BY id LIMIT ?').bind(ctx.installation,input.subject.kind,input.subject.id,input.after??'',input.limit+1),
    db.prepare(`SELECT snapshot_id,operation,key,actor,digest,outcome FROM co_receipts WHERE installation=? AND snapshot_id IN (${pageSql}) ORDER BY snapshot_id,operation,key`).bind(ctx.installation,...pageBindings),
    db.prepare(`SELECT * FROM co_events WHERE installation=? AND snapshot_id IN (${pageSql}) ORDER BY id`).bind(ctx.installation,...pageBindings),
    db.prepare(`SELECT * FROM co_source_map WHERE installation=? AND snapshot_id IN (${pageSql}) ORDER BY source,kind,legacy_id,revision`).bind(ctx.installation,...pageBindings),
    db.prepare(`SELECT CASE WHEN (${access.guard.sql}) THEN 1 ELSE 0 END AS ok`).bind(...access.guard.bindings)
  ]) as {results:Record<string,unknown>[]}[];
  if(!results[4]?.results[0]?.ok)refuse('authority_refused');
  const rows=results[0]!.results, more=rows.length>input.limit;
  const records:ExportRecord[]=rows.slice(0,input.limit).map(row=>({snapshot:project(JSON.parse(row.body as string) as Snapshot,access.fields),
    receipts:results[1]!.results.filter(r=>r.snapshot_id===row.id).map(r=>({operation:r.operation as string,key:r.key as string,actor:JSON.parse(r.actor as string),digest:r.digest as string,outcome:JSON.parse(r.outcome as string)})),
    events:results[2]!.results.filter(r=>r.snapshot_id===row.id).map(r=>({id:r.id as string,kind:r.kind as string,actor:JSON.parse(r.actor as string),fingerprint:r.fingerprint as string})),
    sources:results[3]!.results.filter(r=>r.snapshot_id===row.id).map(r=>({source:r.source as string,kind:r.kind as string,legacyId:r.legacy_id as string,revision:r.revision as string}))}));
  const payload={format:'catalogue-ordering/1' as const,records}; bounded(payload,LIMITS.exportBytes-128);
  const artifact:ExportArtifact={...payload,fingerprint:await fingerprint(payload)};
  await allowed(db,access.guard,'authority_refused');
  return {artifact,next:more?rows[input.limit-1]!.id as string:null};
}
/** Integrity checksum, not a signature or authorization to replay commands. */
export async function verifyExportArtifact(value: ExportArtifact):Promise<boolean> {
  try {
    object(value,['format','records','fingerprint']);
    if(value.format!=='catalogue-ordering/1' || !Array.isArray(value.records) || value.records.length>LIMITS.page)return false;
    bounded(value,LIMITS.exportBytes);
    for(const record of value.records){
      object(record,['snapshot','receipts','events','sources']);party(record.snapshot.subject);text(record.snapshot.id);
      if(!['specified','legacy'].includes(record.snapshot.status)||!Array.isArray(record.receipts)||!Array.isArray(record.events)||!Array.isArray(record.sources))return false;
      if(record.snapshot.status==='specified' && (!Array.isArray(record.snapshot.lines)||record.snapshot.lines.length>LIMITS.lines))return false;
    }
    return value.fingerprint===await fingerprint({format:value.format,records:value.records});
  }catch{return false;}
}
/** Run only inside the seed's explicitly fenced empty-install recovery command. */
export async function restoreHistory(db:Database,input:{installation:string;artifact:ExportArtifact}):Promise<Result<{restored:number}>> {
  try{
    object(input,['installation','artifact']);text(input.installation);
    if(!await verifyExportArtifact(input.artifact))refuse('invalid_artifact');
    const existing=await db.prepare('SELECT 1 AS present FROM co_snapshots WHERE installation=? LIMIT 1').bind(input.installation).first();
    if(existing)refuse('revision_conflict');
    const statements=[db.prepare('INSERT INTO co_assertions(id,revision_ok) SELECT ?,CASE WHEN NOT EXISTS(SELECT 1 FROM co_snapshots WHERE installation=?) AND NOT EXISTS(SELECT 1 FROM co_drafts WHERE installation=?) THEN 1 ELSE 0 END').bind(crypto.randomUUID(),input.installation,input.installation)];
    for(const record of input.artifact.records){
      const snap=record.snapshot;
      if(snap.status==='specified') statements.push(...snapshotStatements({db},input.installation,snap,null,null,'restored'));
      else statements.push(db.prepare('INSERT INTO co_snapshots(installation,id,subject_kind,subject_id,status,body,fingerprint,line_count,published,origin) VALUES(?,?,?,?,?,?,?,0,0,?)').bind(input.installation,snap.id,snap.subject.kind,snap.subject.id,'legacy',bounded(snap),snap.fingerprint,'restored'),db.prepare('UPDATE co_snapshots SET published=1 WHERE installation=? AND id=?').bind(input.installation,snap.id));
      for(const r of record.receipts)statements.push(db.prepare('INSERT INTO co_receipts(installation,subject_kind,subject_id,operation,key,actor,digest,snapshot_id,outcome,live) VALUES(?,?,?,?,?,?,?,?,?,0)').bind(input.installation,snap.subject.kind,snap.subject.id,r.operation,r.key,canonical(r.actor),r.digest,snap.id,canonical(r.outcome)));
      for(const e of record.events)statements.push(db.prepare('INSERT INTO co_events(installation,id,snapshot_id,kind,actor,fingerprint) VALUES(?,?,?,?,?,?)').bind(input.installation,e.id,snap.id,e.kind,canonical(e.actor),e.fingerprint));
      for(const s of record.sources)statements.push(db.prepare('INSERT INTO co_source_map(installation,source,kind,legacy_id,revision,snapshot_id) VALUES(?,?,?,?,?,?)').bind(input.installation,s.source,s.kind,s.legacyId,s.revision,snap.id));
    }
    if(statements.length>900)refuse('capacity');
    await batch(db,statements);return{ok:true,value:{restored:input.artifact.records.length}};
  }catch(e){return{ok:false,error:{code:e instanceof Refusal?e.code:'storage_failure'}};}
}
