import { digest, identifier, insist, JobError, text } from './codec.ts';
import { atomic, guard, one, sql } from './database.ts';
import { initializeControl } from './intent.ts';
import { Context, type Control, type Row } from './storage.ts';
import type { Claim, Job, Sql } from './types.ts';
import { admissionPage } from './admission.ts';

const reconsiderable = new Set(['job_capacity_exhausted', 'job_revision_stale', 'job_authority_revoked', 'job_dependency_unavailable', 'job_handler_unsupported', 'job_checkpoint_corrupt', 'job_checkpoint_invalid', 'job_input_corrupt', 'job_revision_corrupt']);

export function activation(context: Context, job: Job, epoch: string): Sql {
  return sql("EXISTS(SELECT 1 FROM rer_job_activations a JOIN rer_job_control c ON c.installation_id=a.installation_id AND c.epoch=a.epoch WHERE a.installation_id=? AND a.job_id=? AND a.epoch=? AND a.principal_id=? AND a.owner_id=? AND c.mode='running')", context.installationId, job.id, epoch, job.principalId, job.ownerId);
}
export async function reconcile(context: Context, holder?: string): Promise<void> {
  const now = context.now();
  const selection = holder === undefined ? sql('expires_at<=?', now) : sql('(expires_at<=? OR holder=?)', now, holder);
  await context.database.atomic([
    sql(`UPDATE rer_job_attempts SET ended_at=?,classification='interrupted' WHERE installation_id=? AND ended_at IS NULL AND job_id IN (SELECT job_id FROM rer_job_leases WHERE installation_id=? AND ${selection.sql})`, now, context.installationId, context.installationId, ...(selection.params ?? [])),
    sql(`UPDATE rer_job_jobs SET state=CASE WHEN cancel_requested=1 THEN 'cancelled' ELSE 'queued' END,version=version+1,fence=fence+1,updated_at=? WHERE installation_id=? AND state='running' AND id IN (SELECT job_id FROM rer_job_leases WHERE installation_id=? AND ${selection.sql})`, now, context.installationId, context.installationId, ...(selection.params ?? [])),
    sql(`DELETE FROM rer_job_leases WHERE installation_id=? AND ${selection.sql}`, context.installationId, ...(selection.params ?? [])),
  ]);
}
export async function start(context: Context, options: { holder: string; replaceHolder?: string }): Promise<void> {
  text(options.holder, 'holder'); await initializeControl(context); const control = await context.control(); insist(control, 'job_schema_required', 503);
  insist(control.holder === null || control.holder === options.holder || control.holder === options.replaceHolder, 'job_runtime_custody_conflict');
  await atomic(context.database, [
    guard(sql('EXISTS(SELECT 1 FROM rer_job_control WHERE installation_id=? AND epoch=? AND (holder IS NULL OR holder=? OR holder=?))', context.installationId, control.epoch, options.holder, options.replaceHolder ?? options.holder)),
    sql("UPDATE rer_job_control SET mode='running',scheduler=?,holder=?,heartbeat=?,updated_at=? WHERE installation_id=?", context.options.scheduler, options.holder, context.now(), context.now(), context.installationId),
  ], 'job_runtime_custody_conflict');
  if (control.holder && control.holder !== options.holder) await reconcile(context, control.holder);
  await reconcile(context);
}
export async function quiesce(context: Context, options: { holder: string }): Promise<void> {
  await context.schema(); const now = context.now();
  await atomic(context.database, [
    guard(sql('EXISTS(SELECT 1 FROM rer_job_control WHERE installation_id=? AND holder=?)', context.installationId, options.holder)),
    sql("UPDATE rer_job_control SET mode='paused',holder=NULL,updated_at=? WHERE installation_id=?", now, context.installationId),
    sql("UPDATE rer_job_attempts SET ended_at=?,classification='interrupted' WHERE installation_id=? AND ended_at IS NULL", now, context.installationId),
    sql("UPDATE rer_job_jobs SET state=CASE WHEN cancel_requested=1 THEN 'cancelled' ELSE 'queued' END,version=version+1,fence=fence+1,updated_at=? WHERE installation_id=? AND state='running'", now, context.installationId),
    sql('DELETE FROM rer_job_leases WHERE installation_id=?', context.installationId),
  ], 'job_runtime_custody_conflict');
}
export async function hold(context: Context, job: Job, reason: string, recovery: string, state = 'waiting'): Promise<void> {
  // Repeated wake-ups at a capacity or person hold do not append attempts or churn versions.
  await context.database.atomic([sql("UPDATE rer_job_jobs SET state=?,reason_code=?,recovery=?,version=version+1,updated_at=? WHERE installation_id=? AND id=? AND version=? AND (state<>? OR reason_code IS NOT ? OR recovery IS NOT ?)", state, reason, recovery, context.now(), context.installationId, job.id, job.version, state, reason, recovery)]);
}
export async function claim(context: Context, options: { id?: string; holder?: string } = {}, admissionControl?: Control): Promise<Claim | null> {
  if (!admissionControl) { await context.schema(); await reconcile(context); }
  const control = admissionControl ?? await context.control();
  if (!control || control.mode !== 'running') throw new JobError('scheduler_unconfigured', 503, 'Start the declared installation runtime.');
  const now = context.now(), holder = text(options.holder ?? control.holder ?? 'bounded-tick', 'holder');
  const ids = options.id ? [options.id] : await admissionPage(context, control);
  const rows: Row[] = [];
  for (const id of ids) rows.push(...await context.database.all<Row>(sql("SELECT j.* FROM rer_job_jobs j JOIN rer_job_activations a ON a.job_id=j.id AND a.installation_id=j.installation_id AND a.epoch=? WHERE j.installation_id=? AND j.id=? AND j.state IN ('queued','retry_wait','waiting') AND j.cancel_requested=0 AND j.not_before<=?", control.epoch, context.installationId, id, now)));
  for (const row of rows) {
    const job = await context.job(row, false);
    if (now >= job.deadline || job.failures >= context.limits.maxFailureAttempts || job.starts >= context.limits.maxUnits + context.limits.maxFailureAttempts || job.progress.units >= context.limits.maxUnits) {
      await hold(context, job, now >= job.deadline ? 'job_deadline_exhausted' : 'job_attempts_exhausted', 'Create a new reviewed intent after inspecting the partial committed outcome.', 'failed'); continue;
    }
    // Only holds whose condition is checked below can wake automatically.
    // A handler's explicit wait or proof failure still needs repaired input and
    // an authorized resume, without probing it by spending another attempt.
    if (job.state === 'waiting' && !reconsiderable.has(job.reasonCode ?? '')) continue;
    try {
      const kind = await context.compatible(job);
      insist(await kind.validateRevision(job), 'job_revision_stale');
      insist(await context.policy.authorize('claim', job), 'job_authority_revoked');
      for (const dependency of kind.dependencies) insist(await context.options.dependencies?.[dependency]?.(), 'job_dependency_unavailable', 503);
    } catch (error) {
      await hold(context, job, error instanceof JobError ? error.code : 'job_checkpoint_invalid', 'Restore current authority, exact revisions and compatible handler/checkpoint storage; bounded ticks reconsider this hold.'); continue;
    }
    const token = identifier() + identifier(), tokenHash = await digest(token), fence = job.fence + 1, version = job.version + 1, expiresAt = now + context.limits.leaseMs;
    const capacity = sql(`(SELECT COUNT(*) FROM rer_job_leases WHERE installation_id=? AND expires_at>?)<? AND
      (SELECT COUNT(*) FROM rer_job_leases l JOIN rer_job_jobs j ON j.id=l.job_id AND j.installation_id=l.installation_id WHERE l.installation_id=? AND l.expires_at>? AND j.tenant_key=?)<? AND
      (SELECT COUNT(*) FROM rer_job_leases l JOIN rer_job_jobs j ON j.id=l.job_id AND j.installation_id=l.installation_id WHERE l.installation_id=? AND l.expires_at>? AND j.kind=?)<? AND
      (SELECT COUNT(*) FROM rer_job_leases l JOIN rer_job_jobs j ON j.id=l.job_id AND j.installation_id=l.installation_id WHERE l.installation_id=? AND l.expires_at>? AND j.source_key=?)<?`,
    context.installationId, now, context.limits.installationConcurrency, context.installationId, now, job.tenantId ?? '', context.limits.tenantConcurrency, context.installationId, now, job.kind, context.limits.kindConcurrency, context.installationId, now, job.sourceKey, context.limits.sourceConcurrency);
    const predicates = context.predicates('claim', job);
    try {
      await atomic(context.database, [
        ...predicates.map(guard), guard(activation(context, job, control.epoch)),
        guard(sql("EXISTS(SELECT 1 FROM rer_job_jobs WHERE installation_id=? AND id=? AND version=? AND state IN ('queued','retry_wait','waiting') AND cancel_requested=0 AND deadline>?)", context.installationId, job.id, job.version, now)),
        guard(capacity),
        sql("UPDATE rer_job_jobs SET state='running',reason_code=NULL,recovery=NULL,version=?,fence=?,starts=starts+1,updated_at=? WHERE installation_id=? AND id=?", version, fence, now, context.installationId, job.id),
        sql('INSERT INTO rer_job_leases(installation_id,job_id,token_hash,holder,epoch,fence,expires_at,heartbeat) VALUES(?,?,?,?,?,?,?,?)', context.installationId, job.id, tokenHash, holder, control.epoch, fence, expiresAt, now),
        sql("INSERT INTO rer_job_attempts(id,installation_id,job_id,unit_sequence,fence,started_at,classification) VALUES(?,?,?,?,?,?,'running')", identifier(), context.installationId, job.id, job.checkpointSequence, fence, now),
        ...predicates.map(guard), guard(activation(context, job, control.epoch)),
      ], 'job_claim_refused');
    } catch (error) {
      if (!(error instanceof JobError)) throw error;
      const current = await context.row(job.id);
      if (current?.version === job.version && !(await one(context.database, sql(`SELECT 1 AS ok WHERE ${capacity.sql}`, ...(capacity.params ?? []))))) await hold(context, job, 'job_capacity_exhausted', 'Wait for a current unit to finish or cancel eligible work; no failure attempt was spent.');
      continue;
    }
    return { job: { ...job, state: 'running', reasonCode: null, recovery: null, version, fence, starts: job.starts + 1 }, token, epoch: control.epoch, holder, expiresAt };
  }
  return null;
}
export async function leaseGuard(context: Context, claim: Claim): Promise<Sql> {
  const tokenHash = await digest(claim.token), clock = commitClock(context);
  return sql(`EXISTS(SELECT 1 FROM rer_job_jobs j JOIN rer_job_leases l ON l.job_id=j.id AND l.installation_id=j.installation_id WHERE j.installation_id=? AND j.id=? AND j.state='running' AND j.cancel_requested=0 AND j.version=? AND j.fence=? AND l.token_hash=? AND l.fence=j.fence AND l.epoch=? AND l.expires_at>(${clock.sql}) AND j.deadline>(${clock.sql}))`, context.installationId, claim.job.id, claim.job.version, claim.job.fence, tokenHash, claim.epoch, ...clock.params!, ...clock.params!);
}

// Retain the caller's clock (including supported skew), while accounting for
// time spent awaiting/performing the actual SQLite transaction or D1 batch.
export function commitClock(context: Context): Sql {
  return sql("(? + MAX(0,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)-?))", context.now(), Date.now());
}
