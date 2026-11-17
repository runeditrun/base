import { setTimeout as delay } from 'node:timers/promises';

export const combinedSignal = (...signals) => {
  const present = signals.filter(Boolean);
  return present.length > 1 ? AbortSignal.any(present) : present[0];
};

/** Waits finish before their caller releases its state lock. */
export async function pause(milliseconds, signal, sleep) {
  signal?.throwIfAborted();
  if (sleep) await sleep(milliseconds, {signal});
  else await delay(milliseconds, undefined, {signal});
  signal?.throwIfAborted();
}

/** Cancel the stream itself, so an in-flight read settles before unwinding. */
export async function readChunk(reader, signal) {
  signal?.throwIfAborted();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, {once:true});
  try {
    const chunk = await reader.read();
    signal?.throwIfAborted();
    return chunk;
  } finally { signal?.removeEventListener('abort', cancel); }
}
