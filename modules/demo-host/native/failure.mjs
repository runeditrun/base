// Seed errors are untrusted data. Retain a fixed category, never their text,
// stack, name, cause, AggregateError members, or an owner-claim response body.
// This also discards encoded values and fragments of any length, without
// needing to copy secrets into a host-wide registry or guess their encoding.
export const failure = () => 'seed-operation-failed [redacted]';
export const failureResponse = () => new Response('The demo could not complete this request. Try again.', { status: 500, headers: { 'cache-control': 'no-store' } });
export async function seedOperation(operation) {
  try { return await operation(); }
  catch { throw new Error(failure()); }
}
// Background seed work must not hand the platform an unfiltered rejection.
export function seedContext(ctx) {
  return new Proxy(ctx, { get(target, key) {
    if (key === 'waitUntil') return promise => target.waitUntil(seedOperation(() => promise));
    if (key === 'blockConcurrencyWhile') return callback => target.blockConcurrencyWhile(() => seedOperation(callback));
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}
