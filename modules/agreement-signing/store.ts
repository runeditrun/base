import { boundedJson, canonical, limits, seal, sha256, unseal } from './encoding.ts';
import { requireThat, SigningError } from './errors.ts';
import type { ActionRecord, AuditEvent, CommandContext, ExecutionRecord, LegacyRecord, NativeOperation, ReadContext, RequestRecord, SigningOptions, Sql, SqlValue } from './types.ts';
export interface RequestRow {
  id: string; record_kind: 'native' | 'legacy'; definition: string | null; legacy: string | null;
  state: RequestRecord['state']; revision: number; created_at: string; restored: number; root: string | null; completed_artifacts: string;
}
interface CommandRow { id: string; payload_digest: string; result: string; sealed: number; request_id: string }
export function sql(sql: string, ...params: SqlValue[]): Sql { return { sql, params }; }
export function and(...parts: Sql[]): Sql {
  return { sql: parts.map(part => `COALESCE((${part.sql}),0)`).join(' AND ') || '1', params: parts.flatMap(part => [...part.params ?? []]) };
}
export function native(row: RequestRow): RequestRecord {
  requireThat(row.record_kind === 'native', 'legacy_read_only');
  return { recordKind: 'native', id: row.id, revision: row.revision, definition: JSON.parse(row.definition!), state: row.state,
    createdAt: row.created_at, restored: !!row.restored, root: row.root, completedArtifacts: JSON.parse(row.completed_artifacts) };
}
export function record(row: RequestRow): RequestRecord | LegacyRecord {
  return row.record_kind === 'native' ? native(row) : { ...JSON.parse(row.legacy!), restored: !!row.restored };
}
export class Store {
  readonly options: SigningOptions;
  constructor(options: SigningOptions) { this.options = options; }
  now(): string { return new Date().toISOString(); }
  statement(query: Sql) { return this.options.database.prepare(query.sql).bind(...query.params ?? []); }
  async first<T>(query: Sql): Promise<T | null> { return this.statement(query).first<T>(); }
  async rows<T>(query: Sql): Promise<T[]> { return (await this.statement(query).all<T>()).results; }
  async row(id: string): Promise<RequestRow> {
    const row = await this.first<RequestRow>(sql('SELECT * FROM as_requests WHERE id=?', id));
    requireThat(row, 'not_found'); return row;
  }
  async request(id: string): Promise<RequestRecord> { return native(await this.row(id)); }
  async allowed(guard: Sql): Promise<void> {
    const result = await this.first<{ ok: number }>(sql(`SELECT CASE WHEN (${guard.sql}) THEN 1 ELSE 0 END AS ok`, ...guard.params ?? []));
    requireThat(result?.ok === 1, 'unauthorized');
  }
  async authority(ctx: ReadContext): Promise<void> { await this.allowed(ctx.authority); }
  async source(ctx: ReadContext, request: RequestRecord, operation: NativeOperation): Promise<Sql> {
    return and(ctx.authority, await this.options.sourceGuard(ctx, request.definition, operation));
  }
  async commandId(ctx: CommandContext, operation: string): Promise<string> {
    return 'asc_' + await sha256(canonical([ctx.actorId, operation, ctx.operationKey]));
  }
  async replay<T>(ctx: CommandContext, operation: NativeOperation, payload: unknown, extra?: (request: RequestRecord) => Promise<Sql>): Promise<T | null> {
    const row = await this.first<CommandRow>(sql('SELECT * FROM as_commands WHERE actor_id=? AND operation=? AND operation_key=?', ctx.actorId, operation, ctx.operationKey));
    if (!row) return null;
    await this.authority(ctx);
    requireThat(row.payload_digest === await sha256(boundedJson(payload)), 'replay_mismatch');
    const request = await this.request(row.request_id);
    requireThat(!request.restored, 'restored_inert');
    await this.allowed(and(await this.source(ctx, request, operation), extra ? await extra(request) : sql('1')));
    return row.sealed ? unseal<T>(this.options.credentialKey, row.result, row.id) : JSON.parse(row.result) as T;
  }
  assert(guard: Sql): Sql[] {
    return [sql(`INSERT INTO as_transaction_guard(ok) VALUES(CASE WHEN (${guard.sql}) THEN 1 ELSE 0 END)`, ...guard.params ?? []), sql('DELETE FROM as_transaction_guard')];
  }
  async batch(queries: readonly Sql[]): Promise<void> { await this.options.database.batch(queries.map(query => this.statement(query))); }
  async actions(id: string): Promise<ActionRecord[]> { return (await this.rows<{ payload: string }>(sql('SELECT payload FROM as_actions WHERE request_id=? ORDER BY id', id))).map(row => JSON.parse(row.payload)); }
  async events(id: string): Promise<AuditEvent[]> {
    return (await this.rows<{ sequence: number; digest: string; previous: string | null; payload: string }>(sql('SELECT * FROM as_events WHERE request_id=? ORDER BY sequence', id)))
      .map(row => ({ sequence: row.sequence, previous: row.previous, digest: row.digest, algorithm: 'sha256-canonical-json-v1', payload: JSON.parse(row.payload) }));
  }
  async commit<T>(input: {
    ctx: CommandContext; operation: NativeOperation; payload: unknown; before: RequestRecord | null; after: RequestRecord;
    guard: Sql; writes: Sql[]; result: (request: RequestRecord) => T;
    action?: ActionRecord; execution?: ExecutionRecord; detail?: AuditEvent['payload']['detail']; secret?: boolean;
  }): Promise<T> {
    const { ctx, operation, before, after } = input;
    const sequence = before ? before.revision + 1 : 1;
    requireThat(sequence <= limits.events, 'capacity');
    const commandId = await this.commandId(ctx, operation);
    const payload: AuditEvent['payload'] = { operation, actorId: ctx.actorId, agent: ctx.agent, at: this.now(), commandId,
      request: { ...after, revision: sequence, root: before?.root ?? null }, action: input.action ?? null, execution: input.execution ?? null, detail: input.detail ?? null };
    const previous = before?.root ?? null;
    const digest = await sha256(canonical({ sequence, previous, algorithm: 'sha256-canonical-json-v1', payload }));
    const request: RequestRecord = { ...after, revision: sequence, root: digest };
    const result = input.result(request);
    const serialized = input.secret ? await seal(this.options.credentialKey, result, commandId) : boundedJson(result);
    const nativeWrites = await this.options.nativeCommit({ operation, commandId, request, action: input.action ?? null, execution: input.execution ?? null });
    requireThat(nativeWrites.length <= limits.nativeStatements, 'capacity');
    const fence = before ? sql('EXISTS(SELECT 1 FROM as_requests WHERE id=? AND revision=? AND restored=0 AND root IS ?)', before.id, before.revision, before.root) : sql('NOT EXISTS(SELECT 1 FROM as_requests WHERE id=?)', request.id);
    try {
      await this.batch([
        ...this.assert(and(input.guard, fence)), ...input.writes,
        sql('UPDATE as_requests SET state=?,revision=?,root=?,completed_artifacts=? WHERE id=?', request.state, request.revision, request.root, canonical(request.completedArtifacts), request.id),
        ...this.assert(sql('changes()=1')),
        sql('INSERT INTO as_events(request_id,sequence,digest,previous,payload) VALUES(?,?,?,?,?)', request.id, sequence, digest, previous, boundedJson(payload)),
        sql('INSERT INTO as_commands(id,actor_id,operation,operation_key,payload_digest,request_id,result,sealed,guard) VALUES(?,?,?,?,?,?,?,?,1)', commandId, ctx.actorId, operation, ctx.operationKey, await sha256(boundedJson(input.payload)), request.id, serialized, input.secret ? 1 : 0),
        ...nativeWrites, ...this.assert(ctx.authority),
      ]);
    } catch (error) {
      // A competing identical command may have committed while artifacts were rendering.
      // The caller rechecks its participant guard when recovering this outcome.
      if (error instanceof Error && /constraint|immutable|CHECK|UNIQUE|FOREIGN KEY/i.test(error.message)) throw new SigningError('conflict');
      throw error;
    }
    return result;
  }
}
export function active(request: RequestRecord, at: string): void {
  requireThat(!request.restored, 'restored_inert');
  requireThat(['issued', 'in-progress'].includes(request.state), 'closed');
  requireThat(request.definition.expiresAt === null || request.definition.expiresAt > at, 'expired');
}
export function unexpired(request: RequestRecord): Sql {
  return sql("EXISTS(SELECT 1 FROM as_requests WHERE id=? AND (json_extract(definition,'$.expiresAt') IS NULL OR julianday(json_extract(definition,'$.expiresAt'))>julianday('now')))", request.id);
}
export function invalidate(id: string): Sql[] {
  return [sql('UPDATE as_credentials SET revoked=1 WHERE request_id=?', id), sql("UPDATE as_reviews SET used_at=COALESCE(used_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE request_id=?", id)];
}
