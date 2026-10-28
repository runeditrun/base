import { demand, LIMITS } from './errors.ts';
import type { Context, Sql, WorkRef } from './types.ts';
export function canonical(value: unknown): string {
  if (value instanceof Uint8Array) return canonical(Array.from(value));
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(k => {
    const v = (value as Record<string, unknown>)[k]; demand(v !== undefined); return `${JSON.stringify(k)}:${canonical(v)}`;
  }).join(',')}}`;
  demand(value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value));
  return JSON.stringify(value);
}
export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
export async function digest(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? utf8(value) : value;
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource)), b => b.toString(16).padStart(2, '0')).join('');
}
export function json(value: unknown): string { const s = canonical(value); demand(utf8(s).length <= LIMITS.jsonBytes, 'capacity'); return s; }
export function identifier(value: unknown): asserts value is string {
  demand(typeof value === 'string' && value.length > 0 && value.length <= LIMITS.idLength && !/[\u0000-\u001f]/.test(value));
}
export function ref(value: WorkRef): void { demand(value && typeof value === 'object'); identifier(value.kind); identifier(value.id); }
export function context(value: Context): void {
  identifier(value.installationId); identifier(value.personId);
  if (value.agentId !== undefined) { identifier(value.agentId); demand(value.sponsorId === value.personId, 'forbidden'); }
  else demand(value.sponsorId === undefined, 'forbidden');
}
export const sql = (text: string, ...params: (string | number | null | ArrayBuffer)[]): Sql => ({ sql: text, params });
export const both = (...items: Sql[]): Sql => sql(items.map(s => `(${s.sql})`).join(' AND '), ...items.flatMap(s => [...s.params ?? []]));
