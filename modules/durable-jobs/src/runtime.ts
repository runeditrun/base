import { insist, JobError } from './codec.ts';
import { admissionPage } from './admission.ts';
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
  const candidates = await admissionPage(context, control!);
  let admitted = 0, committed = 0;
  for (const id of candidates) {
    if (admitted >= maxJobs || context.now() >= deadline) break;
    const acquired = await claim(context, { id, holder: options.holder });
    if (!acquired) continue;
    admitted++;
    const wallBudget = Math.min(context.limits.maxUnitMs, deadline - context.now(), acquired.expiresAt - context.now(), acquired.job.deadline - context.now());
    const signal = AbortSignal.timeout(Math.max(1, wallBudget));
    try {
      const kind = await context.compatible(acquired.job);
      const result = await Promise.race([
        kind.runUnit(acquired, { database: context.database, signal, limits: context.limits }),
        new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new JobError('job_unit_timeout')), { once: true })),
      ]);
      if (signal.aborted || context.now() >= deadline) throw new JobError('job_unit_timeout');
      if (result.type === 'commit') { await commitUnit(context, acquired, result, { signal, deadline }); committed++; candidates.push(id); }
      else if (result.type === 'yield' || result.type === 'wait') await settle(context, acquired, result);
      else throw new JobError('job_effect_protocol_required', 503);
    } catch (error) { await failUnit(context, acquired, error); }
  }
  return { admitted, committed };
}
