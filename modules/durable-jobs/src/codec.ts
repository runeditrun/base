import type { Json } from './types.ts';

export class JobError extends Error {
  code: string; status: number; recovery: string;
  constructor(code: string, status = 409, recovery = 'Inspect the job and submit a currently authorized request.') { super(code); this.code = code; this.status = status; this.recovery = recovery; }
}
export function insist(value: unknown, code: string, status = /^job_(?:invalid_|json_)/.test(code) ? 400 : 409): asserts value {
  if (!value) throw new JobError(code, status);
}
export function text(value: unknown, name: string, max = 200): string {
  insist(typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f]/.test(value), `job_invalid_${name}`, 400);
  return value;
}
export function canonical(value: Json): string {
  let nodes = 0;
  function encode(item: Json, depth: number): string {
    insist(++nodes <= 20000 && depth <= 24, 'job_payload_too_large', 413);
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return JSON.stringify(item);
    if (typeof item === 'number') { insist(Number.isFinite(item), 'job_invalid_json'); return JSON.stringify(item); }
    if (Array.isArray(item)) return '[' + item.map(v => encode(v, depth + 1)).join(',') + ']';
    insist(item && typeof item === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(item)), 'job_invalid_json');
    return '{' + Object.keys(item).sort().map(key => JSON.stringify(key) + ':' + encode(item[key], depth + 1)).join(',') + '}';
  }
  return encode(value, 0);
}
export function bounded(value: Json, max: number): string {
  const encoded = canonical(value);
  insist(new TextEncoder().encode(encoded).length <= max, 'job_payload_too_large', 413);
  return encoded;
}
export async function digest(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('');
}
export const identifier = () => crypto.randomUUID();
export const terminal = (state: string) => ['succeeded', 'failed', 'cancelled'].includes(state);
export function safeCode(value: string): string { return /^[a-z][a-z0-9_]{0,79}$/.test(value) ? value : 'job_handler_failed'; }
