import type { CommercialSnapshot, Context, FreezeInput, Options, Receipt } from './types.ts';
import { draftGuard, loadDraft, reviewFingerprint, subject } from './drafts.ts';
import { grant, resolve } from './selection.ts';
import { batch, check, statement } from './store.ts';
import { bounded, canonical, equal, integer, LIMITS, object, refuse, text } from './validation.ts';

type ReceiptRow = { actor: string; digest: string; snapshot_id: string; outcome: string };
async function existing(options: Options,ctx: Context,input: FreezeInput,party: {kind:string;id:string}): Promise<Receipt | null> {
  const row = await options.db.prepare('SELECT actor,digest,snapshot_id,outcome FROM co_receipts WHERE installation=? AND subject_kind=? AND subject_id=? AND operation=? AND key=? AND live=1')
    .bind(ctx.installation,party.kind,party.id,input.operation,input.key).first<ReceiptRow>();
  if (!row) return null;
  if (!equal(JSON.parse(row.actor),ctx.actor) || row.digest !== canonical(input)) refuse('idempotency_conflict');
  return { snapshotId:row.snapshot_id,outcome:JSON.parse(row.outcome),replay:true };
}
export function snapshotStatements(options: Pick<Options,'db'>, installation: string, snapshot: CommercialSnapshot, draftId: string | null, draftRevision: number | null, origin: 'live'|'restored' = 'live') {
  const db=options.db;
  return [db.prepare('INSERT INTO co_snapshots(installation,id,subject_kind,subject_id,status,body,fingerprint,draft_id,draft_revision,line_count,published,origin) VALUES(?,?,?,?,?,?,?,?,?,?,0,?)')
    .bind(installation,snapshot.id,snapshot.subject.kind,snapshot.subject.id,snapshot.status,bounded(snapshot),snapshot.fingerprint,draftId,draftRevision,snapshot.lines.length,origin),
    ...snapshot.lines.map(line=>db.prepare('INSERT INTO co_snapshot_lines(installation,snapshot_id,line_id,body) VALUES(?,?,?,?)').bind(installation,snapshot.id,line.id,canonical(line))),
    db.prepare('UPDATE co_snapshots SET published=1 WHERE installation=? AND id=?').bind(installation,snapshot.id)];
}
export async function freeze(options: Options,ctx: Context,input: FreezeInput): Promise<Receipt> {
  object(input,['draftId','expectedRevision','fingerprint','operation','key']); text(input.draftId); integer(input.expectedRevision,1); text(input.fingerprint,64); text(input.operation); text(input.key);
  const row=await loadDraft(options,ctx,input.draftId);
  const access=await grant(options,ctx,'commit',subject(row));
  // Replay remains a current authorized operation; no old authority is restored.
  const replay=await existing(options,ctx,input,subject(row));
  if(replay) return replay;
  if(row.frozen || row.revision!==input.expectedRevision || !row.review || row.fingerprint!==input.fingerprint) refuse('stale_review');
  const resolved=await resolve(options,ctx,JSON.parse(row.selection));
  if(await reviewFingerprint(ctx,row,resolved.commercial,access.revision)!==input.fingerprint || !equal(JSON.parse(row.review),resolved.commercial)) refuse('stale_review');
  let revision=1;
  if(row.previous) {
    const previous=await options.db.prepare('SELECT body FROM co_snapshots WHERE installation=? AND id=? AND subject_kind=? AND subject_id=? AND published=1').bind(ctx.installation,row.previous,row.subject_kind,row.subject_id).first<{body:string}>();
    if(!previous) refuse('revision_conflict');
    const parsed=JSON.parse(previous.body); revision=parsed.status==='specified'?parsed.revision+1:1;
  }
  const snapshot: CommercialSnapshot={...resolved.commercial,status:'specified',id:crypto.randomUUID(),revision,previous:row.previous,fingerprint:input.fingerprint,actor:ctx.actor};
  const native=await options.native.prepareCommit(ctx,{snapshot,operation:input.operation,key:input.key});
  text(native.outcome.kind);text(native.outcome.id);text(native.outcome.revision);
  if(native.statements.length>LIMITS.nativeStatements || native.statements.some(s=>s.bindings.length>80 || s.sql.length>8000)) refuse('capacity');
  const db=options.db;
  try {
    await batch(db,[check(db,access.guard,'authority'),check(db,draftGuard(ctx,row),'revision'),...resolved.guards.map(g=>check(db,g,'revision')),check(db,native.guard,'native'),
      ...snapshotStatements(options,ctx.installation,snapshot,row.id,row.revision),
      ...native.statements.map(s=>statement(db,s)),check(db,native.postcondition,'native'),
      db.prepare('INSERT INTO co_receipts(installation,subject_kind,subject_id,operation,key,actor,digest,snapshot_id,outcome,live) VALUES(?,?,?,?,?,?,?,?,?,1)').bind(ctx.installation,row.subject_kind,row.subject_id,input.operation,input.key,canonical(ctx.actor),canonical(input),snapshot.id,canonical(native.outcome)),
      db.prepare('INSERT INTO co_events(installation,id,snapshot_id,kind,actor,fingerprint) VALUES(?,?,?,?,?,?)').bind(ctx.installation,crypto.randomUUID(),snapshot.id,'committed',canonical(ctx.actor),snapshot.fingerprint),
      db.prepare('INSERT INTO co_source_map(installation,source,kind,legacy_id,revision,snapshot_id) VALUES(?,?,?,?,?,?)').bind(ctx.installation,'native',native.outcome.kind,native.outcome.id,native.outcome.revision,snapshot.id),
      db.prepare('UPDATE co_drafts SET frozen=1 WHERE installation=? AND id=?').bind(ctx.installation,row.id)]);
  }catch(e) {
    // A parallel exact command may have won after the initial lookup.
    await grant(options,ctx,'commit',subject(row));
    const winner=await existing(options,ctx,input,subject(row));
    if(winner) return winner;
    throw e;
  }
  return {snapshotId:snapshot.id,outcome:native.outcome,replay:false};
}
