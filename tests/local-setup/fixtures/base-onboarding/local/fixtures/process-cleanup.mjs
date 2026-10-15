// Test-only historical runner fixture; never exported as an operating command.
import { setTimeout as delay } from 'node:timers/promises'
import { readOwnedGroup, sameProcess, validPid } from '../process-table.mjs'

const graceMs = 750
const cleanupMs = 7000
const isZombie = (member) => member.state.startsWith('Z')
const isStopped = (member) => /^[Tt]/.test(member.state)
const key = (member) => `${member.pid}:${member.birth}`
const isLeaf = (member, group) => !group.some((other) => other.ppid === member.pid)

// Preserve the group leader until all descendants have disappeared, including
// zombies. A living parent must get time to reap each child before it is stopped.
export async function stopOwnedGroup(child, signal) {
  const pgid = child.pid
  if (!validPid(pgid)) throw new Error('Invalid owned process group.')
  const deadline = Date.now() + cleanupMs
  let group = await readOwnedGroup(pgid)
  if (!group.length) {
    // A final fork can overlap ps while the command exits. Observe its exit
    // first and confirm absence with another scan before claiming cleanup.
    await delay(25)
    group = await readOwnedGroup(pgid)
    if (!group.length && (child.exitCode !== null || child.signalCode !== null)) return
  }
  const leader = group.find((member) => member.pid === pgid)
  if (!leader || leader.ppid !== process.pid || child.exitCode !== null || child.signalCode !== null) {
    throw new Error('Owned process group leader exited before cleanup could establish its identity.')
  }
  const signalled = new Map()
  const stopped = new Map()
  let lastGroup = group

  const snapshot = async (limit = deadline) => {
    const current = await readOwnedGroup(pgid, Math.min(1000, limit - Date.now()))
    if (Date.now() >= limit) throw new Error('Process inspection deadline expired.')
    const owner = current.find((member) => member.pid === pgid)
    // The unreaped, directly owned leader anchors the group identity. After
    // its exit, no saved PID/PGID is authority to signal a new process group.
    if (current.length && (!sameProcess(owner, leader) || owner.ppid !== process.pid
      || ((child.exitCode !== null || child.signalCode !== null || isZombie(owner)) && current.length !== 1))) {
      throw new Error('Owned process group leader exited or changed before its descendants disappeared.')
    }
    lastGroup = current
    return current
  }
  const send = async (member, name, requireLeaf = true, limit = deadline) => {
    // Recheck both identity and children immediately before each numeric PID
    // signal. Never send a negative/group signal that can kill parents first.
    const current = await snapshot(limit)
    if (Date.now() >= limit) throw new Error('Process inspection deadline expired.')
    if (child.exitCode !== null || child.signalCode !== null) return false
    const target = current.find((other) => sameProcess(member, other))
    if (!target || isZombie(target) || (requireLeaf && !isLeaf(target, current))) return false
    if (name === 'SIGKILL' && !isStopped(target)) return false
    if (requireLeaf && target.pid === pgid && current.length !== 1) return false
    try { process.kill(target.pid, name) } catch (error) {
      if (error.code !== 'ESRCH') throw new Error(`Could not send ${name} to owned process ${target.pid}.`)
      return false
    }
    return true
  }

  const unfinished = (cause) => new Error(`Owned processes remain after cancellation (last observed ${lastGroup.map((member) => `${member.pid}:${isZombie(member) ? 'zombie' : 'live'}`).join(', ')}).`, { cause })
  let cleanupError
  try {
    while (Date.now() < deadline) {
      group = await snapshot()
      if (!group.length) {
        await delay(25)
        group = await snapshot()
        if (!group.length && (child.exitCode !== null || child.signalCode !== null)) return
        if (!group.length) continue
      }
      let resuming = false
      // Resume raced parents before considering any leaves, regardless of the
      // order ps returns them. Confirm SIGCONT took effect on the next scan.
      for (const member of group) {
        if (!stopped.has(key(member)) || isLeaf(member, group)) continue
        // SIGCONT also cancels a still-pending SIGSTOP; a running snapshot
        // alone is not evidence that our stop can no longer suspend a parent.
        if (await send(member, 'SIGCONT', false)) stopped.delete(key(member))
        resuming = true
      }
      if (resuming) { await delay(25); continue }
      for (const member of group) {
        if (Date.now() >= deadline) break
        const identity = key(member)
        if (isZombie(member)) continue
        if (!isLeaf(member, group) || (member.pid === pgid && group.length !== 1)) continue
        if (!signalled.has(identity)) {
          if (await send(member, signal)) signalled.set(identity, Date.now())
        } else if (Date.now() - signalled.get(identity) >= graceMs) {
          if (!stopped.has(identity)) {
            // Freeze only a childless process before its final inspection. It
            // cannot fork between that inspection and SIGKILL once stopped.
            if (await send(member, 'SIGSTOP')) stopped.set(identity, member)
          } else if (isStopped(member)) {
            if (await send(member, 'SIGKILL')) stopped.delete(identity)
          }
        }
      }
      await delay(25)
    }
    throw unfinished()
  } catch (error) {
    cleanupError = Date.now() >= deadline ? unfinished(error) : error
    throw cleanupError
  } finally {
    // Inspection/signalling failures must not leave a process suspended.
    const errors = []
    const resumeDeadline = Math.min(deadline + 1000, Date.now() + 1000)
    for (const member of stopped.values()) {
      try { await send(member, 'SIGCONT', false, resumeDeadline) } catch (error) { errors.push(error) }
    }
    if (errors.length) throw new AggregateError([cleanupError, ...errors].filter(Boolean),
      [cleanupError?.message, 'Could not resume every suspended owned process.', ...errors.map((error) => error.message)].filter(Boolean).join(' '))
  }
}
