import { insist, JobError } from './codec.ts';
import { Context } from './storage.ts';

export function unitBudget(context: Context, deadline: number, signal?: AbortSignal) {
  const check = () => insist(!signal?.aborted && context.now() < deadline, 'job_unit_timeout');
  return {
    check,
    async verify<T>(verification: Promise<T>): Promise<T> {
      check();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const abort = () => rejectTimeout?.(new JobError('job_unit_timeout'));
      let rejectTimeout: ((error: JobError) => void) | undefined;
      try {
        return await Promise.race([verification, new Promise<never>((_, reject) => {
          rejectTimeout = reject;
          timer = setTimeout(abort, Math.max(1, deadline - context.now()));
          signal?.addEventListener('abort', abort, { once: true });
        })]);
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    },
  };
}
