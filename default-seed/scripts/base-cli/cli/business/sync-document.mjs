import { createHash, webcrypto } from 'node:crypto';
import { parseJson } from './sync-document-json.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && value === value.trim() && !/[\x00-\x1f\x7f-\x9f]/.test(value);
const email = value => text(value, 254) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value === value.toLowerCase();
const integer = value => Number.isSafeInteger(value) && value >= 0;
const invalid = () => { throw Error('business_invalid_settings'); };
function closed(value, required, optional = []) {
 if (!object(value) || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalid();
 return value;
}
function decode(segment) {
 if (typeof segment !== 'string' || !/^[A-Za-z0-9_-]+$/.test(segment)) invalid();
 const bytes = Buffer.from(segment, 'base64url');
 if (bytes.toString('base64url') !== segment) invalid();
 return bytes;
}
const json = segment => parseJson(new TextDecoder('utf-8', { fatal: true }).decode(decode(segment)));

function values(input) {
 const value = closed(input, [], ['display_name', 'owner_name', 'brand_color', 'timezone']);
 for (const [key, item] of Object.entries(value)) {
  if (!text(item, key === 'timezone' ? 100 : 120)) invalid();
  if (key === 'brand_color' && !/^#[0-9a-f]{6}$/i.test(item)) invalid();
  if (key === 'timezone') new Intl.DateTimeFormat('en', { timeZone: item });
 }
}

// Mirrors the seed's media checks; a digest alone does not establish MIME type.
function imageType(bytes) {
 if (bytes.length < 4 || bytes.length > 256 * 1024) invalid();
 const start = (...items) => items.every((value, index) => bytes[index] === value);
 if (start(137, 80, 78, 71, 13, 10, 26, 10)) return 'image/png';
 if (start(255, 216, 255)) return 'image/jpeg';
 if (start(82, 73, 70, 70) && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
 const svg = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim();
 if (!/^(?:<\?xml[^?]*\?>\s*)?<svg(?:\s|>)/i.test(svg) || !/(?:<\/svg>|\/>)\s*$/i.test(svg)
  || /<!\s*(?:DOCTYPE|ENTITY)|<\s*(?:script|foreignObject|iframe|object|embed)\b|\bon[a-z]+\s*=/i.test(svg)) invalid();
 for (const match of svg.matchAll(/\b(?:href|src)\s*=\s*(["'])(.*?)\1/gi)) if (!/^#[\w:.-]+$/.test(match[2])) invalid();
 for (const match of svg.matchAll(/url\s*\(\s*([^)]*)\)/gi)) if (!/^#[\w:.-]+$/.test(match[1].trim().replace(/^["']|["']$/g, ''))) invalid();
 return 'image/svg+xml';
}
function logo(metadata, supplied, detached) {
 if (metadata !== null) {
  const value = closed(metadata, ['sha256', 'type', 'bytes']);
  if (typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sha256)
   || !['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'].includes(value.type)
   || !integer(value.bytes) || value.bytes < 1 || value.bytes > 256 * 1024) invalid();
 }
 // An omitted upload can reuse the app's existing hash; only the app knows it.
 if (supplied === null || supplied === undefined) return;
 if (metadata === null || detached || typeof supplied !== 'string' || supplied.length > 350_000
  || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(supplied)) invalid();
 const bytes = Buffer.from(supplied, 'base64');
 if (bytes.length !== metadata.bytes || imageType(bytes) !== metadata.type
  || createHash('sha256').update(bytes).digest('hex') !== metadata.sha256) invalid();
}

/** Verify before any checkout writes. The returned private payload stays in memory. */
export async function verifySettings(document, trust, businessId, auditEmail) {
 try {
  closed(document, ['settings'], ['logo']);
  if (typeof document.settings !== 'string' || document.settings.length > 200_000
   || (document.logo !== null && document.logo !== undefined && (typeof document.logo !== 'string' || document.logo.length > 350_000))
   || Buffer.byteLength(JSON.stringify(document)) > 512 * 1024) invalid();
  closed(trust, ['v', 'issuer', 'audience', 'subject', 'keys']);
  if (trust.v !== 1 || trust.audience !== 'self-host' || !text(trust.issuer, 256) || new URL(trust.issuer).origin !== trust.issuer
   || !text(businessId, 256) || !text(trust.subject, 256) || !trust.subject.startsWith(`${businessId}/`)
   || trust.subject.length === businessId.length + 1 || !object(trust.keys)) invalid();
  const parts = document.settings.split('.');
  if (parts.length !== 3) invalid();
  const header = closed(json(parts[0]), ['alg', 'typ', 'kid']);
  if (header.alg !== 'ES256' || header.typ !== 'rer-business-settings+jwt' || !text(header.kid, 128) || !Object.hasOwn(trust.keys, header.kid)) invalid();
  const signature = decode(parts[2]);
  if (signature.length !== 64) invalid();
  const jwk = closed(trust.keys[header.kid], ['kty', 'crv', 'x', 'y']);
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || decode(jwk.x).length !== 32 || decode(jwk.y).length !== 32) invalid();
  const key = await webcrypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  if (!await webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, Buffer.from(`${parts[0]}.${parts[1]}`))) invalid();
  const payload = closed(json(parts[1]), ['v', 'iss', 'aud', 'sub', 'business', 'email', 'jti', 'iat', 'exp', 'rev', 'values', 'logo', 'team'], ['detached']);
  const now = Math.floor(Date.now() / 1000);
  if (payload.v !== 1 || payload.iss !== trust.issuer || payload.aud !== trust.audience || payload.sub !== trust.subject || payload.business !== businessId
   || !email(payload.email) || (auditEmail !== undefined && (!email(auditEmail) || payload.email !== auditEmail)) || !text(payload.jti, 256)
   || !integer(payload.iat) || !integer(payload.exp) || payload.iat > now + 30 || payload.exp <= now || payload.exp <= payload.iat || payload.exp - payload.iat > 86400
   || !Number.isSafeInteger(payload.rev) || payload.team !== null || (payload.detached !== undefined && payload.detached !== true)) invalid();
  values(payload.values);
  logo(payload.logo, document.logo, payload.detached);
  return payload;
 } catch {
  throw Object.assign(Error('Business returned invalid signed settings. Nothing was saved.'), { code: 'business_invalid_settings' });
 }
}
