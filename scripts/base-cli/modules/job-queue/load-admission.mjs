import { loadavg } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { configuration } from './config.mjs';
import { signalExit } from './command.mjs';

// CI and descendants sharing a live lease need no second queue slot, but each
// verification command still waits for load before starting its own deadlines.
// Once admitted, a running command is never suspended or polled here.
export async function waitForLoad({ signal, onWaiting, report } = {}) {
 const controller = new AbortController();
 const interrupt = () => controller.abort('SIGINT'), terminate = () => controller.abort('SIGTERM');
 const external = () => controller.abort(signal.reason === 'SIGINT' ? 'SIGINT' : 'SIGTERM');
 process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
 signal?.addEventListener('abort', external, { once: true });
 if (signal?.aborted) external();
 try {
  const config = await configuration();
  let reportedAt;
  while (!controller.signal.aborted) {
   const load = loadavg()[0];
   if (Number.isFinite(load) && load <= config.loadThreshold) return null;
   if (reportedAt === undefined || Date.now() - reportedAt >= 15_000) {
    const reason = Number.isFinite(load)
     ? `the 1-minute load is ${load.toFixed(1)} and verification commands start at ${config.loadThreshold} or below (change with RER_JOBS_LOAD_THRESHOLD)`
     : 'this computer\'s load could not be read';
    const detail = { reason, reasonCodes: [Number.isFinite(load) ? 'load' : 'resources_unavailable'], resources: { load }, limits: { loadThreshold: config.loadThreshold } };
    if (onWaiting) await onWaiting(detail);
    else report?.(`Waiting to start verification command: ${reason}. Running commands finish uninterrupted.`);
    reportedAt = Date.now();
   }
   await delay(config.pollMs, undefined, { signal: controller.signal }).catch(error => { if (error.name !== 'AbortError') throw error; });
  }
  return { code: signalExit(controller.signal.reason), signal: controller.signal.reason };
 } finally {
  process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
  signal?.removeEventListener('abort', external);
 }
}
