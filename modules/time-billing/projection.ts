import type { EntryRecord } from './types.ts';
export function projectEntry<T extends EntryRecord>(entry: T, projection: 'time' | 'financial'): T {
  if (projection === 'financial') return entry;
  return (entry.kind === 'entry' ? { ...entry, rate: null } : { ...entry, amountMinor: null, currency: null, historical: {} }) as T;
}
