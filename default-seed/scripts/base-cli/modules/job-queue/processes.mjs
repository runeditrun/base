import { readFile, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { shared } from '../../cli/shared.mjs';
const execute = promisify(execFile);
const { commandFailure } = await shared('failures.mjs');
const inspectionMs = 3000;

async function inspected(read, timeout = inspectionMs) {
  let timer;
  const unchecked = () => commandFailure('Process inspection is unchecked: the process metadata could not be read within its bound. No unverified process was signalled.', { ownershipUnchecked: true });
  try {
    return await Promise.race([read(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(unchecked()), timeout);
    })]);
  } catch { throw unchecked();
  } finally { clearTimeout(timer); }
}

export async function processInfo(pid) {
  return processInfoWithin(pid, inspectionMs);
}

async function processInfoWithin(pid, timeout = inspectionMs) {
  if (!Number.isInteger(pid) || pid < 1) throw Error('Invalid process PID');
  timeout = Math.max(1, Math.min(timeout, inspectionMs));
  return inspected(() => inspectProcess(pid, timeout), timeout);
}

async function inspectProcess(pid, timeout) {
  if (process.platform === 'linux') {
    const signal = AbortSignal.timeout(timeout);
    let stat;
    try {
      stat = await readFile(`/proc/${pid}/stat`, { encoding: 'utf8', signal });
    } catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return null; throw error; }
    // Only an absent PID stat proves exit. Missing global boot metadata or a
    // vanished/unreadable command is an unchecked identity, never group custody.
    const [boot, command] = await Promise.all([
      readFile('/proc/sys/kernel/random/boot_id', { encoding: 'utf8', signal }),
      readFile(`/proc/${pid}/cmdline`, { encoding: 'utf8', signal }),
    ]);
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    if (!stat.startsWith(`${pid} (`) || !stat.includes(') ') || !/^\d+$/.test(fields[19] ?? '') || !boot.trim())
      throw Error('Invalid process identity');
    return { pid, start: `${boot.trim()}:${fields[19]}`, zombie: /^[ZX]$/i.test(fields[0]),
      title: command.replace(/\0/g, ' ').trim() };
  }
  if (process.platform !== 'darwin') throw Error('Job queue supports macOS and Linux');
  try {
    const { stdout } = await execute('/bin/ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'stat=', '-o', 'command='],
      { env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }, timeout, killSignal: 'SIGKILL' });
    const match = stdout.trim().match(/^(.{24})\s+(\S+)\s+(.*)$/);
    if (!match) throw Error(`Cannot inspect process ${pid}`);
    return { pid, start: match[1], zombie: /^[ZX]/i.test(match[2]), title: match[3] };
  } catch (error) {
    if (error.code === 1 && !error.killed && !error.signal && typeof error.stdout === 'string'
      && typeof error.stderr === 'string' && !error.stdout.trim() && !error.stderr.trim()) return null;
    throw error;
  }
}

export function signalGroup(pgid, signal) {
  try { process.kill(-pgid, signal); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

const groupLive = (pgid, timeout = inspectionMs) => inspected(() => readGroupLive(pgid, timeout), timeout);
async function readGroupLive(pgid, timeout) {
  if (process.platform === 'darwin') {
    const { stdout } = await execute('/bin/ps', ['-A', '-o', 'pgid=', '-o', 'stat='], { timeout, killSignal: 'SIGKILL' });
    // A member already exiting (stat flag E) cannot be signalled and is ending,
    // like a zombie; killpg answers EPERM for a group of only such members.
    return stdout.trim().split('\n').some(line => {
      const [group, state] = line.trim().split(/\s+/);
      return Number(group) === pgid && !/^[ZX]/i.test(state) && !state.includes('E');
    });
  }
  const signal = AbortSignal.timeout(timeout);
  for (const name of (await readdir('/proc')).filter(name => /^\d+$/.test(name))) {
    try {
      signal.throwIfAborted();
      const stat = await readFile(`/proc/${name}/stat`, { encoding: 'utf8', signal });
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (Number(fields[2]) === pgid && !/^[ZX]$/i.test(fields[0])) return true;
    } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
  }
  return false;
}

export async function deliverGroupSignal(pgid, signal, { send = signalGroup, live = groupLive, verify = async () => true } = {}) {
  // Exited members cannot receive signals, and never justify a group signal.
  // A failed inspection propagates: unknown membership grants no authority.
  if (!await live(pgid)) return false;
  // Discovery yields to the OS. Verify the recorded lifetime after it, with
  // no further awaited work between that final identity and signal delivery.
  if (!await verify()) return false;
  try { return send(pgid, signal); }
  catch (error) {
    // Darwin excludes zombies in killpg and can return EPERM for a stopped group.
    // Completion requires independent evidence; a live/unknown group stays held.
    if (error.code === 'EPERM' && !await live(pgid)) return false;
    throw error;
  }
}

// A group ID cannot be reused while the old group has surviving members (POSIX).
// A live replacement leader is never signalled; both platforms check its unique title.
export async function stopGroup(owner, graceMs) {
  if (!owner?.pgid) return;
  if (!Number.isInteger(owner.pgid) || owner.pgid < 2 || owner.pgid !== owner.pid)
    throw Error('Invalid lease process group');
  const verify = async (timeout) => {
    const current = await processInfoWithin(owner.pid, timeout);
    return !current || (current.start === owner.start
      && (current.zombie || !owner.marker || current.title.includes(owner.marker)));
  };
  if (await deliverGroupSignal(owner.pgid, 'SIGTERM', { verify })) {
    await delay(graceMs);
    if (await deliverGroupSignal(owner.pgid, 'SIGKILL', { verify })) {
      // Delivery is not completion. Keep the reservation until the owned group
      // is gone (or zombie-only); never wait on a recycled group's new lifetime.
      const deadline = performance.now() + inspectionMs;
      for (;;) {
        const remaining = Math.max(1, Math.ceil(deadline - performance.now()));
        if (!await groupLive(owner.pgid, remaining) || !await verify(Math.max(1, Math.ceil(deadline - performance.now())))) return;
        if (performance.now() >= deadline) throw Error('Owned processes remain after cancellation: live job group survived SIGKILL.');
        await delay(Math.min(25, deadline - performance.now()));
      }
    }
  }
}
