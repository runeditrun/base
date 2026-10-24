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
