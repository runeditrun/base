import { insist, JobError } from './codec.ts';
import { Context } from './storage.ts';

export function unitBudget(context: Context, deadline: number, signal?: AbortSignal) {
  const started = performance.now(), duration = Math.max(0, deadline - context.now());
  const remaining = () => Math.min(deadline - context.now(), duration - (performance.now() - started));
  const check = (code = 'job_unit_timeout') => insist(!signal?.aborted && remaining() > 0, code);
  return {
    check, remaining,
    async verify<T>(verification: () => Promise<T>): Promise<T> {
      check();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let rejectTimeout: ((error: JobError) => void) | undefined;
      const abort = () => rejectTimeout?.(new JobError('job_unit_timeout'));
      try {
        // Arm before invoking application code: it may move the logical clock
        // or block synchronously. Neither may extend the original wall budget.
        const timeout = new Promise<never>((_, reject) => {
          rejectTimeout = reject;
          timer = setTimeout(abort, Math.max(1, remaining()));
          signal?.addEventListener('abort', abort, { once: true });
        });
        const result = await Promise.race([Promise.resolve().then(verification), timeout]);
        check(); return result;
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    },
  };
}
