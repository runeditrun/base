import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execute = promisify(execFile)

// Only the PID captured at our detached spawn is an owned POSIX group ID.
// Never select processes by name, port, or a subsequently discovered PID.
export async function liveOwnedGroup(pid, timeout) {
  if (!pid) return false
  const { stdout } = await execute('ps', ['-Ao', 'pid=,pgid=,stat='], { timeout: Math.ceil(timeout) })
  return stdout.split('\n').some((line) => {
    const [, group, state] = line.trim().split(/\s+/)
    // Zombies cannot execute or retain handles; their OS parent owns reaping.
    return Number(group) === pid && state && !state.startsWith('Z')
  })
}

export function signalOwnedGroup(pid, signal) {
  if (!pid) return
  try { process.kill(-pid, signal) }
  catch (error) { if (error.code !== 'ESRCH') throw error }
}
