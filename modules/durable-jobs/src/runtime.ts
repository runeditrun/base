import { insist, JobError } from './codec.ts';
import { admissionPage } from './admission.ts';
import { claim, reconcile } from './leases.ts';
import { Context } from './storage.ts';
import { commitUnit, failUnit, settle } from './units.ts';

export async function tick(context: Context, options: { maxJobs?: number; deadline?: number; holder?: string } = {}) {
  const maxJobs = options.maxJobs ?? context.limits.installationConcurrency;
  const deadline = options.deadline ?? context.now() + context.limits.maxUnitMs;
  insist(Number.isSafeInteger(maxJobs) && maxJobs > 0 && maxJobs <= context.limits.maxList, 'job_invalid_tick_limit');
  insist(Number.isSafeInteger(deadline) && deadline > context.now() && deadline <= context.now() + context.limits.leaseMs, 'job_invalid_tick_deadline');
  await context.schema();
  await reconcile(context);
  const control = await context.control();
  insist(control?.mode === 'running', 'scheduler_unconfigured', 503);
  const page = await admissionPage(context, control!);
  let admitted = 0, committed = 0;
  // Give holds an admission reservation, rather than one position interleaved
  // with each ready ID. Invalid holds do not consume execution slots. A one-slot
  // tick alternates lanes durably; larger ticks reserve at least one ready slot.
  const heldLimit = maxJobs === 1 ? 1 : page.ready.length ? maxJobs - 1 : maxJobs;
  const lanes = maxJobs === 1 && page.readyFirst ? [page.ready, page.held] : [page.held, page.ready];
  try {
    for (const lane of lanes) {
      let heldAdmissions = 0;
      for (const id of lane) {
        if (admitted >= maxJobs || context.now() >= deadline || (lane === page.held && heldAdmissions >= heldLimit)) break;
        const acquired = await claim(context, { id, holder: options.holder }, control!);
        if (lane === page.held) page.examined(id);
        if (!acquired) continue;
        admitted++;
        if (lane === page.held) heldAdmissions++;
        const wallBudget = Math.min(context.limits.maxUnitMs, deadline - context.now(), acquired.expiresAt - context.now(), acquired.job.deadline - context.now());
        const signal = AbortSignal.timeout(Math.max(1, wallBudget));
        try {
          const kind = await context.compatible(acquired.job);
          const result = await Promise.race([
            kind.runUnit(acquired, { database: context.database, signal, limits: context.limits }),
            new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new JobError('job_unit_timeout')), { once: true })),
          ]);
          if (signal.aborted || context.now() >= deadline) throw new JobError('job_unit_timeout');
          if (result.type === 'commit') { await commitUnit(context, acquired, result, { signal, deadline }); committed++; page.ready.push(id); }
          else if (result.type === 'yield' || result.type === 'wait') await settle(context, acquired, result);
          else throw new JobError('job_effect_protocol_required', 503);
        } catch (error) { await failUnit(context, acquired, error); }
      }
    }
  } finally { await page.finish(); }
  return { admitted, committed };
}
