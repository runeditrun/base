import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

// Inspect only the group ID captured at our detached spawn, never a port/name.
export async function liveOwnedGroup(pid, timeout) {
  if (!pid) return false;
  const inspection = execute('ps', ['-Ao', 'pid=,pgid=,stat='], { timeout: Math.ceil(timeout) });
  const { stdout } = await inspection;
  // execFile can resolve when a deadline-signalled process exits zero, even
  // though it closed stdout before collecting the complete snapshot.
  if (inspection.child.killed) throw new Error('Process group inspection timed out');
  return stdout.split('\n').some(line => {
    const [, group, state] = line.trim().split(/\s+/);
    // Zombies cannot execute or retain handles; their OS parent owns reaping.
    return Number(group) === pid && state && !state.startsWith('Z');
  });
}

export function signalOwnedGroup(pid, signal) {
  if (!pid) return;
  try { process.kill(-pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}
