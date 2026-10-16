import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export class VendorExportError extends Error {
  constructor(code, status) {
    super(`Vendor export stopped (${code}).`);
    this.name = 'VendorExportError';
    this.code = code;
    if (status) this.status = status;
  }
}
export const fail = (code = 'INVALID_RESPONSE') => { throw new VendorExportError(code); };
export const hash = value => createHash('sha256').update(value).digest('hex');
export const json = value => JSON.stringify(value);
export function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  return value;
}
export function list(value, max = 2500) {
  if (!Array.isArray(value) || value.length > max || value.some(x => !x || typeof x !== 'object' || Array.isArray(x))) fail();
  return value;
}
export function id(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/u.test(value)) fail('INVALID_INPUT');
  return value;
}
export function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT/u.test(value) || value.length > 40 || !Number.isFinite(Date.parse(value))) fail('INVALID_INPUT');
  return new Date(value).toISOString();
}
export function windowInputs(inputs) {
  const start = timestamp(inputs.start ?? inputs.since), end = timestamp(inputs.end ?? inputs.until);
  if (Date.parse(start) >= Date.parse(end)) fail('INVALID_INPUT');
  return { start, end };
}
export function cursor(value) {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f]/u.test(value)) fail('INVALID_PAGINATION');
  return value;
}
// References supply pagination/identity only; neither host nor credentials can come from them.
export function reference(value, origin, pathname, allowedQuery = []) {
  let url;
  try { url = new URL(value, origin); } catch { fail('INVALID_PAGINATION'); }
  if (url.origin !== origin || url.username || url.password || url.hash || !pathname.test(url.pathname)) fail('INVALID_PAGINATION');
  if ([...url.searchParams.keys()].some(key => !allowedQuery.includes(key))) fail('INVALID_PAGINATION');
  return url;
}
export function assertCount(value, max = 1000) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) fail('INVALID_CHECKPOINT');
  return value;
}
export function shape(value, fields) {
  object(value);
  if (Object.keys(value).some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(value, key))) fail('INVALID_CHECKPOINT');
  return value;
}
export function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}

export function client({ origin, headers, route, signal, limits, counters, key }) {
  let lastRequest = 0;
  return async function get(path) {
    signal?.throwIfAborted();
    const url = new URL(path, origin);
    if (url.origin !== origin || url.username || url.password || url.hash || !route(url)) fail('INVALID_REFERENCE');
    if (++counters.requests > limits.requests) fail('REQUEST_LIMIT');
    // At most one request per second; no automatic retry or rate-limit hammering.
    const pause = 1000 - (Date.now() - lastRequest);
    if (pause > 0) await delay(pause, undefined, { signal });
    lastRequest = Date.now();
    const timeout = AbortSignal.timeout(30_000);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response;
    try { response = await fetch(url, { method: 'GET', headers, redirect: 'error', signal: requestSignal }); }
    catch { fail(signal?.aborted ? 'CANCELLED' : 'NETWORK_FAILED'); }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new VendorExportError(response.status === 429 ? 'RATE_LIMITED' : 'HTTP_REFUSED', response.status);
    }
    const chunks = []; let size = 0;
    try {
      for await (const chunk of response.body ?? []) {
        size += chunk.byteLength;
        counters.received += chunk.byteLength;
        if (size > limits.pageBytes || counters.received > limits.bytes) fail('BYTE_LIMIT');
        chunks.push(chunk);
      }
    } catch (error) {
      if (error instanceof VendorExportError) throw error;
      fail(signal?.aborted ? 'CANCELLED' : 'NETWORK_FAILED');
    }
    const bytes = Buffer.concat(chunks);
    // A reflected authentication key must never become a vendor artifact.
    if (bytes.includes(Buffer.from(key))) fail('CREDENTIAL_IN_RESPONSE');
    let body;
    try { body = JSON.parse(bytes.toString('utf8')); } catch { fail('INVALID_JSON'); }
    return { body, headers: response.headers };
  };
}
