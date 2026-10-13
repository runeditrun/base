import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const exists = (pid) => {
  try { process.kill(pid, 0); return true } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}

// kill(pid, 0) tests PID existence, including exited children awaiting reaping.
// Cancellation must stop execution; a container's reaper owns zombie removal.
export function isProcessRunning(pid) {
  if (!exists(pid)) return false
  let state
  try {
    if (process.platform === 'linux') {
      const status = readFileSync(`/proc/${pid}/stat`, 'utf8')
      state = /^\s+([A-Z])\s/.exec(status.slice(status.lastIndexOf(')') + 1))?.[1]
    } else if (process.platform === 'darwin') {
      // A loaded host can fail one ps invocation while the PID still exists;
      // only a persistent failure is an inspection error.
      let result
      for (let attempt = 0; attempt < 5; attempt++) {
        result = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' })
        if (!result.error && result.status === 0) break
        if (!exists(pid)) return false
        spawnSync('sleep', ['0.1'])
      }
      if (result.error) throw result.error
      if (result.status !== 0) throw new Error('Could not inspect owned process state.')
      state = result.stdout.trim()[0]
    } else return true
    if (!state) throw new Error('Invalid owned process state.')
  } catch (error) {
    // Reaping may race the state read. Only an actual missing PID is dead.
    if (!exists(pid)) return false
    throw error
  }
  return state !== 'Z'
}
