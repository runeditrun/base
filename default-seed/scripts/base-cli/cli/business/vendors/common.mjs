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
// The seed's import door applies the same rules (modules/import-kit, removeCredentials).
// A field holds a credential when its name's letters end in a credential word
// (apiKey, httpPassword, http_password, client_secret, X-Api-Key, integration_key,
// webhook_url), unless it is empty: null, a boolean (Calendly's `secret` flag),
// whitespace or a mask such as "****" or "[redacted]".
const credentialName = /(?:password|passwd|secret|token|credentials?|authorization|cookie|(?:api|access|private|auth|client|integration|routing|service|signing|session|refresh)key|webhookurl|calurl)$/u;
const placeholder = /^(?:\s*|[*\u2022\u25CF\u00B7x#_.-]{1,64}|[<[({]?\s*(?:redacted|hidden|masked|removed|omitted|none|null|n\/a|placeholder)\s*[>\])}]?)$/iu;
/** What a stripped credential value becomes; the seed's import door reports it per record. */
export const REMOVED_CREDENTIAL = '[removed]';
const empty = value => value === null || typeof value === 'boolean' || (typeof value === 'string' && placeholder.test(value));
/** Every percent-encoding layer of a key, decoded byte by byte, as the door inspects it. */
function decoded(text) {
  for (let depth = 0; depth < 32 && /%[\da-f]{2}/iu.test(text); depth++) text = text.replace(/%([\da-f]{2})/giu, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  return text;
}
const isCredentialName = name => credentialName.test(decoded(name).toLowerCase().replace(/[^a-z]/gu, ''));
// The door's credentialQueryKey rule for URL query and fragment parameter names.
const credentialParameter = key => /token|secret|key|auth|signature|credential|password|cookie/iu.test(decoded(key));
const authority = /^(\s*(?:[a-z][a-z\d+.-]*:)?[\\/]{2})[^\\/?#]*@/iu;
/** A URL of any scheme without its user name and password (`removed@` marks
 * where they were) and without credential query or fragment parameters, except
 * the adapter's own validated pagination keys, spelled exactly. */
function withoutUrlCredentials(text, pagination) {
  if (!/^\s*(?:[a-z][a-z\d+.-]*:)?[\\/]{2}|^[/?]/iu.test(text)) return text;
  let result = text.replace(authority, '$1removed@');
  const drop = (pairs, requireValue) => pairs.split('&').filter(pair => (requireValue && !pair.includes('=')) || pagination.includes(pair.split('=')[0]) || !credentialParameter(pair.split('=')[0])).join('&');
  const hashAt = result.indexOf('#'), end = hashAt < 0 ? result.length : hashAt;
  let fragment = hashAt < 0 ? '' : result.slice(hashAt);
  if (fragment.includes('=')) { const kept = drop(fragment.slice(1), true); fragment = kept ? '#' + kept : ''; }
  const queryAt = result.indexOf('?');
  if (queryAt < 0 || queryAt > end) return result.slice(0, end) + fragment;
  const query = drop(result.slice(queryAt + 1, end), false);
  return result.slice(0, query ? queryAt + 1 : queryAt) + query + fragment;
}
/** A copy of a parsed vendor response without credential values, made before any
 * byte is emitted for upload: a credential-named field's value, or the `value`
 * of a `{name|key, value}` pair naming one (a header pair), becomes
 * REMOVED_CREDENTIAL, so the record stays and the seed can say what was removed.
 * URLs lose credentials as withoutUrlCredentials describes; `pagination` lists
 * the adapter's validated query keys, which stay. */
export function withoutCredentials(value, pagination = []) {
  if (Array.isArray(value)) return value.map(child => withoutCredentials(child, pagination));
  if (value && typeof value === 'object') {
    const label = Object.entries(value).find(([key, child]) => /^(?:name|key)$/iu.test(key) && typeof child === 'string');
    const pair = !!label && Object.hasOwn(value, 'value') && isCredentialName(label[1]);
    return Object.fromEntries(Object.entries(value).map(([key, child]) =>
      [key, ((pair && key === 'value') || isCredentialName(key)) && !empty(child) ? REMOVED_CREDENTIAL : withoutCredentials(child, pagination)]));
  }
  return typeof value === 'string' ? withoutUrlCredentials(value, pagination) : value;
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
