import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { liveOwnedGroup, signalOwnedGroup } from './process-group.mjs';

// Based on the reference seed's owned-process helpers; independently copyable.
export function spawnOwnedProcess(command, args, options) {
  if (process.platform === 'win32') throw new Error('Review runtime process groups require POSIX');
  const child = spawn(command, args, { ...options, detached: true });
  const state = { pid: child.pid, error: null, exited: false, closed: false, code: null, signal: null, stopping: null };
  child.once('error', error => { state.error = error; });
  child.once('exit', (code, signal) => { Object.assign(state, { exited: true, code, signal }); });
  child.once('close', () => { state.closed = true; });
  return { child, state };
}

export function stopOwnedProcess(owned, timeoutMs = 10_000) {
  if (!owned) return Promise.resolve();
  const { child, state } = owned;
  return state.stopping ??= (async () => {
    async function signalGroup(signal) {
      try { signalOwnedGroup(state.pid, signal); }
      catch (error) {
        // POSIX hosts may return EPERM for a group whose members have just
        // exited. Permission denial alone never proves cleanup: inspect it.
        if (error.code !== 'EPERM' || await liveOwnedGroup(state.pid, 5000)) throw error;
      }
    }
    async function settledWithin(budget) {
      const deadline = performance.now() + budget;
      do {
        const live = await liveOwnedGroup(state.pid, Math.max(1, deadline - performance.now()));
        if (state.closed && !live) return true;
        await delay(25);
      } while (performance.now() < deadline);
      return false;
    }
    try {
      await signalGroup('SIGTERM');
      let graceful = false;
      // A ps deadline at the edge of the graceful budget is not evidence of
      // disappearance. Escalate, then inspect again with the full kill budget.
      try { graceful = await settledWithin(timeoutMs); }
      catch { graceful = false; }
      finally { if (!graceful) await signalGroup('SIGKILL'); }
      if (!graceful && !await settledWithin(5000)) throw new Error('Review runtime group did not disappear after SIGKILL');
    } finally { for (const stream of child.stdio ?? []) stream?.destroy(); }
  })();
}
