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
    // The PID's own stat names its lifetime (start ticks); only that stat proves exit.
    const lifetime = async () => {
      let stat;
      try {
        stat = await readFile(`/proc/${pid}/stat`, { encoding: 'utf8', signal });
      } catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return null; throw error; }
      const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
      if (!stat.startsWith(`${pid} (`) || !stat.includes(') ') || !/^\d+$/.test(fields[19] ?? ''))
        throw Error('Invalid process identity');
      return { start: fields[19], zombie: /^[ZX]$/i.test(fields[0]) };
    };
    const born = await lifetime();
    if (!born) return null;
    // Missing global boot metadata, or an unreadable command of a process still
    // present, is an unchecked identity, never group custody. An init (a
    // container's --init reaps at once) may reap the process between these reads:
    // it has exited only if its stat is now absent or names another lifetime.
    const [boot, command] = await Promise.all([
      readFile('/proc/sys/kernel/random/boot_id', { encoding: 'utf8', signal }),
      readFile(`/proc/${pid}/cmdline`, { encoding: 'utf8', signal }).catch(async error => {
        if (['ENOENT', 'ESRCH'].includes(error.code) && (await lifetime())?.start !== born.start) return null;
        throw error;
      }),
    ]);
    if (command === null) return null;
    if (!boot.trim()) throw Error('Invalid process identity');
    return { pid, start: `${boot.trim()}:${born.start}`, zombie: born.zombie, title: command.replace(/\0/g, ' ').trim() };
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

// Live members of a group, by PID. These PIDs decide custody, so every row must parse.
async function readGroupMembers(pgid, timeout) {
  const members = [];
  if (process.platform === 'darwin') {
    const { stdout } = await execute('/bin/ps', ['-A', '-o', 'pid=', '-o', 'pgid=', '-o', 'stat='], { timeout, killSignal: 'SIGKILL' });
    for (const line of stdout.trim().split('\n')) {
      const [, pid, group, state] = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/) ?? [];
      if (!pid) throw Error('Invalid process listing');
      if (Number(group) === pgid && !/^[ZX]/i.test(state) && !state.includes('E')) members.push(Number(pid));
    }
    return members;
  }
  const signal = AbortSignal.timeout(timeout);
  for (const name of (await readdir('/proc')).filter(name => /^\d+$/.test(name))) {
    try {
      signal.throwIfAborted();
      const stat = await readFile(`/proc/${name}/stat`, { encoding: 'utf8', signal });
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (!stat.startsWith(`${name} (`) || !/^\d+$/.test(fields[2] ?? '')) throw Error('Invalid process listing');
      if (Number(fields[2]) === pgid && !/^[ZX]$/i.test(fields[0])) members.push(Number(name));
    } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
  }
  return members;
}

// Each PID's launch environment as text; '' while it is gone or not yet readable.
async function readEnvironments(pids, timeout) {
  if (process.platform === 'linux') {
    const signal = AbortSignal.timeout(timeout);
    return Promise.all(pids.map(pid => readFile(`/proc/${pid}/environ`, { encoding: 'utf8', signal })
      .catch(error => { if (['ENOENT', 'ESRCH'].includes(error.code)) return ''; throw error; })));
  }
  // macOS shows another process's environment only through ps, after its
  // arguments, and never for Apple platform binaries or retitled processes.
  let stdout;
  try {
    ({ stdout } = await execute('/bin/ps', ['eww', '-p', pids.join(','), '-o', 'pid=', '-o', 'command='],
      { timeout, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 }));
  } catch (error) {
    // A quiet exit 1 means a listed PID has exited; the other rows still stand.
    if (error.code !== 1 || error.killed || error.signal || typeof error.stdout !== 'string'
      || typeof error.stderr !== 'string' || error.stderr.trim()) throw error;
    stdout = error.stdout;
  }
  const rows = new Map(stdout.split('\n').map(line => line.match(/^\s*(\d+) (.*)$/)).filter(Boolean)
    .map(([, pid, text]) => [Number(pid), text]));
  return pids.map(pid => rows.get(pid) ?? '');
}

// The supervisor gives the job command RER_JOB_MEMBERSHIP={…,"token":"<lease
// token>"} (command.mjs), and its descendants inherit it.
const carriesToken = (environment, token) => /^[\da-f-]{36}$/i.test(token ?? '')
  && new RegExp(`(?:^|[\\0\\s])RER_JOB_MEMBERSHIP=\\{[^\\0]*?"token":"${token}"`).test(environment);

// Once the leader is gone its group ID proves nothing: an unrelated leaderless
// group may hold it (PID reuse, a stale reservation). Signal only while every
// live member carries the lease's membership token; otherwise nothing is sent.
async function membersProven(pgid, token, deadline) {
  const remaining = () => Math.max(1, Math.ceil(deadline - performance.now()));
  const unproven = pid => commandFailure(`Job cleanup is unchecked: the supervisor of process group ${pgid} is gone and its live member ${pid} does not carry this job's RER_JOB_MEMBERSHIP token (another program may now hold that group ID, or the system hides that process's environment). No unverified process was signalled; the job's reservation is kept until that group ends.`, { ownershipUnchecked: true });
  const proven = new Set();
  for (;;) {
    const members = await inspected(() => readGroupMembers(pgid, remaining()), remaining());
    const pending = members.filter(pid => !proven.has(pid));
    if (!pending.length) return members.length > 0;
    const environments = await inspected(() => readEnvironments(pending, remaining()), remaining());
    for (const [index, pid] of pending.entries()) {
      if (carriesToken(environments[index], token)) proven.add(pid);
      else if (environments[index]) throw unproven(pid);
    }
    // A member that is exiting or between images shows no environment yet.
    const waiting = pending.find(pid => !proven.has(pid));
    if (waiting !== undefined) {
      if (performance.now() >= deadline) throw unproven(waiting);
      await delay(25);
    }
  }
}

// A live leader, or its unreaped zombie, reserves the group ID (POSIX): its
// recorded start and unique title authorize the group, and a replacement
// leader is never signalled. Without the leader only membersProven authorizes.
// membership is the lease's token (job.membership), inherited by its command.
export async function stopGroup(owner, graceMs, membership) {
  if (!owner?.pgid) return;
  if (!Number.isInteger(owner.pgid) || owner.pgid < 2 || owner.pgid !== owner.pid)
    throw Error('Invalid lease process group');
  const verify = async (timeout = inspectionMs) => {
    const deadline = performance.now() + timeout;
    const current = await processInfoWithin(owner.pid, timeout);
    if (!current) return membersProven(owner.pgid, membership, deadline);
    return current.start === owner.start && (current.zombie || !owner.marker || current.title.includes(owner.marker));
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
