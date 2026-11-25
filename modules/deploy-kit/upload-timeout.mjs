import { assert } from './validation.mjs';

// A send is allowed `base` plus the time its bytes need at the slowest uplink we
// tolerate. 40 kB/s (about 0.3 Mbit/s) is below the slowest home link a set-up has met.
export const SLOWEST_UPLINK_KBPS = 40;

/** Bytes a request body puts on the wire, without building it (multipart overhead is small and ignored). */
export function bodyBytes(body) {
  if (body === undefined || body === null) return 0;
  if (body instanceof FormData) {
    let total = 0;
    for (const [name, value] of body) total += typeof value === 'string' ? Buffer.byteLength(value) : value.size, total += Buffer.byteLength(name);
    return total;
  }
  return Buffer.byteLength(typeof body === 'string' ? body : JSON.stringify(body));
}

/** The time limit for one send: the base limit plus the bytes divided by the slowest uplink. */
export function sendLimitMs(baseMs, bytes, minKBps = SLOWEST_UPLINK_KBPS) {
  return baseMs + Math.ceil(bytes / (minKBps * 1000) * 1000);
}

/** RER_UPLOAD_MIN_KBPS: the slowest uplink a deploy waits for, in kB/s; lower it for a slower link. */
export function uploadMinKBps(env = process.env) {
  const raw = env.RER_UPLOAD_MIN_KBPS;
  if (raw === undefined || raw === '') return SLOWEST_UPLINK_KBPS;
  const value = Number(raw);
  assert(Number.isFinite(value) && value > 0 && value <= 100000, 'invalid-upload-min-kbps');
  return value;
}
