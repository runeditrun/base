import type { Context, Database, ErrorCode, Predicate, Result, Statement } from './types.ts';
import { context, Refusal, refuse } from './validation.ts';

export function statement(db: Database, value: Statement) { return db.prepare(value.sql).bind(...value.bindings); }
export function check(db: Database, guard: Predicate, code: 'authority' | 'revision' | 'native') {
  if (!guard || !guard.sql || guard.bindings.length > 80 || guard.sql.length > 8000) refuse('capacity');
  return db.prepare(`INSERT INTO co_assertions(id,${code}_ok) VALUES (?,CASE WHEN (${guard.sql}) THEN 1 ELSE 0 END)`).bind(crypto.randomUUID(), ...guard.bindings);
}
export async function allowed(db: Database, guard: Predicate, failure: ErrorCode): Promise<void> {
  const row = await db.prepare(`SELECT CASE WHEN (${guard.sql}) THEN 1 ELSE 0 END AS ok`).bind(...guard.bindings).first<{ ok: number }>();
  if (!row?.ok) refuse(failure);
}
/** A batch either commits every native + module effect or none. */
export async function batch(db: Database, values: ReturnType<Database['prepare']>[]): Promise<void> {
  try { await db.batch([...values, db.prepare('DELETE FROM co_assertions')]); }
  catch (e) {
    const message = String(e);
    if (message.includes('co_authority_guard')) refuse('authority_refused');
    if (message.includes('co_revision_guard')) refuse('revision_conflict');
    if (message.includes('co_native_guard')) refuse('native_conflict');
    throw e;
  }
}
export function publicCall<T>(ctx: Context, run: () => Promise<T>): Promise<Result<T>> {
  return (async () => {
    try { context(ctx); return { ok: true as const, value: await run() }; }
    catch (e) { return { ok: false as const, error: { code: e instanceof Refusal ? e.code : 'storage_failure' as const } }; }
  })();
}
