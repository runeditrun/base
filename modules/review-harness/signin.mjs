import { abortable } from './cancellation.mjs';

// The seed supplies its own oneclick URL or browser sign-in action.
export async function signIn(page, { origin, open, timeoutMs = 10_000, signal }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('Sign-in timeoutMs must be positive');
  if (typeof open !== 'function' && typeof open !== 'string' && !(open instanceof URL)) throw new TypeError('Sign-in requires an open URL or callback');
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const deadline = performance.now() + timeoutMs;
  const timer = setTimeout(() => controller.abort(new Error('Sign-in timed out')), timeoutMs);
  let step = 'opening the seed sign-in';
  try {
    await abortable(async () => {
      const target = typeof open === 'function' ? await open(page, controller.signal) : open;
      if (performance.now() >= deadline) controller.abort(new Error('Sign-in timed out'));
      controller.signal.throwIfAborted();
      // A callback may perform the complete browser action itself.
      if (target === undefined) return;
      step = 'checking the sign-in URL';
      if (typeof target !== 'string' && !(target instanceof URL)) throw new TypeError('Expected a sign-in URL');
      const url = new URL(target, origin);
      if (url.origin !== origin || url.username || url.password) throw new Error('Sign-in URL must be same-origin');
      step = 'navigating to sign in';
      await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: Math.max(1, Math.ceil(deadline - performance.now())) });
      controller.signal.throwIfAborted();
    }, controller.signal);
  } catch {
    // Browser diagnostics and callback errors can contain a credential URL.
    throw new Error(`Sign-in failed while ${step} (bound ${timeoutMs}ms)`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}
