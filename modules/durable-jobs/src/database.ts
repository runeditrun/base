import type { Database, D1Database, Sql } from './types.ts';
import { JobError } from './codec.ts';

export const sql = (sql: string, ...params: NonNullable<Sql['params']>): Sql => ({ sql, params });
/** A failed predicate aborts the complete D1 batch/SQLite transaction. No guard table is portable authority. */
export const guard = (predicate: Sql): Sql => sql(`SELECT CASE WHEN (${predicate.sql}) THEN 1 ELSE json('RER_JOB_GUARD_REFUSED') END AS ok`, ...(predicate.params ?? []));
export function d1Database(database: D1Database): Database {
  const prepare = (statement: Sql) => database.prepare(statement.sql).bind(...(statement.params ?? []));
  return {
    async all<T>(statement: Sql) { return (await prepare(statement).all<T>()).results; },
    async atomic(statements) {
      const results = await database.batch(statements.map(prepare)) as { results?: Record<string, unknown>[]; success?: boolean }[];
      if (results.length !== statements.length || results.some(result => result.success === false)) throw new JobError('job_transaction_failed', 503);
      return results.map(result => result.results ?? []);
    },
  };
}
export async function one<T = Record<string, unknown>>(database: Database, statement: Sql): Promise<T | undefined> {
  return (await database.all<T>(statement))[0];
}
export async function atomic(database: Database, statements: Sql[], code = 'job_version_conflict'): Promise<void> {
  try { await database.atomic(statements); }
  catch (error) {
    if (String(error).includes('RER_JOB_GUARD_REFUSED') || String(error).includes('malformed JSON')) throw new JobError(code);
    throw error;
  }
}
