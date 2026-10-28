import type { Actor, Context, ErrorCode, ItemRef, PartyRef, Selection } from './types.ts';
import { validateDecimal } from './decimal.ts';

export const LIMITS = Object.freeze({ lines: 40, page: 50, coefficientDigits: 36, scale: 18, text: 4096, facts: 32, breakdown: 16, nativeStatements: 12, bytes: 240_000, exportBytes: 800_000 });
export class Refusal extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode) { super(code); this.code = code; }
}
export function refuse(code: ErrorCode): never { throw new Refusal(code); }
export function object(value: unknown, keys: readonly string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) refuse('invalid_input');
}
export function text(value: unknown, max = 128): asserts value is string {
  if (typeof value !== 'string' || !value.length || value.length > max || /[\u0000-\u001f]/.test(value)) refuse('invalid_input');
}
export function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) refuse('invalid_input');
}
export function party(value: PartyRef): void { object(value, ['kind', 'id']); text(value.kind); text(value.id); }
export function item(value: ItemRef): void { object(value, ['source', 'id', 'revision']); text(value.source); text(value.id); text(value.revision); }
export function actor(value: Actor): void {
  object(value, ['personId', 'agentId', 'sponsorId']); text(value.personId);
  if (value.agentId !== undefined) { text(value.agentId); text(value.sponsorId); }
  else if (value.sponsorId !== undefined) refuse('invalid_input');
}
export function context(value: Context): void { object(value, ['installation', 'actor']); text(value.installation); actor(value.actor); }
export function selection(value: Selection): void {
  object(value, ['subject', 'lines']); party(value.subject);
  if (!Array.isArray(value.lines) || !value.lines.length) refuse('invalid_input');
  if (value.lines.length > LIMITS.lines) refuse('capacity');
  const ids = new Set();
  for (const line of value.lines) {
    object(line, ['id', 'item', 'offerId', 'quantity']); text(line.id); item(line.item); text(line.offerId);
    object(line.quantity, ['coefficient', 'scale']);
    try { validateDecimal(line.quantity); if (BigInt(line.quantity.coefficient) <= 0n) refuse('invalid_quantity'); }
    catch { refuse('invalid_quantity'); }
    if (ids.has(line.id)) refuse('invalid_input'); ids.add(line.id);
  }
}
export function equal(a: unknown, b: unknown): boolean { return canonical(a) === canonical(b); }
export function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isSafeInteger(value))) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k])).join(',') + '}';
  refuse('invalid_input');
}
export async function fingerprint(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonical(value));
  if (bytes.length > LIMITS.exportBytes) refuse('capacity');
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
}
export function bounded(value: unknown, max: number = LIMITS.bytes): string {
  const result = canonical(value);
  if (new TextEncoder().encode(result).length > max) refuse('capacity');
  return result;
}
