import type { Database } from './src/types.ts';
export function nativeDatabase(database: { exec(sql: string): void; prepare(sql: string): { columns(): unknown[]; all(...values: unknown[]): unknown[]; run(...values: unknown[]): unknown } }): Database;
