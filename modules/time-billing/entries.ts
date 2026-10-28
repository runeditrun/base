import type { CapturePolicy, CorrectionInput, DecisionInput, EntryInput, EntryRecord, EntryWrite, RecordInput, Resource, Review, Sql, TimeEntry } from './types.ts';
import type { Environment, Prepared } from './store.ts';
import { command, fence, guard, load } from './store.ts';
import { canonical, digest, identifier, json, ref, sql } from './encoding.ts';
import { demand } from './errors.ts';
import { validateDuration, validateRate } from './arithmetic.ts';
export const entryResource = (e: EntryRecord): Resource => ({ subject: e.id, work: e.work, ...(e.kind === 'entry' ? { timekeeperId: e.timekeeperId, preparerId: e.preparerId } : {}) });
export function currentPolicy(env: Environment, id: string): CapturePolicy {
  const p = env.options.policies.find(p => p.id === id); demand(p, 'unsupported', 'undeclared capture policy'); return structuredClone(p);
}
export function validateEntry(e: EntryInput): void {
  identifier(e.id); ref(e.work); ref(e.source); identifier(e.source.revision); identifier(e.timekeeperId); identifier(e.category); identifier(e.policyId);
  demand(typeof e.billable === 'boolean'); validateDuration(e.duration);
}
export function entryRows(env: Environment, entry: TimeEntry, previous?: number): Sql[] {
  const i = env.ctx.installationId, body = json(entry);
  return [previous === undefined ? sql('INSERT INTO tb_entries(installation,id,work_kind,work_id,revision,body) VALUES(?,?,?,?,?,?)', i, entry.id, entry.work.kind, entry.work.id, entry.revision, body) :
    sql('UPDATE tb_entries SET revision=?,body=? WHERE installation=? AND id=? AND revision=?', entry.revision, body, i, entry.id, previous),
  sql('INSERT INTO tb_entry_revisions(installation,entry_id,revision,body) VALUES(?,?,?,?)', i, entry.id, entry.revision, body)];
}
export async function newEntry(env: Environment, input: EntryInput, corrects: string | null = null): Promise<Prepared<TimeEntry>> {
  validateEntry(input); const policy = currentPolicy(env, input.policyId);
  demand(!(input.duration.basis === 'interval' && !policy.timer), 'unsupported');
  const entry: TimeEntry = { kind: 'entry', id: input.id, revision: 1, work: input.work, timekeeperId: input.timekeeperId, preparerId: env.ctx.personId,
    duration: input.duration, billable: input.billable, category: input.category, state: policy.review === 'none' ? 'approved' : 'draft', corrects,
    source: input.source, policy, rate: null, locked: false, attribution: env.ctx };
  const queries = [guard(await env.options.entryGuard(env.ctx, input), 'authority')];
  if (input.billable && (policy.rateStage === 'entry' || policy.review === 'none' && policy.rateStage === 'approval')) {
    const selected = await env.options.selectRate(env.ctx, entry, policy.rateStage);
    validateRate(selected.rate); demand(selected.rate.selectedAt === policy.rateStage); entry.rate = selected.rate;
    queries.push(guard(selected.guard));
  }
  queries.push(...entryRows(env, entry), sql('INSERT INTO tb_source_map(installation,source_kind,source_id,source_revision,entry_id) VALUES(?,?,?,?,?)', env.ctx.installationId, input.source.kind, input.source.id, input.source.revision, input.id));
  return { result: entry, queries };
}
export async function recordEntry(env: Environment, input: RecordInput): Promise<TimeEntry> {
  validateEntry(input);
  return command(env, 'recordEntry', { subject: input.id, work: input.work, timekeeperId: input.timekeeperId, preparerId: env.ctx.personId }, input, false, async () => {
    demand(input.expectedRevision === 0, 'conflict'); return newEntry(env, input);
  });
}
export async function nativeEntry(env: Environment, id: string): Promise<TimeEntry> {
  const e = await load<EntryRecord>(env, 'tb_entries', id); demand(e.kind === 'entry', 'locked', 'legacy history is immutable'); return e;
}
function writable(entry: TimeEntry, input: EntryWrite): void { demand(entry.revision === input.expectedRevision, 'conflict'); demand(!entry.locked, 'locked'); }
export async function reviewRow(env: Environment, entry: TimeEntry, decision: Review['decision'], policyRevision: string, reason: string): Promise<Sql> {
  demand(typeof reason === 'string' && reason.length <= 2048);
  const review: Review = { entryId: entry.id, revision: entry.revision, decision, personId: env.ctx.personId, agentId: env.ctx.agentId ?? null, policyRevision, contentDigest: await digest(json(entry)), reason };
  return sql('INSERT INTO tb_reviews(installation,entry_id,revision,body) VALUES(?,?,?,?)', env.ctx.installationId, entry.id, entry.revision, json(review));
}
export async function submit(env: Environment, input: EntryWrite): Promise<TimeEntry> {
  const old = await nativeEntry(env, input.id);
  return command(env, 'submit', entryResource(old), input, false, async a => {
    writable(old, input); demand(old.policy.review === 'required', 'unsupported'); demand(['draft', 'returned'].includes(old.state), 'conflict');
    demand(canonical(currentPolicy(env, old.policy.id)) === canonical(old.policy), 'conflict', 'capture policy changed');
    const entry: TimeEntry = { ...old, state: 'submitted', revision: old.revision + 1 };
    return { result: entry, queries: [guard(fence(env, 'tb_entries', old.id, old.revision)), ...entryRows(env, entry, old.revision), await reviewRow(env, entry, 'submit', a.policyRevision, '')] };
  });
}
export async function decide(env: Environment, input: DecisionInput): Promise<TimeEntry> {
  const old = await nativeEntry(env, input.id);
  return command(env, 'decide', entryResource(old), input, false, async () => {
    writable(old, input); demand(old.policy.review === 'required', 'unsupported'); demand(old.state === 'submitted', 'conflict');
    demand(['approve', 'return'].includes(input.decision));
    demand(canonical(currentPolicy(env, old.policy.id)) === canonical(old.policy), 'conflict', 'capture policy changed');
    const eligibility = await env.options.reviewGuard(env.ctx, old, input.decision); identifier(eligibility.policyRevision);
    const entry: TimeEntry = { ...old, revision: old.revision + 1, state: input.decision === 'approve' ? 'approved' : 'returned' };
    const queries = [guard(fence(env, 'tb_entries', old.id, old.revision)), guard(eligibility.predicate, 'authority')];
    if (input.decision === 'approve' && entry.billable && entry.policy.rateStage === 'approval') {
      const selected = await env.options.selectRate(env.ctx, entry, 'approval'); validateRate(selected.rate); demand(selected.rate.selectedAt === 'approval');
      entry.rate = selected.rate; queries.push(guard(selected.guard));
    }
    queries.push(...entryRows(env, entry, old.revision), await reviewRow(env, entry, input.decision, eligibility.policyRevision, input.reason));
    return { result: entry, queries };
  });
}
export async function correct(env: Environment, input: CorrectionInput): Promise<TimeEntry> {
  const old = await nativeEntry(env, input.id);
  return command(env, 'correct', entryResource(old), input, false, async a => {
    writable(old, input); demand(old.state !== 'void' && old.state !== 'submitted', 'conflict');
    validateEntry(input.replacement); demand(canonical(input.replacement.work) === canonical(old.work)); demand(input.replacement.id !== old.id);
    const made = await newEntry(env, input.replacement, old.id);
    made.queries.unshift(guard(fence(env, 'tb_entries', old.id, old.revision)), guard(sql("NOT EXISTS(SELECT 1 FROM tb_entries WHERE installation=? AND json_extract(body,'$.corrects')=?)", env.ctx.installationId, old.id)));
    made.queries.push(await reviewRow(env, made.result, 'correct', a.policyRevision, input.reason));
    return made;
  });
}
export async function lock(env: Environment, input: EntryWrite): Promise<TimeEntry> {
  const old = await nativeEntry(env, input.id);
  return command(env, 'lock', entryResource(old), input, false, async a => {
    writable(old, input); demand(old.state === 'approved', 'conflict');
    const entry = { ...old, revision: old.revision + 1, locked: true };
    return { result: entry, queries: [guard(fence(env, 'tb_entries', old.id, old.revision)), ...entryRows(env, entry, old.revision), await reviewRow(env, entry, 'lock', a.policyRevision, '')] };
  });
}
