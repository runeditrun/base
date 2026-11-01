import type { SearchResult } from './types';
export function createSearcher(index: unknown, expected?: { version: number; sourceHash: string }): (query: string) => SearchResult[];
