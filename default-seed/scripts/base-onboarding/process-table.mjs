import { readFile, readdir, stat } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { boundedProcessRead, processReadMs, readProcessCommand } from './process-read.mjs'
import { commandFailure } from './failures.mjs'

// The entire read, including transient retries, shares this hard maximum.
export const inspectionMs = processReadMs
// A snapshot taken while processes start or exit can hold a row ps has not yet
// finished, or ps itself can fail for an instant. Such a read says nothing
// about ownership; it is repeated within the same bound rather than ending a
// launch whose own processes are accounted for.
const transient = (message) => Object.assign(new Error(message), { transient: true })
const retryMs = 10
// Callers may warn at a shorter soft deadline, but an explicit extension can
// never increase the hard maximum. Startup reads have no default extension.
async function withinBound(timeout, attempt, extension = 0) {
  const budget = Math.min(inspectionMs, timeout + extension)
  const deadline = performance.now() + budget
  const slow = budget > timeout ? setTimeout(() => process.emitWarning(
    `Process inspection is taking longer than ${timeout} ms on a busy machine; waiting up to ${budget - timeout} ms more.`,
    { code: 'RER_PROCESS_INSPECTION_SLOW' }), timeout) : undefined
  slow?.unref()
  try {
    return await boundedProcessRead(async (_bound, signal) => {
      for (;;) {
        try { return await attempt(Math.max(1, Math.floor(deadline - performance.now())), signal) } catch (error) {
          if (!error.transient || performance.now() + retryMs >= deadline) throw error
          await delay(retryMs, undefined, { signal })
        }
      }
    }, budget)
  } catch (error) {
    throw commandFailure(error.message, { ownershipUnchecked: true })
  } finally { clearTimeout(slow) }
}
export const validPid = (pid) => Number.isSafeInteger(pid) && pid > 0 && pid <= 0x7fffffff

// Inspect numeric identity and the executable name, never private argv.
// Linux's start ticks distinguish recycled PIDs more precisely than ps lstart.
async function linuxProcess(pid, pgid, signal) {
  for (;;) {
    signal.throwIfAborted()
    let text
    try { text = await readFile(`/proc/${pid}/stat`, { encoding: 'utf8', signal }) } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ESRCH') return
      throw error
    }
    const group = pgid ?? Number(text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/)[2])
    if (pgid === undefined && group === 0) return // Kernel tasks cannot belong to an owned detached group.
    let member
    try { member = parseLinuxProcess(pid, group, text) } catch {
      // Procfs may finish an already-open read while its task is exiting or
      // replacing its thread leader. An invalid snapshot never grants identity:
      // reconcile this same PID until valid, gone, or the inspection aborts.
      await delay(5, undefined, { signal }); continue
    }
    if (!member) return
    try { return { ...member, uid: (await stat(`/proc/${pid}`)).uid } }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return; throw error }
  }
}

export function parseLinuxProcess(pid, pgid, text) {
  if (!validPid(pid) || !validPid(pgid) || !text.startsWith(`${pid} (`) || !text.includes(') ')) {
    throw new Error('Invalid process identity.')
  }
  const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/)
  const ppid = Number(fields[1])
  if (Number(fields[2]) !== pgid) return
  if (!Number.isSafeInteger(ppid) || ppid < 0 || !/^\d+$/.test(fields[19])) {
    throw new Error('Invalid process identity.')
  }
  return { pid, ppid, pgid, state: fields[0], birth: fields[19], command: text.slice(text.indexOf('(') + 1, text.lastIndexOf(')')) }
}

async function processGroup(pgid, signal, timeout) {
  if (process.platform === 'linux') {
    // Minimal Linux containers need not install ps. Procfs provides exact
    // start ticks and includes zombies until their actual parent reaps them.
    const pids = (await readdir('/proc')).filter((name) => /^\d+$/.test(name)).map(Number).filter(validPid)
    const group = []
    for (let offset = 0; offset < pids.length; offset += 16) {
      signal.throwIfAborted()
      const members = await Promise.all(pids.slice(offset, offset + 16).map((pid) => linuxProcess(pid, pgid, signal)))
      group.push(...members.filter(Boolean))
    }
    return group
  }
  let stdout
  try {
    ({ stdout } = await readProcessCommand('/bin/ps', [
      '-ax', '-o', 'pid=', '-o', 'ppid=', '-o', 'pgid=', '-o', 'uid=', '-o', 'stat=', '-o', 'lstart=',
    ], { env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }, signal, timeout, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024 }))
  } catch (error) { if (signal.aborted) throw error; throw transient('Could not read process identities.') }
  const group = []
  for (const line of stdout.split('\n').filter((line) => line.trim())) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.{24})\s*$/)
    if (!match) throw transient('Could not read process identities.')
    const [, id, parent, groupId, uid, state, birth] = match
    const pid = Number(id)
    const ppid = Number(parent)
    if (pgid === undefined && (pid === 0 || Number(groupId) === 0)) continue
    if (pgid !== undefined && Number(groupId) !== pgid) continue
    if (!validPid(pid) || !validPid(Number(groupId)) || !Number.isSafeInteger(ppid) || ppid < 0 || !Number.isFinite(Date.parse(birth))) {
      throw transient('Invalid process identity.')
    }
    group.push({ pid, ppid, pgid: Number(groupId), uid: Number(uid), state, birth })
  }
  return group
}

// Executable inspection is limited to owned candidates. Asking macOS ps for
// comm across every user process invokes expensive argv lookups and can make
// cleanup slower than the existing bounded shutdown contract.
export async function readProcessIdentity(pid, timeout = inspectionMs, extension = 0) {
  if (!validPid(pid) || !(timeout > 0)) throw new Error('Invalid process identity deadline.')
  return withinBound(timeout, (remaining, signal) => process.platform === 'linux'
    ? linuxProcess(pid, undefined, signal) : psIdentity(pid, remaining, signal), extension)
}

// macOS ps comm is read from the process's own argv, which process.title
// rewrites (the job supervisor retitles itself after launch). ucomm is the
// kernel's executable name: set only by exec, so it survives a retitle.
async function psIdentity(pid, timeout, signal) {
  let stdout
  try {
    ({ stdout } = await readProcessCommand('/bin/ps', ['-p', String(pid), '-o', 'pid=', '-o', 'ppid=', '-o', 'pgid=', '-o', 'uid=', '-o', 'stat=', '-o', 'lstart=', '-o', 'ucomm='],
      { env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }, timeout, signal, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 }))
  } catch (error) { if (error.code === 1 && !error.killed && !error.signal && !error.stdout?.trim() && !error.stderr?.trim()) return; throw transient('Could not inspect process identity.') }
  const match = stdout.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.{24})\s+(.+?)\s*$/)
  if (!match) throw transient('Invalid process identity.')
  const [, id, parent, groupId, uid, state, birth, command] = match
  if (Number(id) !== pid || !validPid(Number(groupId)) || !Number.isFinite(Date.parse(birth + ' UTC'))) throw transient('Invalid process identity.')
  return { pid, ppid: Number(parent), pgid: Number(groupId), uid: Number(uid), state, birth, command }
}

// `read` is the process edge: it returns the table or throws; tests supply a
// failing one.
export async function readProcessTable(timeout = inspectionMs, pgid, read = processGroup, extension = 0) {
  if (!(timeout > 0)) throw new Error('Process inspection deadline expired.')
  return withinBound(timeout, (remaining, signal) => read(pgid, signal, remaining), extension)
}

// Custody follows a process lifetime: exec changes its executable name without
// changing its PID or start time. Names are metadata, never lifetime identity.
export const sameBirth = (left, right) => validPid(left?.pid) && left.pid === right?.pid && left.birth === right?.birth
