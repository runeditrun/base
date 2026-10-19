import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { liveOwnedGroup, signalOwnedGroup } from './owned-process-group.mjs'
import { thrownMessage } from './cleanup-errors.mjs'
import { trace, tree, pipeHolders, dump } from './stop-trace.mjs'

const owned = new WeakMap()
export function spawnOwnedProcess(command, args, options) {
  const posix = process.platform !== 'win32'
  const child = spawn(command, args, { ...options, detached: posix })
  const state = { posix, pid: child.pid, error: null, exited: false, closed: false, code: null, signal: null, stopping: null }
  owned.set(child, state)
  // Observe from spawn time: exit/close may precede the caller's finally block.
  child.once('error', (error) => { state.error = error })
  child.once('exit', (code, signal) => { Object.assign(state, { exited: true, code, signal }) })
  child.once('close', (code, signal) => { Object.assign(state, { closed: true, code, signal }) })
  return child
}

async function cleanup(child, state, timeoutMs) {
  const errors = []
  // These guarantees improve test ownership/error visibility, not Vite startup.
  const failure = (message, cause) => new Error(`Owned test runtime ${message} (exit=${state.code}, signal=${state.signal}, closed=${state.closed})`, { cause })
  function signal(name) {
    try {
      if (state.posix) signalOwnedGroup(state.pid, name)
      else if (state.pid && !state.exited) child.kill(name)
    } catch (error) { errors.push(failure(`${name} failed: ${thrownMessage(error)}`, error)) }
  }
  async function settledWithin(budgetMs, afterKill = false) {
    const deadline = performance.now() + budgetMs
    do {
      try {
        const live = state.posix ? await liveOwnedGroup(state.pid, Math.max(1, Math.min(1000, deadline - performance.now()))) : !state.exited && !state.error
        if (state.closed && !live) return { settled: true, deadlineExpired: false }
      } catch (error) {
        // Even a ps timeout at our deadline retains its actual cause. The
        // elapsed deadline and inspection failure are both visible outcomes.
        errors.push(failure(`group inspection failed: ${thrownMessage(error)}`, error))
        // Inspection failure is never proof of an empty group. Still allow
        // bounded signal delivery after KILL before releasing pipe endpoints.
        if (afterKill) await delay(Math.max(0, deadline - performance.now()))
        return { settled: false, deadlineExpired: performance.now() >= deadline }
      }
      await delay(Math.max(0, Math.min(25, deadline - performance.now())))
    } while (performance.now() < deadline)
    return { settled: false, deadlineExpired: true }
  }
  try {
    if (state.error) errors.push(failure(`spawn failed: ${state.error.message}`, state.error))
    const known = new Set([state.pid]); const t0 = performance.now()
    trace(`STOP begin pid=${state.pid} args=${child.spawnargs.slice(0, 6).join(' ')}\n${tree(state.pid, known)}`)
    let exitAt = '-', closeAt = '-'
    child.once('exit', () => { exitAt = Math.round(performance.now() - t0); trace(`STOP exit-event pid=${state.pid} +${exitAt}ms`) })
    child.once('close', () => { closeAt = Math.round(performance.now() - t0) })
    const sampler = setInterval(() => trace(`STOP sample pid=${state.pid} +${Math.round(performance.now() - t0)}ms exited=${state.exited} closed=${state.closed}\n${tree(state.pid, known)}${performance.now() - t0 > 1500 ? '\n' + pipeHolders(child) : ''}`), 500)
    signal('SIGTERM')
    const graceful = await settledWithin(timeoutMs)
    clearInterval(sampler)
    const elapsed = Math.round(performance.now() - t0)
    trace(`STOP end pid=${state.pid} settled=${graceful.settled} ms=${elapsed} exited=${state.exited} closed=${state.closed}${graceful.settled ? '' : '\n' + tree(state.pid, known) + '\n' + pipeHolders(child)}`)
    process.stderr.write(`STOPLINE ${child.spawnargs.slice(3, 5).join(' ')} ms=${elapsed} settled=${graceful.settled} code=${state.code} signal=${state.signal} exitAt=${exitAt} closeAt=${closeAt}\n`)
    if (!graceful.settled || elapsed > 1500) dump(`pid=${state.pid} settled=${graceful.settled} ms=${elapsed}`)
    if (!graceful.settled) {
      // KILL is a bounded ownership cleanup, never graceful success.
      errors.push(failure(graceful.deadlineExpired ? 'did not stop gracefully before its shutdown deadline' : 'could not confirm graceful shutdown; cleanup required SIGKILL'))
      signal('SIGKILL')
      if (!(await settledWithin(2000, true)).settled) errors.push(failure('cleanup did not confirm close and group disappearance after SIGKILL'))
    }
    // Spawn errors can arrive asynchronously during the wait.
    if (state.error && !errors.some((error) => error.cause === state.error)) errors.push(failure(`spawn failed: ${state.error.message}`, state.error))
    if (errors.length === 1) throw errors[0]
    if (errors.length) throw new AggregateError(errors, `Owned test runtime cleanup failed: ${errors.map((error) => error.message).join('; ')}`, { cause: errors[0] })
  } finally {
    // Release inherited pipe endpoints on failure without claiming close.
    for (const stream of child.stdio ?? []) stream?.destroy()
  }
}

export function stopOwnedProcess(child, timeoutMs = 10000) {
  if (!child) return Promise.resolve()
  const state = owned.get(child)
  if (!state) return Promise.reject(new Error('Cannot stop an unowned test process'))
  return state.stopping ??= cleanup(child, state, timeoutMs)
}
