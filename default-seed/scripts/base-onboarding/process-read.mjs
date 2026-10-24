import { execFile } from 'node:child_process'

// A process read can be unavailable; it must never hold startup indefinitely.
// The caller decides what unchecked ownership permits. This boundary grants
// no identity, absence or signal authority.
export const processReadMs = 3000

export async function boundedProcessRead(read, timeout = processReadMs, signal) {
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('Process inspection deadline expired.')
  const bound = Math.min(processReadMs, Math.ceil(timeout))
  const controller = new AbortController()
  const cancelled = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  cancelled.throwIfAborted()
  let timer
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = Object.assign(new Error('Process inspection deadline expired.'), { code: 'ETIMEDOUT', killed: true })
      reject(error)
      controller.abort(error)
    }, bound)
  })
  try { return await Promise.race([read(bound, cancelled), deadline]) }
  finally { clearTimeout(timer) }
}

// AbortSignal can settle execFile before its child has exited. Retain the
// original ChildProcess handle and kill that inspection explicitly, including
// a probe that ignores TERM. A numeric PID never supplies signal authority.
export async function readProcessCommand(file, args, { timeout = processReadMs, signal, ...options } = {}) {
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('Process inspection deadline expired.')
  const bound = Math.min(processReadMs, Math.ceil(timeout))
  const controller = new AbortController()
  const cancelled = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  cancelled.throwIfAborted()
  let child
  const { promise: pending, resolve, reject } = Promise.withResolvers()
  child = execFile(file, args, { ...options, timeout: bound, signal: cancelled, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
    if (error) reject(Object.assign(error, { stdout, stderr }))
    else resolve({ stdout, stderr })
  })
  const kill = () => { if (child?.exitCode == null && child?.signalCode == null) child?.kill('SIGKILL') }
  cancelled.addEventListener('abort', kill, { once: true })
  try { return await boundedProcessRead(() => pending, bound, cancelled) }
  finally { kill(); controller.abort(); cancelled.removeEventListener('abort', kill) }
}
