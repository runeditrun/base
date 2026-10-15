// Run every owned cleanup even after failure and retain original error identity.
export const BODY_SUCCEEDED = Symbol('test body succeeded')
export function thrownMessage(value) {
  try { return String(value) } catch { return 'Thrown value cannot be converted to text' }
}

export async function finishWithCleanup(bodyError, cleanups) {
  const errors = bodyError === BODY_SUCCEEDED ? [] : [bodyError]
  for (const cleanup of cleanups) {
    try { await cleanup() } catch (error) { errors.push(error) }
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length) throw new AggregateError(errors, `Test body or cleanup failed: ${errors.map(thrownMessage).join('; ')}`, { cause: errors[0] })
}
