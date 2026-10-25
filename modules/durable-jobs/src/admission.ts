import { identifier } from './codec.ts';
import { sql } from './database.ts';
import { exhaustedRecovery } from './eligibility.ts';
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
  const held = [...after, ...before];
  // Expiry gets a bounded sweep even on a ready-first one-slot tick. An expired
  // entry is fully examined here; live entries still need the held lane below.
  const [expiredRows] = await context.database.atomic([sql("UPDATE rer_job_jobs SET state='failed',reason_code='job_deadline_exhausted',recovery=?,version=version+1,updated_at=? WHERE installation_id=? AND state='waiting' AND deadline<=? AND id IN (SELECT value FROM json_each(?)) AND EXISTS(SELECT 1 FROM rer_job_activations a WHERE a.installation_id=rer_job_jobs.installation_id AND a.job_id=rer_job_jobs.id AND a.epoch=? AND a.principal_id=rer_job_jobs.principal_id AND a.owner_id=rer_job_jobs.owner_id) RETURNING id", exhaustedRecovery, now, context.installationId, now, JSON.stringify(held.map(row => row.id)), control.epoch)]);
  const expired = new Set(expiredRows.map(row => String(row.id)));
  let examined = cursor;
  for (const row of held) { if (!expired.has(row.id)) break; examined = row.id; }
  return {
    ready: ready.map(row => row.id), held: held.filter(row => !expired.has(row.id)).map(row => row.id), readyFirst,
    examined(id: string) { examined = id; },
    async finish() {
      const now = context.now(), next = JSON.stringify([examined, !readyFirst, identifier()]);
      await context.database.atomic([sql('UPDATE rer_job_control SET heartbeat=?,updated_at=?,admission_cursor=CASE WHEN admission_cursor=? THEN ? ELSE admission_cursor END WHERE installation_id=? AND epoch=?', now, now, control.admission_cursor, next, context.installationId, control.epoch)]);
    },
  };
}
