import { sql } from './database.ts';
import { Context, type Control } from './storage.ts';

/** Separate ready work from a restart-safe, keyset-paged reconsideration of
 * holds. Advancing the cursor shares the scheduler heartbeat; it never rewrites
 * a held job, consumes an attempt, or walks all of the held backlog. */
export async function admissionPage(context: Context, control: Control): Promise<string[]> {
  const now = context.now(), limit = context.limits.maxList;
  const ready = await context.database.all<{ id: string }>(sql("SELECT id FROM rer_job_jobs WHERE installation_id=? AND state IN ('queued','retry_wait') AND cancel_requested=0 AND not_before<=? ORDER BY not_before,created_at,id LIMIT ?", context.installationId, now, limit));
  const after = await context.database.all<{ id: string }>(sql("SELECT id FROM rer_job_jobs WHERE installation_id=? AND state='waiting' AND id>? ORDER BY id LIMIT ?", context.installationId, control.admission_cursor, limit));
  const before = after.length < limit ? await context.database.all<{ id: string }>(sql("SELECT id FROM rer_job_jobs WHERE installation_id=? AND state='waiting' AND id<=? ORDER BY id LIMIT ?", context.installationId, control.admission_cursor, limit - after.length)) : [];
  const held = [...after, ...before];
  await context.database.atomic([sql('UPDATE rer_job_control SET heartbeat=?,updated_at=?,admission_cursor=? WHERE installation_id=? AND epoch=?', now, now, held.at(-1)?.id ?? '', context.installationId, control.epoch)]);
  return [...ready, ...held].map(row => row.id);
}
