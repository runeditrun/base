// Race seed-owned hooks against cancellation; callers still await owned cleanup.
export async function abortable(work, signal) {
  signal?.throwIfAborted();
  if (!signal) return work();
  let onAbort;
  try {
    return await Promise.race([
      new Promise((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
      }),
      Promise.resolve().then(() => { signal.throwIfAborted(); return work(); }),
    ]);
  } finally { signal.removeEventListener('abort', onAbort); }
}
