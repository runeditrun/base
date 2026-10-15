import { setTimeout as pause } from 'node:timers/promises';

// Only demo removal uses these retries. The provider's original request signal
// bounds every attempt and backoff together; no retry gets a fresh deadline.
export function demoRemovalFetch(signal, request = globalThis.fetch) {
 return async (input, init = {}) => {
  const signals = [init.signal, signal].filter(Boolean);
  const bounded = signals.length ? AbortSignal.any(signals) : undefined;
  const method = init.method ?? 'GET';
  for (let attempt = 0; ; attempt++) {
   bounded?.throwIfAborted();
   const response = await request(input, { ...init, signal: bounded });
   // A DELETE can have succeeded before the provider lost its answer. Its
   // retry then sees 404; the remover still performs its full absence readback.
   if (method === 'DELETE' && response.status === 404) {
    void response.body?.cancel().catch(() => {});
    return new Response(null, { status: 204 });
   }
   if (!['GET', 'DELETE'].includes(method) || response.status < 500 || response.status > 599 || attempt === 2) return response;
   void response.body?.cancel().catch(() => {});
   await pause(250 * 2 ** attempt, undefined, { signal: bounded });
  }
 };
}
