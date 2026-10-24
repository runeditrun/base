import { readFile, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
const execute = promisify(execFile);

async function inspected(read) {
  let timer;
  try {
    return await Promise.race([read(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(Error('Process inspection is unchecked: its read deadline expired.'),
        { ownershipUnchecked: true })), 3000);
    })]);
  } finally { clearTimeout(timer); }
}

export async function processInfo(pid) {
  if (!Number.isInteger(pid) || pid < 1) throw Error('Invalid process PID');
  return inspected(() => inspectProcess(pid));
}

async function inspectProcess(pid) {
  if (process.platform === 'linux') {
    try {
      const [stat, boot, command] = await Promise.all([readFile(`/proc/${pid}/stat`, { encoding: 'utf8', signal: AbortSignal.timeout(3000) }),
        readFile('/proc/sys/kernel/random/boot_id', { encoding: 'utf8', signal: AbortSignal.timeout(3000) }), readFile(`/proc/${pid}/cmdline`, { encoding: 'utf8', signal: AbortSignal.timeout(3000) })]);
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      return { pid, start: `${boot.trim()}:${fields[19]}`, zombie: /^[ZX]$/i.test(fields[0]),
        title: command.replace(/\0/g, ' ').trim() };
    } catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return null; throw error; }
  }
  if (process.platform !== 'darwin') throw Error('Job queue supports macOS and Linux');
  try {
    const { stdout } = await execute('/bin/ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'stat=', '-o', 'command='],
      { env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }, timeout: 3000, killSignal: 'SIGKILL' });
    const match = stdout.trim().match(/^(.{24})\s+(\S+)\s+(.*)$/);
    if (!match) throw Error(`Cannot inspect process ${pid}`);
    return { pid, start: match[1], zombie: /^[ZX]/i.test(match[2]), title: match[3] };
  } catch (error) { if (error.code === 1 && !error.stdout?.trim()) return null; throw error; }
}

export function signalGroup(pgid, signal) {
  try { process.kill(-pgid, signal); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

const groupLive = pgid => inspected(() => readGroupLive(pgid));
async function readGroupLive(pgid) {
  if (process.platform === 'darwin') {
    const { stdout } = await execute('/bin/ps', ['-A', '-o', 'pgid=', '-o', 'stat='], { timeout: 3000, killSignal: 'SIGKILL' });
    // A member already exiting (stat flag E) cannot be signalled and is ending,
    // like a zombie; killpg answers EPERM for a group of only such members.
    return stdout.trim().split('\n').some(line => {
      const [group, state] = line.trim().split(/\s+/);
      return Number(group) === pgid && !/^[ZX]/i.test(state) && !state.includes('E');
    });
  }
  const signal = AbortSignal.timeout(3000);
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

export async function deliverGroupSignal(pgid, signal, { send = signalGroup, live = groupLive } = {}) {
  // Exited members cannot receive signals, and never justify a group signal.
  // A failed inspection propagates: unknown membership grants no authority.
  if (!await live(pgid)) return false;
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
  const current = await processInfo(owner.pid);
  if (current && (current.start !== owner.start
    || (owner.marker && current.title && !current.title.includes(owner.marker)))) return;
  if (await deliverGroupSignal(owner.pgid, 'SIGTERM')) {
    await delay(graceMs);
    // Check again immediately before escalation, including the recycled PID case.
    const after = await processInfo(owner.pid);
    if (after && (after.start !== owner.start
      || (owner.marker && after.title && !after.title.includes(owner.marker)))) return;
    await deliverGroupSignal(owner.pgid, 'SIGKILL');
  }
}
