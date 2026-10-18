import type { ImportPlan, Json, PaginationCursorPolicy } from '../types.ts';

const MAX_ENCODING_DEPTH = 32;

/** Trusted adapter selection, never inferred from response metadata. */
export function paginationPolicy(value: unknown): PaginationCursorPolicy | undefined {
  if (value !== undefined && value !== 'page-token-v1') throw new Error('INVALID_PAGINATION_CURSOR_POLICY');
  return value;
}

/** Inspect every encoding layer without losing malformed or Latin-1 bytes. */
function* credentialTextLayers(value: string): Generator<string> {
  let decoded = value, depth = 0;
  yield decoded;
  while (/%[\da-f]{2}/i.test(decoded)) {
    if (++depth > MAX_ENCODING_DEPTH) throw new Error('CREDENTIAL_ENCODING_DEPTH_LIMIT');
    // Decode individual bytes so an unrelated malformed escape cannot hide a key
    // or credential. UTF-8 interpretations are matched against known secrets below.
    const next = decoded.replace(/%([\da-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    if (next === decoded) break;
    decoded = next;
    yield decoded;
  }
}

/** Decode nested percent escapes for inspection only; never rewrite retained bytes or requests. */
export function decodedCredentialText(value: string): string {
  let decoded = value;
  for (const layer of credentialTextLayers(value)) decoded = layer;
  return decoded;
}

/** Match only provided credentials, in literal or encoded byte form at each layer. */
export function reflectedCredentialMatcher(secrets: readonly string[]): (value: string) => boolean {
  if (!secrets.length) return () => false;
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const bytePattern = (byte: number) => {
    const hex = byte.toString(16).padStart(2, '0').replace(/[a-f]/g, digit => `[${digit}${digit.toUpperCase()}]`);
    return `(?:${escape(String.fromCharCode(byte))}|%(?:25){0,${MAX_ENCODING_DEPTH - 1}}${hex})`;
  };
  const encoder = new TextEncoder();
  const patterns = secrets.map(secret => new RegExp([...secret].map(character => {
    const codePoint = character.codePointAt(0)!;
    const literal = codePoint <= 255 ? bytePattern(codePoint) : escape(character);
    return codePoint < 128 ? literal : `(?:${literal}|${Array.from(encoder.encode(character), bytePattern).join('')})`;
  }).join('')));
  return value => {
    // Per-byte alternatives preserve literal '%' in credentials while another part
    // is escaped, and allow mixed literal/Latin-1/UTF-8 representations.
    for (const layer of credentialTextLayers(value)) if (patterns.some(pattern => pattern.test(layer))) return true;
    return false;
  };
}

export function credentialQueryKey(rawKey: string, policy?: PaginationCursorPolicy): boolean {
  // The sole exception is the exact wire spelling, not encoded/case aliases.
  if (policy === 'page-token-v1' && rawKey === 'page_token') return false;
  return /token|secret|key|auth|signature|credential|password|cookie/i.test(decodedCredentialText(rawKey));
}

/** Inspection-only structure; opaque values are checked separately, never reparsed as outer query syntax. */
function credentialUrlStructure(value: string, policy?: PaginationCursorPolicy): string {
  if (policy !== 'page-token-v1') return value;
  const queryStart = value.indexOf('?'), fragmentStart = value.indexOf('#');
  if (queryStart < 0 || (fragmentStart >= 0 && fragmentStart < queryStart)) return value;
  const queryEnd = fragmentStart < 0 ? value.length : fragmentStart;
  const pairs = value.slice(queryStart + 1, queryEnd).split('&');
  // Split before decoding so only an exact wire key owns an opaque value.
  const structure = pairs.filter(pair => pair.split('=')[0] !== 'page_token').join('&');
  return value.slice(0, queryStart + 1) + structure + value.slice(queryEnd);
}

/** Where a credential sat: a named field (its normalised key), a URL's user
 * name and password, a URL credential query parameter, or a value repeating one
 * removed elsewhere. Never the value. */
export type CredentialField = { kind: 'field'; name: string } | { kind: 'url-userinfo' } | { kind: 'url-query' } | { kind: 'reflected' };
export class CredentialError extends Error {
  readonly field: CredentialField;
  constructor(code: 'CREDENTIAL_IN_DURABLE_DATA' | 'CREDENTIAL_IN_DURABLE_URL', field: CredentialField) {
    super(code);
    this.name = 'CredentialError';
    this.field = field;
  }
}
export function credentialFieldText(field: CredentialField): string {
  return field.kind === 'field' ? `credential field "${field.name}"` : field.kind === 'url-userinfo' ? 'URL user name or password'
    : field.kind === 'url-query' ? 'URL credential query parameter' : 'repeated credential value';
}
const CREDENTIAL_KEY = /^(?:access[_-]?token|refresh[_-]?token|token|authorization|cookie|password|api[_-]?key|secret)$/i;
/** The normalised name of a credential-named key, e.g. `apiKey` and `api_key` are both `apikey`. */
function credentialKey(key: string): string | undefined {
  const decoded = decodedCredentialText(key);
  return CREDENTIAL_KEY.test(decoded) ? decoded.toLowerCase().replace(/[_-]/g, '') : undefined;
}
/** Null, an empty string or a mask/placeholder where a credential would go is not a credential. */
export function credentialPlaceholder(value: unknown): boolean {
  return value === null || (typeof value === 'string'
    && /^(?:\s*|[*\u2022\u25CF\u00B7x#_.-]{1,64}|[<[({]?\s*(?:redacted|hidden|masked|removed|omitted|none|null|n\/a|placeholder)\s*[>\])}]?)$/i.test(value));
}
/** What an exporter writes in place of a credential value it removed before upload. */
export const REMOVED_CREDENTIAL = '[removed]';
const looksLikeUrl = (value: string) => /^(?:https?:\/\/|\/|\?)/i.test(decodedCredentialText(value));

export function assertNoCredentials(value: unknown, policy?: PaginationCursorPolicy): void {
  paginationPolicy(policy);
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) { for (const child of item) visit(child); return; }
    if (item && typeof item === 'object') {
      for (const [key, child] of Object.entries(item)) {
        if (key === 'secret' && typeof child === 'boolean') continue;
        const name = credentialKey(key);
        if (name !== undefined) {
          if (credentialPlaceholder(child)) continue;
          throw new CredentialError('CREDENTIAL_IN_DURABLE_DATA', { kind: 'field', name });
        }
        visit(child);
      }
    } else if (typeof item === 'string') {
      // Relative pagination links receive the same check as absolute links.
      if (!looksLikeUrl(item)) return;
      const url = new URL(item, 'https://credential-check.invalid');
      const structure = decodedCredentialText(credentialUrlStructure(item, policy).split('#')[0]);
      const decodedUrl = new URL(structure, 'https://credential-check.invalid');
      if (url.username || url.password || decodedUrl.username || decodedUrl.password) throw new CredentialError('CREDENTIAL_IN_DURABLE_URL', { kind: 'url-userinfo' });
      for (const pair of url.search.slice(1).split('&')) {
        if (credentialQueryKey(pair.split('=')[0], policy)) throw new CredentialError('CREDENTIAL_IN_DURABLE_URL', { kind: 'url-query' });
      }
      for (const child of url.searchParams.values()) visit(child);
      // Encoded delimiters outside opaque values must not hide credential keys.
      // Any key introduced by decoding has no exact-wire cursor exemption.
      // A decoded fragment delimiter must not truncate these query checks either.
      const queryStart = structure.indexOf('?');
      for (const pair of (queryStart < 0 ? '' : structure.slice(queryStart + 1)).split('&')) {
        const key = pair.split('=')[0];
        if (credentialQueryKey(key)) throw new CredentialError('CREDENTIAL_IN_DURABLE_URL', { kind: 'url-query' });
      }
    }
  };
  visit(value);
}

export interface RemovedCredential {
  /** JSON pointer of the field within the value. */
  path: string;
  field: CredentialField;
  /** An exporter had already removed it: the field holds REMOVED_CREDENTIAL. */
  beforeUpload?: true;
}
/** A copy of `value` without the plain credential values assertNoCredentials
 * refuses: a credential-named field holding a value is dropped, and a URL loses
 * its user name, password and credential query parameters. Placeholders stay.
 * `removed` reports each by JSON pointer and kind, never value. `secrets` holds
 * the removed values (six characters or longer) so a reader can refuse any
 * record that still repeats one elsewhere. Encoded forms are left for
 * assertNoCredentials to refuse. */
export function removeCredentials(value: Json, policy?: PaginationCursorPolicy): { value: Json; removed: RemovedCredential[]; secrets: string[] } {
  paginationPolicy(policy);
  const removed: RemovedCredential[] = [], secrets: string[] = [];
  const secret = (text: string) => { if (text.trim().length >= 6 && !credentialPlaceholder(text)) secrets.push(text); };
  const leaves = (item: Json): void => {
    if (typeof item === 'string' || typeof item === 'number') secret(String(item));
    else if (item && typeof item === 'object') for (const child of Object.values(item)) leaves(child);
  };
  const pointer = (path: string, key: string | number) => `${path}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;
  const url = (text: string, path: string): string => {
    if (!looksLikeUrl(text)) return text;
    let result = text;
    const userinfo = /^((?:https?:)?\/\/)([^/?#]*)@/i.exec(result);
    if (userinfo) {
      secret(userinfo[2]);
      result = userinfo[1] + result.slice(userinfo[0].length);
      removed.push({ path, field: { kind: 'url-userinfo' } });
    }
    const queryStart = result.indexOf('?'), fragmentStart = result.indexOf('#');
    if (queryStart < 0 || (fragmentStart >= 0 && fragmentStart < queryStart)) return result;
    const queryEnd = fragmentStart < 0 ? result.length : fragmentStart;
    const pairs = result.slice(queryStart + 1, queryEnd).split('&');
    const kept = pairs.filter(pair => !credentialQueryKey(pair.split('=')[0], policy));
    if (kept.length === pairs.length) return result;
    for (const pair of pairs) if (!kept.includes(pair)) secret(pair.slice(pair.indexOf('=') + 1));
    removed.push({ path, field: { kind: 'url-query' } });
    return result.slice(0, kept.length ? queryStart + 1 : queryStart) + kept.join('&') + result.slice(queryEnd);
  };
  const visit = (item: Json, path: string): Json => {
    if (Array.isArray(item)) return item.map((child, index) => visit(child, pointer(path, index)));
    if (item && typeof item === 'object') {
      const entries: [string, Json][] = [];
      for (const [key, child] of Object.entries(item)) {
        const name = key === 'secret' && typeof child === 'boolean' ? undefined : credentialKey(key);
        if (name !== undefined && !credentialPlaceholder(child)) {
          leaves(child);
          removed.push({ path: pointer(path, key), field: { kind: 'field', name } });
          continue;
        }
        // An exporter's removal marker is noted under any field name it chose to strip.
        if (child === REMOVED_CREDENTIAL) removed.push({ path: pointer(path, key), field: { kind: 'field', name: name ?? key.toLowerCase().slice(0, 64) }, beforeUpload: true });
        entries.push([key, visit(child, pointer(path, key))]);
      }
      // fromEntries defines own properties, so a `__proto__` key stays data.
      return Object.fromEntries(entries);
    }
    return typeof item === 'string' ? url(item, path) : item;
  };
  return { value: visit(value, ''), removed, secrets: [...new Set(secrets)] };
}

/** Only source custody carries the opt-in; mapped target effects stay strict. */
export function assertPlanCredentials(plan: ImportPlan): void {
  const policy = paginationPolicy(plan.source.paginationCursorPolicy);
  for (const [key, value] of Object.entries(plan)) {
    if (key === 'source') assertNoCredentials({ [key]: value }, policy);
    else if (key === 'entries') for (const entry of plan.entries) {
      for (const [field, item] of Object.entries(entry)) assertNoCredentials({ [field]: item }, field === 'source' ? policy : undefined);
    }
    else assertNoCredentials({ [key]: value });
  }
}
