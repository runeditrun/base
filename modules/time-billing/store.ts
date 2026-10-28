import type { Action, Authority, CommandResult, Context, Options, Resource, Sql, Write } from './types.ts';
import { demand, LIMITS, TimeBillingError } from './errors.ts';
import { projectEntry } from './projection.ts';
import { canonical, context, digest, identifier, json, sql } from './encoding.ts';
export type Environment = { options: Options; ctx: Context };
export const statement = (db: D1Database, query: Sql): D1PreparedStatement => {
  demand(query.sql.length <= 16000 && (query.params?.length ?? 0) <= LIMITS.sqlParameters, 'capacity');
  return db.prepare(query.sql).bind(...query.params ?? []);
};
export function guard(predicate: Sql, kind: 'authority' | 'revision' | 'custody' = 'revision'): Sql {
  return sql(`INSERT INTO tb_guards(${kind}) SELECT CASE WHEN (${predicate.sql}) THEN 1 ELSE 0 END`, ...predicate.params ?? []);
}
export async function batch(db: D1Database, queries: readonly Sql[]): Promise<void> {
  demand(queries.length <= 256, 'capacity');
  try { await db.batch([...queries, sql('DELETE FROM tb_guards')].map(q => statement(db, q))); }
  catch (error) {
    const message = String(error);
    if (/tb_forbidden/.test(message)) throw new TimeBillingError('forbidden');
    if (/tb_custody/.test(message)) throw new TimeBillingError('custody');
    if (/tb_conflict|UNIQUE constraint|tb_immutable/.test(message)) throw new TimeBillingError('conflict');
    throw new TimeBillingError('storage', 'D1 transaction refused');
  }
}
export async function authorize(env: Environment, action: Action, resource: Resource, financial = false): Promise<Authority> {
  context(env.ctx); identifier(resource.subject);
  const a = await env.options.authorize(env.ctx, action, resource); identifier(a.policyRevision);
  demand(a.projection === 'time' || a.projection === 'financial', 'forbidden');
  demand(!financial || a.projection === 'financial', 'forbidden');
  return a;
}
export async function authorizedRows<T>(env: Environment, authority: Authority, query: Sql): Promise<T[]> {
  const results = await env.options.database.batch([
    statement(env.options.database, sql(`SELECT CASE WHEN (${authority.predicate.sql}) THEN 1 ELSE 0 END AS ok`, ...authority.predicate.params ?? [])),
    statement(env.options.database, query),
  ]);
  demand((results[0].results[0] as { ok: number })?.ok === 1, 'forbidden');
  return results[1].results as T[];
}
export async function load<T>(env: Environment, table: 'tb_entries' | 'tb_timers' | 'tb_packets', id: string): Promise<T> {
  identifier(id);
  const row = await env.options.database.prepare(`SELECT body FROM ${table} WHERE installation=? AND id=?`).bind(env.ctx.installationId, id).first<{body: string}>();
  demand(row, 'not_found'); return JSON.parse(row.body) as T;
}
export const fence = (env: Environment, table: 'tb_entries' | 'tb_timers' | 'tb_packets', id: string, revision: number): Sql =>
  sql(`EXISTS(SELECT 1 FROM ${table} WHERE installation=? AND id=? AND revision=?)`, env.ctx.installationId, id, revision);
export const event = (env: Environment, resource: Resource, body: unknown): Sql => sql('INSERT INTO tb_events(installation,work_kind,work_id,body) VALUES(?,?,?,?)', env.ctx.installationId, resource.work.kind, resource.work.id, json(body));
const actor = (ctx: Context) => canonical({ personId: ctx.personId, agentId: ctx.agentId ?? null, sponsorId: ctx.sponsorId ?? null });
export type Prepared<T> = { result: T; queries: Sql[] };
/** One operation writer. Replay checks current authority but never repeats native outcomes. */
export async function command<T extends CommandResult | {restored: true}>(env: Environment, action: Action, resource: Resource, input: Write, financial: boolean,
  prepare: (authority: Authority) => Promise<Prepared<T>>): Promise<T> {
  context(env.ctx); identifier(input.operationKey);
  demand(input.operationKey.length <= LIMITS.operationLength && Number.isSafeInteger(input.expectedRevision) && input.expectedRevision >= 0);
  const authority = await authorize(env, action, resource, financial);
  const present = (value: T): T => value && typeof value === 'object' && 'kind' in value && (value.kind === 'entry' || value.kind === 'legacy') ? projectEntry(value as unknown as import('./types.ts').EntryRecord, authority.projection) as T : value;
  const payload = await digest(json(input)), keys = [env.ctx.installationId, actor(env.ctx), resource.subject, action, input.operationKey];
  const replay = async (): Promise<T | undefined> => {
    const rows = await authorizedRows<{payload: string; result: string}>(env, authority, sql('SELECT payload,result FROM tb_commands WHERE installation=? AND actor=? AND subject=? AND action=? AND operation_key=?', ...keys));
    if (!rows.length) return undefined;
    demand(rows[0].payload === payload, 'conflict', 'operation key reused with changed content');
    return present(JSON.parse(rows[0].result) as T);
  };
  const existing = await replay(); if (existing !== undefined) return existing;
  const prepared = await prepare(authority);
  const outcome = action === 'restoreRecords' ? [] : await env.options.nativeOutcome?.({ action, context: env.ctx, operationKey: input.operationKey, subject: resource.subject, result: prepared.result as CommandResult }) ?? [];
  demand(outcome.length <= LIMITS.nativeStatements, 'capacity');
  try {
    await batch(env.options.database, [guard(authority.predicate, 'authority'),
      sql('INSERT INTO tb_commands(installation,actor,subject,action,operation_key,payload,result) VALUES(?,?,?,?,?,?,?)', ...keys, payload, json(prepared.result)),
      ...prepared.queries, ...outcome,
      event(env, resource, { action, context: env.ctx, operationKey: input.operationKey, subject: resource.subject, payload, result: prepared.result, authority: authority.policyRevision }),
    ]);
  } catch (error) {
    if (error instanceof TimeBillingError && error.code === 'conflict') { const recovered = await replay(); if (recovered !== undefined) return recovered; }
    throw error;
  }
  return present(prepared.result);
}
