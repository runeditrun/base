import { insist, JobError } from './codec.ts';
import { sql } from './database.ts';
import { claim } from './leases.ts';
import { Context } from './storage.ts';
import { commitUnit, failUnit, settle } from './units.ts';

export async function tick(context: Context, options: { maxJobs?: number; deadline?: number; holder?: string } = {}) {
  const maxJobs = options.maxJobs ?? context.limits.installationConcurrency;
  const deadline = options.deadline ?? context.now() + context.limits.maxUnitMs;
  insist(Number.isSafeInteger(maxJobs) && maxJobs > 0 && maxJobs <= context.limits.maxList, 'job_invalid_tick_limit');
  insist(Number.isSafeInteger(deadline) && deadline > context.now() && deadline <= context.now() + context.limits.leaseMs, 'job_invalid_tick_deadline');
  await context.schema();
  const control = await context.control();
  insist(control?.mode === 'running', 'scheduler_unconfigured', 503);
  await context.database.atomic([sql('UPDATE rer_job_control SET heartbeat=?,updated_at=? WHERE installation_id=? AND epoch=?', context.now(), context.now(), context.installationId, control.epoch)]);
  let admitted = 0, committed = 0;
  while (admitted < maxJobs && context.now() < deadline) {
    const acquired = await claim(context, { holder: options.holder });
    if (!acquired) break;
    admitted++;
    const wallBudget = Math.min(context.limits.maxUnitMs, deadline - context.now());
    const signal = AbortSignal.timeout(Math.max(1, wallBudget));
    try {
      const kind = await context.compatible(acquired.job);
      const result = await Promise.race([
        kind.runUnit(acquired, { database: context.database, signal, limits: context.limits }),
        new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new JobError('job_unit_timeout')), { once: true })),
      ]);
      if (signal.aborted || context.now() >= deadline) throw new JobError('job_unit_timeout');
      if (result.type === 'commit') { await commitUnit(context, acquired, result); committed++; }
      else if (result.type === 'yield' || result.type === 'wait') await settle(context, acquired, result);
      else throw new JobError('job_effect_protocol_required', 503);
    } catch (error) { await failUnit(context, acquired, error); }
  }
  return { admitted, committed };
}
