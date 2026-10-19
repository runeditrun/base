import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { credentialName, credentialScheme, headerContainer } from './credential-names.mjs';

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
// A field holds a credential when the parts of its name are a credential word or
// phrase (apiKey, httpPassword, http_password, client_secret, X-Api-Key,
// integration_key, webhook_url, secret_key, x-functions-key,
// Ocp-Apim-Subscription-Key, db_pwd, X-Auth), unless its value is empty: null, a
// boolean (Calendly's `secret` flag), whitespace or a mask such as "****" or
// "[redacted]". Names that only contain such letters (keyword, monkey, author,
// signal, design) are not credentials. A plural (apiKeys, tokens) holds
// credentials only as text, so a count such as `tokens: 1500` stays. `auth` and
// `credentials` hold one only as text naming no scheme or mode (`include`,
// `oauth2`); an object under them keeps its fields and loses its own credential
// fields (`auth: {token}`). `sig`, `signature` and `sessionId` are credentials as
// header names (a tuple, a header pair, a key under `headers`), never as fields.
const placeholder = /^(?:\s*|[*\u2022\u25CF\u00B7x#_.-]{1,64}|[<[({]?\s*(?:redacted|hidden|masked|removed|omitted|none|null|n\/a|placeholder)\s*[>\])}]?)$/iu;
/** What a stripped credential value becomes; the seed's import door reports it per record. */
export const REMOVED_CREDENTIAL = '[removed]';
/** What a stripped credential query or fragment parameter's value becomes
 * (`?api_key=removed`), as a URL's user name and password become `removed@`; the
 * door drops the pair and reports it per record. */
export const REMOVED_PARAMETER = 'removed';
const empty = value => value === null || typeof value === 'boolean' || (typeof value === 'string' && placeholder.test(value));
// Text as a member (`['…']`, `{github: '…'}`); a list of objects is checked field by field.
const text = value => typeof value === 'string' ? !placeholder.test(value) : !!value && typeof value === 'object' && Object.values(value).some(child => (typeof child === 'string' || Array.isArray(child)) && text(child));
/** Every percent-encoding layer of a key, decoded byte by byte, as the door inspects it. */
function decoded(text) {
  for (let depth = 0; depth < 32 && /%[\da-f]{2}/iu.test(text); depth++) text = text.replace(/%([\da-f]{2})/giu, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  return text;
}
/** Text under `auth` or `credentials` naming no scheme or mode, or a list with such a member. */
const schemeless = value => typeof value === 'string' ? !placeholder.test(value) && !credentialScheme(value) : Array.isArray(value) && value.some(member => typeof member === 'string' && schemeless(member));
/** Whether a value under this name, a record field or an HTTP header name, is a credential, by the door's rule. */
function credential(name, value, place) {
  const found = credentialName(decoded(name), 'remove', place);
  return found !== undefined && !empty(value) && (found.container ? schemeless(value) : !found.plural || text(value));
}
// The door's credentialQueryKey rule for URL query and fragment parameter names:
// api_key, access_token, a bare `key`, sig and X-Amz-Signature, never keyword or author.
const credentialParameter = key => credentialName(decoded(key), 'query') !== undefined;
const authority = /^(\s*(?:[a-z][a-z\d+.-]*:)?[\\/]{2})[^\\/?#]*@/iu;
/** A URL of any scheme with its user name and password replaced by `removed@`,
 * and the value of each credential query or fragment parameter by `removed`,
 * except the adapter's own validated pagination keys, spelled exactly. */
function withoutUrlCredentials(text, pagination) {
  if (!/^\s*(?:[a-z][a-z\d+.-]*:)?[\\/]{2}|^[/?]/iu.test(text)) return text;
  const result = text.replace(authority, '$1removed@');
  const mark = pairs => pairs.split('&').map(pair => {
    const at = pair.indexOf('='), key = at < 0 ? pair : pair.slice(0, at);
    return at < 0 || pagination.includes(key) || !credentialParameter(key) ? pair : `${key}=${REMOVED_PARAMETER}`;
  }).join('&');
  const hashAt = result.indexOf('#'), end = hashAt < 0 ? result.length : hashAt;
  const fragment = hashAt < 0 ? '' : result.slice(hashAt);
  const marked = fragment.includes('=') ? '#' + mark(fragment.slice(1)) : fragment;
  const queryAt = result.indexOf('?');
  if (queryAt < 0 || queryAt > end) return result.slice(0, end) + marked;
  return result.slice(0, queryAt + 1) + mark(result.slice(queryAt + 1, end)) + marked;
}
/** The `[name, value]` pairs of a list holding only such pairs (Sentry's header tuples). */
const tuples = list => list.length > 0 && list.every(item => Array.isArray(item) && item.length === 2 && typeof item[0] === 'string');
/** A copy of a parsed vendor response without credential values, made before any
 * byte is emitted for upload: a credential-named field's value, the `value` of a
 * `{name|key, value}` pair naming one (a header pair), or the value of a
 * credential-named `[name, value]` pair in a list of them, becomes
 * REMOVED_CREDENTIAL, so the record stays and the seed can say what was removed.
 * URLs lose credentials as withoutUrlCredentials describes; `pagination` lists
 * the adapter's validated query keys, which stay. */
export function withoutCredentials(value, pagination = []) {
  // `headers`: the keys of this object, or of objects in this list, are HTTP header names.
  const strip = (value, headers) => {
    if (Array.isArray(value)) {
      const pairs = tuples(value);
      return value.map(child => pairs && credential(child[0], child[1], 'header') ? [child[0], REMOVED_CREDENTIAL] : strip(child, headers));
    }
    if (value && typeof value === 'object') {
      const label = Object.entries(value).find(([key, child]) => /^(?:name|key)$/iu.test(key) && typeof child === 'string');
      const pair = !!label && Object.hasOwn(value, 'value');
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, (pair && key === 'value' ? credential(label[1], child, 'header') : credential(key, child, headers ? 'header' : 'field'))
        ? REMOVED_CREDENTIAL : strip(child, headerContainer(key))]));
    }
    return typeof value === 'string' ? withoutUrlCredentials(value, pagination) : value;
  };
  return strip(value, false);
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
