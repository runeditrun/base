import type { Context, Draft, Options, PartyRef, Review, Selection } from './types.ts';
import { batch, check, statement } from './store.ts';
import { grant, project, resolve } from './selection.ts';
import { bounded, canonical, equal, fingerprint, integer, object, refuse, selection, text } from './validation.ts';

export type DraftRow = { id: string; subject_kind: string; subject_id: string; actor: string; revision: number; selection: string; previous: string | null; review: string | null; fingerprint: string | null; frozen: number };
export async function loadDraft(options: Options, ctx: Context, id: string): Promise<DraftRow> {
  text(id);
  const row = await options.db.prepare('SELECT * FROM co_drafts WHERE installation=? AND id=?').bind(ctx.installation, id).first<DraftRow>();
  if (!row) refuse('not_found');
  if (!equal(JSON.parse(row.actor), ctx.actor)) refuse('authority_refused');
  return row;
}
export function draftGuard(ctx: Context, row: DraftRow) {
  return { sql: 'EXISTS(SELECT 1 FROM co_drafts WHERE installation=? AND id=? AND revision=? AND actor=? AND frozen=0)', bindings: [ctx.installation, row.id, row.revision, row.actor] };
}
export function draft(row: DraftRow): Draft { return { id: row.id, revision: row.revision, selection: JSON.parse(row.selection), previous: row.previous }; }
export function subject(row: DraftRow): PartyRef { return { kind: row.subject_kind, id: row.subject_id }; }
export async function save(options: Options, ctx: Context, input: { id: string; expectedRevision: number; selection: Selection; previous: string | null }): Promise<Draft> {
  object(input, ['id','expectedRevision','selection','previous']); text(input.id); integer(input.expectedRevision); selection(input.selection);
  if (input.previous !== null) text(input.previous);
  const access = await grant(options, ctx, 'selection', input.selection.subject);
  const current = await options.db.prepare('SELECT * FROM co_drafts WHERE installation=? AND id=?').bind(ctx.installation, input.id).first<DraftRow>();
  if (current && (!equal(JSON.parse(current.actor), ctx.actor) || !equal(subject(current), input.selection.subject))) refuse('authority_refused');
  if ((current?.revision ?? 0) !== input.expectedRevision || current?.frozen) refuse('revision_conflict');
  if (current && current.previous !== input.previous) refuse('revision_conflict');
  const resolved = await resolve(options, ctx, input.selection);
  const db = options.db;
  const previousGuard = input.previous === null ? [] : [check(db, { sql: 'EXISTS(SELECT 1 FROM co_snapshots WHERE installation=? AND id=? AND subject_kind=? AND subject_id=? AND published=1)', bindings: [ctx.installation,input.previous,input.selection.subject.kind,input.selection.subject.id] }, 'revision')];
  const revision = input.expectedRevision + 1;
  await batch(db, [check(db, access.guard, 'authority'), ...resolved.guards.map(g => check(db,g,'revision')), ...previousGuard,
    check(db, current ? draftGuard(ctx,current) : { sql: 'NOT EXISTS(SELECT 1 FROM co_drafts WHERE installation=? AND id=?)', bindings: [ctx.installation,input.id] }, 'revision'),
    db.prepare(`INSERT INTO co_drafts(installation,id,subject_kind,subject_id,actor,revision,selection,previous) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(installation,id) DO UPDATE SET revision=excluded.revision,selection=excluded.selection,review=NULL,fingerprint=NULL`).bind(ctx.installation,input.id,input.selection.subject.kind,input.selection.subject.id,canonical(ctx.actor),revision,bounded(input.selection),input.previous),
    db.prepare('DELETE FROM co_draft_lines WHERE installation=? AND draft_id=?').bind(ctx.installation,input.id),
    ...input.selection.lines.map(l => statement(db,{sql:'INSERT INTO co_draft_lines(installation,draft_id,line_id,body) VALUES(?,?,?,?)',bindings:[ctx.installation,input.id,l.id,canonical(l)]}))]);
  return { id: input.id, revision, selection: input.selection, previous: input.previous };
}
export async function review(options: Options, ctx: Context, input: { draftId: string; expectedRevision: number }): Promise<Review> {
  object(input, ['draftId','expectedRevision']); integer(input.expectedRevision,1);
  const row = await loadDraft(options,ctx,input.draftId);
  const access = await grant(options,ctx,'selection',subject(row));
  if (row.revision !== input.expectedRevision || row.frozen) refuse('revision_conflict');
  const resolved = await resolve(options,ctx,JSON.parse(row.selection));
  const fp = await reviewFingerprint(ctx,row,resolved.commercial,access.revision);
  await batch(options.db,[check(options.db,access.guard,'authority'),check(options.db,draftGuard(ctx,row),'revision'),...resolved.guards.map(g => check(options.db,g,'revision')),
    options.db.prepare('UPDATE co_drafts SET review=?,fingerprint=? WHERE installation=? AND id=?').bind(bounded(resolved.commercial),fp,ctx.installation,row.id)]);
  return { ...draft(row), fingerprint: fp, commercial: project(resolved.commercial,access.fields) };
}
export function reviewFingerprint(ctx: Context,row: DraftRow,commercial: unknown,authorityRevision: string) {
  return fingerprint({ installation:ctx.installation,actor:ctx.actor,draft:draft(row),commercial,authorityRevision });
}
