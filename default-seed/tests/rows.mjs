// Rows exercise one behavior inside one registration. Each retains its own
// assertions, diagnostic name, cleanup and (when supplied) original deadline.
export async function runRows(t, rows) {
  const failures = []
  for (const [name, options, run] of rows) {
    const cleanup = []
    const errors = []
    let timer
    try {
      const pending = run({ after: hook => cleanup.push(hook), mock: t.mock })
      if (options.timeout) {
        await Promise.race([pending, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Row exceeded ${options.timeout} ms`)), options.timeout)
        })])
      } else await pending
    } catch (error) { errors.push(error) }
    finally {
      clearTimeout(timer)
      for (const hook of cleanup) {
        try { await hook() } catch (error) { errors.push(error) }
      }
      t.mock.reset()
    }
    if (errors.length) failures.push(new AggregateError(errors, [name, ...errors.map(error => error.message)].join('\n')))
  }
  if (failures.length) throw new AggregateError(failures, failures.map(error => error.message).join('\n'))
}
