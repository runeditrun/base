import { insist, text } from './codec.ts';
import { sql } from './database.ts';
import { Context, type Row } from './storage.ts';
import type { Authority, Job } from './types.ts';

/** Status never returns raw input, SQL, handler paths or opaque claim credentials. */
export function safeJob(job: Job) {
  const { inputRef: _input, checkpoint: _checkpoint, ...safe } = job;
  return { ...safe, undo: { supported: false, reasonCode: 'undo_unsupported' },
    checkpoint: { sequence: job.checkpointSequence, digest: job.checkpointHash },
    resultAvailability: job.resultAvailability ?? (job.state === 'succeeded' ? 'available' : 'unavailable') };
}
export async function list(context: Context, filters: { kind?: string; state?: string; cursor?: string; limit?: number }, authority: Authority) {
  await context.schema(); context.scope(authority);
  insist(await context.policy.authorizeScope(authority), 'job_not_found', 404);
  if (filters.kind !== undefined) insist(context.kinds.has(filters.kind), 'job_invalid_kind');
  if (filters.state !== undefined) insist(['queued','running','waiting','retry_wait','cancelling','cancelled','succeeded','failed','uncertain'].includes(filters.state), 'job_invalid_state');
  const limit = filters.limit ?? context.limits.maxList;
  insist(Number.isSafeInteger(limit) && limit > 0 && limit <= context.limits.maxList, 'job_invalid_limit');
  let cursor: [number, string] = [0, ''];
  if (filters.cursor !== undefined) {
    text(filters.cursor, 'cursor', 400);
    try { cursor = JSON.parse(atob(filters.cursor)); } catch { insist(false, 'job_invalid_cursor'); }
    insist(Array.isArray(cursor) && cursor.length === 2 && Number.isSafeInteger(cursor[0]) && typeof cursor[1] === 'string' && cursor[1].length <= 200, 'job_invalid_cursor');
  }
  // Always scope in SQL, before pagination; filtering foreign metadata in a caller is too late.
  const rows = await context.database.all<Row>(sql(`SELECT * FROM rer_job_jobs WHERE installation_id=? AND namespace=? AND tenant_key=? ${authority.operator ? '' : 'AND principal_id=?'} AND (created_at>? OR (created_at=? AND id>?)) ${filters.kind ? 'AND kind=?' : ''} ORDER BY created_at,id LIMIT ?`, context.installationId, authority.namespace, authority.tenantId ?? '', ...(authority.operator ? [] : [authority.principalId]), cursor[0], cursor[0], cursor[1], ...(filters.kind ? [filters.kind] : []), limit + 1));
  const jobs = [];
  for (const row of rows.slice(0, limit)) {
    const job = await context.job(row);
    if (await context.policy.authorize('read', job, authority) && (!filters.state || job.state === filters.state)) jobs.push(safeJob(await context.project(job, authority)));
  }
  const last = rows[Math.min(limit, rows.length) - 1];
  return { jobs, cursor: rows.length > limit && last ? btoa(JSON.stringify([Number(last.created_at), String(last.id)])) : null };
}
export async function status(context: Context, authority: Authority) {
  await context.schema(); context.scope(authority);
  insist(await context.policy.authorizeScope(authority), 'job_not_found', 404);
  // Aggregate indexed scope metadata, never the unbounded history payloads.
  const rows = await context.database.all<{ state: string; reason: string | null; n: number; oldest: number | null }>(sql(`
    WITH scoped AS (SELECT j.state,j.reason_code,j.created_at,j.not_before,
      CASE WHEN a.job_id IS NULL THEN 0 ELSE 1 END AS active,c.mode
      FROM rer_job_jobs j LEFT JOIN rer_job_control c ON c.installation_id=j.installation_id
      LEFT JOIN rer_job_activations a ON a.installation_id=j.installation_id AND a.job_id=j.id AND a.epoch=c.epoch AND a.principal_id=j.principal_id AND a.owner_id=j.owner_id
      WHERE j.installation_id=? AND j.namespace=? AND j.tenant_key=? ${authority.operator ? '' : 'AND j.principal_id=?'}),
    effective AS (SELECT CASE WHEN state IN ('succeeded','failed','cancelled','uncertain') THEN state WHEN active=0 OR mode<>'running' THEN 'waiting' ELSE state END AS state,
      CASE WHEN state IN ('succeeded','failed','cancelled','uncertain') THEN reason_code WHEN active=0 THEN 'restored_requires_reauthorization' WHEN mode<>'running' THEN 'scheduler_unconfigured' ELSE reason_code END AS reason,created_at,not_before FROM scoped)
    SELECT state,reason,count(*) AS n,MIN(CASE WHEN state='queued' AND not_before<=? THEN created_at END) AS oldest FROM effective GROUP BY state,reason`, context.installationId, authority.namespace, authority.tenantId ?? '', ...(authority.operator ? [] : [authority.principalId]), context.now()));
  const counts: Record<string, number> = {}; const held: Record<string, number> = {};
  let oldest: number | null = null;
  for (const row of rows) {
    counts[row.state] = (counts[row.state] ?? 0) + Number(row.n);
    if (row.state === 'waiting' && row.reason) held[row.reason] = (held[row.reason] ?? 0) + Number(row.n);
    if (row.oldest !== null) oldest = oldest === null ? Number(row.oldest) : Math.min(oldest, Number(row.oldest));
  }
  const control = await context.control();
  const heartbeatAge = control ? Math.max(0, context.now() - control.heartbeat) : null;
  const schedulerState = control?.mode !== 'running' ? 'degraded' : heartbeatAge !== null && heartbeatAge <= context.limits.leaseMs ? 'ok' : 'unknown';
  const active = await context.database.all<{ n: number }>(sql(`SELECT COUNT(*) AS n FROM rer_job_leases l JOIN rer_job_jobs j ON j.id=l.job_id AND j.installation_id=l.installation_id WHERE l.installation_id=? AND j.namespace=? AND j.tenant_key=? ${authority.operator ? '' : 'AND j.principal_id=?'} AND l.expires_at>?`, context.installationId, authority.namespace, authority.tenantId ?? '', ...(authority.operator ? [] : [authority.principalId]), context.now()));
  return { schemaVersion: 1 as const, status: { installationId: context.installationId, counts, held,
    oldestReadyAgeMs: oldest === null ? null : Math.max(0, context.now() - oldest), active: Number(active[0]?.n ?? 0),
    limits: { installationConcurrency: context.limits.installationConcurrency, tenantConcurrency: context.limits.tenantConcurrency, kindConcurrency: context.limits.kindConcurrency, sourceConcurrency: context.limits.sourceConcurrency, maxQueued: context.limits.maxQueued },
    scheduler: { configured: !!control, mode: control?.mode ?? 'paused', adapter: control?.scheduler ?? context.options.scheduler, heartbeatAgeMs: heartbeatAge },
    components: { 'jobs.store': { state: 'ok', checkedAt: context.now() }, 'jobs.scheduler': { state: schedulerState, code: control?.mode !== 'running' ? 'scheduler_unconfigured' : schedulerState === 'unknown' ? 'scheduler_heartbeat_stale' : null, recovery: 'Inspect the declared native runtime and its next scheduled tick; stopped work resumes on the next start.' } } } };
}
