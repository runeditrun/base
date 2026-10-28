/**
 * Execute a named data-table row without registering another test.
 * Each row owns its fixture cleanup and retains its original assertion errors.
 */
export async function runCase(name, run) {
  const cleanups = [];
  let failure, failed = false;
  try {
    await run({after: cleanup => cleanups.push(cleanup)});
  } catch (error) {
    failure = error; failed = true;
  } finally {
    for (const cleanup of cleanups) {
      try { await cleanup(); }
      catch (error) {
        failure = failed ? new AggregateError([failure,error],String(failure?.message ?? failure)) : error;
        failed = true;
      }
    }
  }
  if (failed) {
    if (!(failure instanceof Error)) throw new Error(`${name}: test row threw`,{cause:failure});
    failure.message = `${name}: ${failure.message}`;
    throw failure;
  }
}
