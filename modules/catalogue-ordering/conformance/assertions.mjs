export function equal(actual, expected, label) {
  if (canonical(actual) !== canonical(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function check(value, label) { if (!value) throw new Error(label); }
export function value(result, label) {
  check(result?.ok === true, `${label}: ${JSON.stringify(result)}`);
  return result.value;
}
export function refused(result, codes, label) {
  check(result?.ok === false && codes.includes(result.error?.code), `${label}: ${JSON.stringify(result)}`);
}
export function commercialOnly(valueToCheck, label) {
  const text = JSON.stringify(valueToCheck);
  check(!text.includes('"visibility":"cost"') && !text.includes('"kind":"cost"'), `${label}: private cost leaked`);
}
export function changedQuantity(selection) {
  const copy = structuredClone(selection);
  copy.lines[0].quantity.coefficient = (BigInt(copy.lines[0].quantity.coefficient) * 2n).toString();
  return copy;
}
export async function reviewed(runtime, id, selection = runtime.fixture.selection, previous = null) {
  const actor = runtime.fixture.actors.buyer;
  const draft = value(await runtime.request(actor, 'draft', { id, expectedRevision: 0, selection, previous }), 'save native draft');
  return value(await runtime.request(actor, 'review', { draftId: draft.id, expectedRevision: draft.revision }), 'review native draft');
}
export function commitInput(review, key) {
  return { draftId: review.id, expectedRevision: review.revision, fingerprint: review.fingerprint, operation: 'order.commit', key };
}
export function effects(stats, expected, label) {
  for (const key of ['orders', 'outcomes', 'audit', 'paymentIntents', 'snapshots', 'liveReceipts']) equal(stats[key], expected, `${label}: ${key}`);
}
