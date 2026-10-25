import { insist, JobError } from './codec.ts';
import { one, sql } from './database.ts';
import type { Context } from './storage.ts';
import type { Job } from './types.ts';

export const reconsiderable = new Set(['job_capacity_exhausted', 'job_revision_stale', 'job_authority_revoked', 'job_dependency_unavailable', 'job_handler_unsupported', 'job_checkpoint_corrupt', 'job_checkpoint_invalid', 'job_input_corrupt', 'job_revision_corrupt']);
export const holdRecovery = 'Restore current authority, exact revisions and compatible handler/checkpoint storage; bounded ticks reconsider this hold.';
export const capacityRecovery = 'Wait for a current unit to finish or cancel eligible work; no failure attempt was spent.';
export const exhaustedRecovery = 'Create a new reviewed intent after inspecting the partial committed outcome.';
export function exhaustedReason(context: Context, job: Job) {
  if (context.now() >= job.deadline) return 'job_deadline_exhausted';
  if (job.failures >= context.limits.maxFailureAttempts || job.starts >= context.limits.maxUnits + context.limits.maxFailureAttempts || job.progress.units >= context.limits.maxUnits) return 'job_attempts_exhausted';
}
export function capacityGuard(context: Context, job: Job) {
  const now = context.now();
  return sql(`(SELECT COUNT(*) FROM rer_job_leases WHERE installation_id=? AND expires_at>?)<? AND
    (SELECT COUNT(*) FROM rer_job_leases l JOIN rer_job_jobs j ON j.id=l.job_id AND j.installation_id=l.installation_id WHERE l.installation_id=? AND l.expires_at>? AND j.tenant_key=?)<? AND
    (SELECT COUNT(*) FROM rer_job_leases l JOIN rer_job_jobs j ON j.id=l.job_id AND j.installation_id=l.installation_id WHERE l.installation_id=? AND l.expires_at>? AND j.kind=?)<? AND
    (SELECT COUNT(*) FROM rer_job_leases l JOIN rer_job_jobs j ON j.id=l.job_id AND j.installation_id=l.installation_id WHERE l.installation_id=? AND l.expires_at>? AND j.source_key=?)<?`,
  context.installationId, now, context.limits.installationConcurrency, context.installationId, now, job.tenantId ?? '', context.limits.tenantConcurrency, context.installationId, now, job.kind, context.limits.kindConcurrency, context.installationId, now, job.sourceKey, context.limits.sourceConcurrency);
}
/** Read-only live checks shared by admission and held-job inspection. */
export async function admissionReason(context: Context, job: Job) {
  try {
    const kind = await context.compatible(job);
    insist(await kind.validateRevision(job), 'job_revision_stale');
    insist(await context.policy.authorize('claim', job), 'job_authority_revoked');
    for (const dependency of kind.dependencies) insist(await context.options.dependencies?.[dependency]?.(), 'job_dependency_unavailable', 503);
  } catch (error) { return error instanceof JobError ? error.code : 'job_checkpoint_invalid'; }
  const capacity = capacityGuard(context, job);
  if (!await one(context.database, sql(`SELECT 1 AS ok WHERE ${capacity.sql}`, ...capacity.params!))) return 'job_capacity_exhausted';
}
