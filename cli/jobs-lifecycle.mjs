import { RerError } from './errors.mjs';

// The declared adapter owns persistent custody/fencing. The server owns the
// clock and process cleanup; a failed hook must not leave serving alive.
export async function jobsLifecycle(jobs, context) {
 if (typeof jobs?.lifecycle !== 'function') return;
 const controller = new AbortController();
 let timer;
 try {
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Error()); }, 5000); });
  await Promise.race([jobs.lifecycle({ ...context, signal: controller.signal }), timeout]);
 } catch {
  throw new RerError('jobs_lifecycle_failed', `Native jobs ${context.phase} custody could not be confirmed. The runtime is stopped; inspect the declared durable jobs adapter before restarting.`, 1);
 } finally { clearTimeout(timer); controller.abort(); }
}
