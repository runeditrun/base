// Keep each row's original assertions and diagnostic name without registering
// another test. Run every row so a refusal regression cannot hide later failures.
export function checkCases(cases) {
  const failures = [];
  for (const [name, check] of cases) {
    try { check(); }
    catch (cause) { failures.push(new Error(name, {cause})); }
  }
  if (failures.length) throw new AggregateError(failures, failures.map(error => `${error.message}: ${error.cause.message}`).join('\n'));
}
