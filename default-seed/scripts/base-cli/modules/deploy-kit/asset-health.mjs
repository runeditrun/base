import { pause, combinedSignal } from './cancellation.mjs';
import { nameAssetFailure } from './diagnostics.mjs';

/** Probe a real built file after identity health. A transient read gets one replay;
 * a fresh edge missing a hashed file may settle within the existing route window. */
export async function servedAsset(origin, path, request, timeoutMs, {window, windowMs = 0, clock = () => performance.now(), sleep, signal} = {}) {
  const start = clock(), budget = Math.min(windowMs || timeoutMs, window?.remaining() ?? Infinity);
  const deadline = combinedSignal(signal,AbortSignal.timeout(Math.max(1, Math.ceil(budget))));
  let transient = 0, failure;
  const fail = (code, status) => nameAssetFailure(new Error(code), [path], status);
  for (;;) {
    signal?.throwIfAborted();
    const remaining = Math.min(budget - (clock() - start), window?.remaining() ?? Infinity);
    if (remaining <= 0 || deadline.aborted) throw failure ?? fail('asset-readiness-timeout');
    let response;
    try { response = await request(`${origin}/${path.split('/').map(encodeURIComponent).join('/')}`, {redirect:'manual',signal:AbortSignal.any([deadline,AbortSignal.timeout(Math.max(1, Math.ceil(Math.min(timeoutMs,remaining / (transient ? 1 : 2)))))]),headers:{'Cache-Control':'no-cache'}}); }
    catch { signal?.throwIfAborted(); failure = fail('asset-transport-failed'); }
    if (response) {
      await response.body?.cancel().catch(() => {});
      if (response.status === 200 && !response.redirected) return {path,status:200};
      failure = fail('asset-http-failed', response.status);
      if (response.redirected || response.status !== 404 && (response.status < 500 || response.status > 599)) throw failure;
    }
    const propagating = response?.status === 404 && clock() - start + 2000 <= windowMs;
    if (!propagating && (++transient > 1 || response?.status === 404)) throw failure;
    const rest = Math.min(budget - (clock() - start), window?.remaining() ?? Infinity);
    if (rest <= 0 || deadline.aborted) throw failure;
    await pause(Math.min(2000,rest),signal,sleep);
  }
}
