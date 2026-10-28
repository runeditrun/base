// A table row keeps its own assertions and cleanup, but is not a registration.
// Only combine rows that exercise the same public behaviour.
export async function checkCases(cases) {
 const failures = [];
 for (const [name, check] of cases) {
  const cleanups = [];
  try { await check({after: cleanup => cleanups.push(cleanup)}); }
  catch (cause) { failures.push(new Error(name, {cause})); }
  finally {
   for (const cleanup of cleanups) {
    try { await cleanup(); }
    catch (cause) { failures.push(new Error(`${name} cleanup`, {cause})); }
   }
  }
 }
 if (failures.length) throw new AggregateError(failures, failures.map(error => `${error.message}: ${error.cause.message}`).join('\n'));
}
