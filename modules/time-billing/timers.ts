import type { EntryInput, StartInput, StopInput, TimeEntry, Timer } from './types.ts';
import type { Environment } from './store.ts';
import { command, fence, guard, load } from './store.ts';
import { currentPolicy, newEntry, validateEntry } from './entries.ts';
import { identifier, ref, sql, json } from './encoding.ts';
import { demand } from './errors.ts';
import { timerDuration } from './arithmetic.ts';
export async function startTimer(env: Environment, input: StartInput): Promise<Timer> {
  identifier(input.id); ref(input.work); identifier(input.timekeeperId); ref(input.source); identifier(input.source.revision); identifier(input.category);
  const resource = { subject: input.id, work: input.work, timekeeperId: input.timekeeperId, preparerId: env.ctx.personId };
  return command(env, 'startTimer', resource, input, false, async () => {
    demand(input.expectedRevision === 0, 'conflict'); const policy = currentPolicy(env, input.policyId); demand(policy.timer, 'unsupported');
    const startedAt = (env.options.now?.() ?? new Date()).toISOString();
    const duration = timerDuration(startedAt, startedAt, input.timezone, policy);
    const synthetic: EntryInput = { id: input.id, work: input.work, timekeeperId: input.timekeeperId, duration, billable: input.billable, category: input.category, source: input.source, policyId: input.policyId };
    validateEntry(synthetic);
    const timer: Timer = { id: input.id, revision: 1, work: input.work, timekeeperId: input.timekeeperId, preparerId: env.ctx.personId, startedAt, stoppedAt: null, state: 'running', policy,
      timezone: input.timezone, category: input.category, billable: input.billable, source: input.source, entryId: null, attribution: env.ctx };
    const overlapKey = policy.timer.overlap === 'allow' ? null : policy.timer.overlap === 'person' ? '*' : json(input.work);
    return { result: timer, queries: [guard(await env.options.entryGuard(env.ctx, synthetic), 'authority'), guard(sql("NOT EXISTS(SELECT 1 FROM tb_timers WHERE installation=? AND person_id=? AND state='running' AND (overlap_key='*' OR ?='*' OR overlap_key=?))", env.ctx.installationId, input.timekeeperId, overlapKey, overlapKey)), sql('INSERT INTO tb_timers(installation,id,work_kind,work_id,person_id,overlap_key,revision,state,body) VALUES(?,?,?,?,?,?,?,?,?)', env.ctx.installationId, timer.id, timer.work.kind, timer.work.id, timer.timekeeperId, overlapKey, 1, 'running', json(timer))] };
  });
}
export async function stopTimer(env: Environment, input: StopInput): Promise<TimeEntry> {
  const old = await load<Timer>(env, 'tb_timers', input.id);
  return command(env, 'stopTimer', { subject: old.id, work: old.work, timekeeperId: old.timekeeperId, preparerId: old.preparerId }, input, false, async () => {
    demand(old.revision === input.expectedRevision && old.state === 'running', 'conflict'); identifier(input.entryId);
    const stoppedAt = (env.options.now?.() ?? new Date()).toISOString();
    const entry = await newEntry(env, { id: input.entryId, work: old.work, timekeeperId: old.timekeeperId, duration: timerDuration(old.startedAt, stoppedAt, old.timezone, old.policy), billable: old.billable, category: old.category, source: old.source, policyId: old.policy.id });
    demand(json(entry.result.policy) === json(old.policy), 'conflict', 'timer policy changed');
    const timer: Timer = { ...old, revision: old.revision + 1, state: 'stopped', stoppedAt, entryId: input.entryId };
    return { result: entry.result, queries: [guard(fence(env, 'tb_timers', old.id, old.revision)), ...entry.queries,
      sql("UPDATE tb_timers SET revision=?,state='stopped',overlap_key=NULL,body=? WHERE installation=? AND id=? AND revision=? AND state='running'", timer.revision, json(timer), env.ctx.installationId, timer.id, old.revision)] };
  });
}
