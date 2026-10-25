import { sql } from './database.ts';
import { Context, type Control } from './storage.ts';

/** Separate ready work from a restart-safe, keyset-paged reconsideration of
 * holds. Advancing the cursor shares the scheduler heartbeat; it never rewrites
 * a held job, consumes an attempt, or walks all of the held backlog. */
export async function admissionPage(context: Context, control: Control): Promise<string[]> {
  const now = context.now(), limit = context.limits.maxList;
  const ready = await context.database.all<{ id: string }>(sql("SELECT j.id FROM rer_job_jobs j JOIN rer_job_activations a ON a.installation_id=j.installation_id AND a.job_id=j.id AND a.epoch=? WHERE j.installation_id=? AND j.state IN ('queued','retry_wait') AND j.cancel_requested=0 AND j.not_before<=? ORDER BY j.not_before,j.created_at,j.id LIMIT ?", control.epoch, context.installationId, now, limit));
  const after = await context.database.all<{ id: string }>(sql("SELECT id FROM rer_job_jobs WHERE installation_id=? AND state='waiting' AND id>? ORDER BY id LIMIT ?", context.installationId, control.admission_cursor, limit));
  const before = after.length < limit ? await context.database.all<{ id: string }>(sql("SELECT id FROM rer_job_jobs WHERE installation_id=? AND state='waiting' AND id<=? ORDER BY id LIMIT ?", context.installationId, control.admission_cursor, limit - after.length)) : [];
  const held = [...after, ...before];
  await context.database.atomic([
    sql('UPDATE rer_job_control SET heartbeat=?,updated_at=?,admission_cursor=? WHERE installation_id=? AND epoch=?', now, now, held.at(-1)?.id ?? '', context.installationId, control.epoch),
    // Expiry must advance even when ready work consumes every execution slot.
    // json_each binds only this bounded page, never the whole held backlog.
    sql("UPDATE rer_job_jobs SET state='failed',reason_code='job_deadline_exhausted',recovery=?,version=version+1,updated_at=? WHERE installation_id=? AND state='waiting' AND deadline<=? AND id IN (SELECT value FROM json_each(?)) AND EXISTS(SELECT 1 FROM rer_job_activations a WHERE a.installation_id=rer_job_jobs.installation_id AND a.job_id=rer_job_jobs.id AND a.epoch=?)", 'Create a new reviewed intent after inspecting the partial committed outcome.', now, context.installationId, now, JSON.stringify(held.map(row => row.id)), control.epoch),
  ]);
  // Share slots with reconsidered work. At a cursor wrap it goes first, so
  // even a one-slot runtime makes progress under a continuous ready backlog.
  const first = after.length < limit ? held : ready, second = after.length < limit ? ready : held;
  return Array.from({ length: Math.max(first.length, second.length) }, (_, i) => [first[i]?.id, second[i]?.id]).flat().filter((id): id is string => id !== undefined);
}
