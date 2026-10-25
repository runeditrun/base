import { identifier } from './codec.ts';
import { sql } from './database.ts';
import { Context, type Control } from './storage.ts';

/** A bounded held lane and a separate ready lane. The cursor is committed only
 * through examined entries. A nonce prevents a slow consumer's stale CAS from
 * rewinding a cursor that has since made a complete circuit. */
export async function admissionPage(context: Context, control: Control) {
  const now = context.now(), limit = context.limits.maxList;
  let cursor = control.admission_cursor, readyFirst = false;
  try {
    const saved = JSON.parse(cursor);
    if (Array.isArray(saved) && saved.length === 3 && typeof saved[0] === 'string' && typeof saved[1] === 'boolean' && typeof saved[2] === 'string') [cursor, readyFirst] = saved;
  } catch { /* Existing cursors are plain keyset IDs. */ }
  const ready = await context.database.all<{ id: string }>(sql("SELECT j.id FROM rer_job_jobs j JOIN rer_job_activations a ON a.installation_id=j.installation_id AND a.job_id=j.id AND a.epoch=? WHERE j.installation_id=? AND j.state IN ('queued','retry_wait') AND j.cancel_requested=0 AND j.not_before<=? ORDER BY j.not_before,j.created_at,j.id LIMIT ?", control.epoch, context.installationId, now, limit));
  const after = await context.database.all<{ id: string }>(sql("SELECT id FROM rer_job_jobs WHERE installation_id=? AND state='waiting' AND id>? ORDER BY id LIMIT ?", context.installationId, cursor, limit));
  const before = after.length < limit ? await context.database.all<{ id: string }>(sql("SELECT id FROM rer_job_jobs WHERE installation_id=? AND state='waiting' AND id<=? ORDER BY id LIMIT ?", context.installationId, cursor, limit - after.length)) : [];
  let examined = cursor;
  return {
    ready: ready.map(row => row.id), held: [...after, ...before].map(row => row.id), readyFirst,
    examined(id: string) { examined = id; },
    async finish() {
      const now = context.now(), next = JSON.stringify([examined, !readyFirst, identifier()]);
      await context.database.atomic([sql('UPDATE rer_job_control SET heartbeat=?,updated_at=?,admission_cursor=CASE WHEN admission_cursor=? THEN ? ELSE admission_cursor END WHERE installation_id=? AND epoch=?', now, now, control.admission_cursor, next, context.installationId, control.epoch)]);
    },
  };
}
