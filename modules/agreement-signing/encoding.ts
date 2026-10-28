import { requireThat } from './errors.ts';
import type { ArtifactRef } from './types.ts';
export const limits = Object.freeze({
  documents: 16, recipients: 32, consents: 4, artifacts: 64, artifactBytes: 8_388_608,
  bundleBytes: 33_554_432, jsonBytes: 65_536, events: 128, nativeStatements: 8,
  credentialSeconds: 2_592_000, credentialLength: 512, reviewSeconds: 600,
});
const encoder = new TextEncoder();
/** Deliberately versioned by evidence: sha256-canonical-json-v1, sorted object keys. */
export function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') { requireThat(Number.isFinite(value)); return JSON.stringify(value); }
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  requireThat(typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype);
  const object = value as Record<string, unknown>;
  return '{' + Object.keys(object).sort().map(key => JSON.stringify(key) + ':' + canonical(object[key])).join(',') + '}';
}
export function boundedJson(value: unknown): string {
  const json = canonical(value);
  requireThat(encoder.encode(json).byteLength <= limits.jsonBytes, 'capacity');
  return json;
}
export async function sha256(value: Uint8Array | string): Promise<string> {
  const bytes = typeof value === 'string' ? encoder.encode(value) : new Uint8Array(value);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export async function artifactRef(id: string, version: string, mediaType: string, bytes: Uint8Array): Promise<ArtifactRef> {
  return { id, version, mediaType, sha256: await sha256(bytes), size: bytes.byteLength };
}
export function base64(bytes: Uint8Array): string {
  let result = '';
  for (let index = 0; index < bytes.length; index += 8192) result += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return btoa(result);
}
export function unbase64(text: string): Uint8Array { return Uint8Array.from(atob(text), value => value.charCodeAt(0)); }
export function randomToken(): string { return base64(crypto.getRandomValues(new Uint8Array(32))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''); }
export async function seal(key: CryptoKey, value: unknown, identity: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(identity) }, key, encoder.encode(canonical(value)));
  return base64(iv) + '.' + base64(new Uint8Array(bytes));
}
export async function unseal<T>(key: CryptoKey, value: string, identity: string): Promise<T> {
  const [iv, bytes] = value.split('.');
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(unbase64(iv)), additionalData: encoder.encode(identity) }, key, new Uint8Array(unbase64(bytes)));
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}
