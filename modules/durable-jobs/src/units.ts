import { bounded, canonical, digest, insist, JobError, safeCode, text } from './codec.ts';
import { atomic, guard, one, sql } from './database.ts';
import { activation, commitClock, leaseGuard } from './leases.ts';
import { unitBudget } from './budget.ts';
import { Context } from './storage.ts';
import type { Claim, CommitUnit, Job, Json, Unit } from './types.ts';

async function live(context: Context, claim: Claim, action: 'commit' | 'publish') {
  const kind = await context.compatible(claim.job);
  insist(await kind.validateRevision(claim.job), 'job_revision_stale');
  insist(await context.policy.authorize(action, claim.job), 'job_authority_revoked');
  return kind;
}
export async function commitUnit(context: Context, claim: Claim, unit: CommitUnit, options: { signal?: AbortSignal; deadline?: number } = {}): Promise<Job> {
  const deadline = Math.min(context.now() + context.limits.maxUnitMs, claim.expiresAt, claim.job.deadline, options.deadline ?? Infinity);
  const budget = unitBudget(context, deadline, options.signal);
  await context.schema(); insist(claim.job.installationId === context.installationId, 'job_lease_stale');
  text(unit.unitKey, 'unit_key');
  insist(Number.isSafeInteger(unit.expectedCheckpointSequence) && unit.expectedCheckpointSequence === claim.job.checkpointSequence, 'job_checkpoint_conflict');
  for (const value of [unit.rows, unit.bytes]) insist(Number.isSafeInteger(value) && value >= 0, 'job_invalid_progress');
  insist(unit.rows <= context.limits.maxRowsPerUnit && unit.bytes <= context.limits.maxBytesPerUnit && unit.statements.length <= context.limits.maxStatements, 'job_unit_limit');
  insist(unit.guards.length > 0 && unit.guards.length <= 20 && (unit.rows === 0 || unit.statements.length > 0), 'job_domain_guards_required');
  for (const statement of unit.statements) {
    // Registered application code supplies bounded database writes, never HTTP input.
    insist(/^\s*(?:INSERT|UPDATE|DELETE)\b/i.test(statement.sql) && !/\brer_job_\w*/i.test(statement.sql) && !/;/.test(statement.sql), 'job_invalid_domain_statement');
  }
  const checkpoint = bounded(unit.checkpoint, context.limits.maxCheckpointBytes), checkpointHash = await digest(checkpoint);
  const result = bounded(unit.resultRef ?? null, context.limits.maxResultBytes), final = unit.resultRef !== undefined;
  const encoded = bounded({ checkpoint: unit.checkpoint, rows: unit.rows, bytes: unit.bytes, resultRef: unit.resultRef ?? null, statements: unit.statements as unknown as Json, guards: unit.guards as unknown as Json }, context.limits.maxMetadataBytes * 4);
  const outputDigest = await digest(encoded), inputDigest = await digest(canonical({ intent: claim.job.intentHash, checkpoint: claim.job.checkpointHash, sequence: claim.job.checkpointSequence }));
  const kind = await live(context, claim, final ? 'publish' : 'commit');
  kind.decodeCheckpoint(claim.job.codecVersion, unit.checkpoint);
  const receipt = await one(context.database, sql('SELECT output_digest,input_digest FROM rer_job_units WHERE installation_id=? AND job_id=? AND unit_key=?', context.installationId, claim.job.id, unit.unitKey));
  if (receipt) {
    insist(receipt.output_digest === outputDigest && receipt.input_digest === inputDigest, 'job_unit_conflict');
    const saved = await context.row(claim.job.id); insist(saved, 'job_not_found', 404); return context.job(saved);
  }
  const initialLease = await leaseGuard(context, claim);
  insist(await one(context.database, sql(`SELECT 1 WHERE ${initialLease.sql}`, ...(initialLease.params ?? []))), 'job_lease_stale');
  if (unit.rows === 0 && !final) insist(checkpoint === canonical(claim.job.checkpoint), 'job_cursor_without_writes');
  if (final) insist(await budget.verify(() => kind.verifyResult(claim.job, unit.resultRef!)), 'job_result_unverified');
  const resultHash = final ? await digest(result) : null, tokenHash = await digest(claim.token);
  const predicates = context.predicates(final ? 'publish' : 'commit', claim.job);
  // No pre-verification timestamp is reused in the committing guards.
  const lease = await leaseGuard(context, claim), clock = commitClock(context), now = context.now();
  const time = sql(`? > (${clock.sql})`, deadline, ...clock.params!);
  budget.check();
  await atomic(context.database, [
    guard(lease), guard(time), guard(activation(context, claim.job, claim.epoch)), ...predicates.map(guard),
    ...unit.statements, ...unit.guards.map(guard),
    sql('INSERT INTO rer_job_units(installation_id,job_id,unit_key,input_digest,output_digest,checkpoint_sequence,committed_rows,committed_bytes,result_ref,committed_at) VALUES(?,?,?,?,?,?,?,?,?,?)', context.installationId, claim.job.id, unit.unitKey, inputDigest, outputDigest, claim.job.checkpointSequence + 1, unit.rows, unit.bytes, result, now),
    sql("UPDATE rer_job_jobs SET state=?,reason_code=NULL,recovery=NULL,version=version+1,checkpoint=?,checkpoint_hash=?,checkpoint_sequence=checkpoint_sequence+1,progress_rows=progress_rows+?,progress_bytes=progress_bytes+?,progress_units=progress_units+1,result_ref=?,result_hash=?,updated_at=?,not_before=? WHERE installation_id=? AND id=? AND version=? AND fence=?", final ? 'succeeded' : 'queued', checkpoint, checkpointHash, unit.rows, unit.bytes, result, resultHash, now, now, context.installationId, claim.job.id, claim.job.version, claim.job.fence),
    sql("UPDATE rer_job_attempts SET ended_at=?,classification='committed',usage_rows=?,usage_bytes=? WHERE installation_id=? AND job_id=? AND fence=? AND ended_at IS NULL", now, unit.rows, unit.bytes, context.installationId, claim.job.id, claim.job.fence),
    sql('DELETE FROM rer_job_leases WHERE installation_id=? AND job_id=? AND token_hash=? AND fence=?', context.installationId, claim.job.id, tokenHash, claim.job.fence),
    ...predicates.map(guard), ...unit.guards.map(guard), guard(activation(context, claim.job, claim.epoch)),
    guard(sql('EXISTS(SELECT 1 FROM rer_job_jobs WHERE installation_id=? AND id=? AND version=? AND fence=? AND checkpoint_hash=? AND checkpoint_sequence=? AND state=?)', context.installationId, claim.job.id, claim.job.version + 1, claim.job.fence, checkpointHash, claim.job.checkpointSequence + 1, final ? 'succeeded' : 'queued')), guard(time),
  ], 'job_commit_refused');
  const saved = await context.row(claim.job.id); insist(saved, 'job_not_found', 404); return context.job(saved);
}

export async function settle(context: Context, claim: Claim, unit: Exclude<Unit, CommitUnit>): Promise<void> {
  await live(context, claim, 'commit');
  const now = context.now();
  if (unit.type === 'yield') insist(Number.isSafeInteger(unit.notBefore) && unit.notBefore >= now && unit.notBefore < claim.job.deadline, 'job_invalid_due');
  else { text(unit.reasonCode, 'reason'); text(unit.recovery, 'recovery', 500); }
  const predicates = context.predicates('commit', claim.job);
  await atomic(context.database, [guard(await leaseGuard(context, claim)), guard(activation(context, claim.job, claim.epoch)), ...predicates.map(guard),
    sql('UPDATE rer_job_jobs SET state=?,reason_code=?,recovery=?,version=version+1,not_before=?,updated_at=? WHERE installation_id=? AND id=?', unit.type === 'wait' ? 'waiting' : 'queued', unit.type === 'wait' ? safeCode(unit.reasonCode) : null, unit.type === 'wait' ? unit.recovery : null, unit.type === 'yield' ? unit.notBefore : now, now, context.installationId, claim.job.id),
    sql("UPDATE rer_job_attempts SET ended_at=?,classification=? WHERE installation_id=? AND job_id=? AND fence=? AND ended_at IS NULL", now, unit.type === 'wait' ? 'waiting' : 'yielded', context.installationId, claim.job.id, claim.job.fence),
    sql('DELETE FROM rer_job_leases WHERE installation_id=? AND job_id=? AND token_hash=?', context.installationId, claim.job.id, await digest(claim.token)),
    ...predicates.map(guard), guard(activation(context, claim.job, claim.epoch))]);
}

export async function failUnit(context: Context, claim: Claim, error: unknown): Promise<void> {
  const code = error instanceof JobError ? safeCode(error.code) : 'job_handler_failed';
  const held = ['job_authority_revoked', 'job_revision_stale', 'job_commit_refused', 'job_checkpoint_corrupt', 'job_checkpoint_invalid', 'job_result_unverified', 'job_domain_guards_required', 'job_cursor_without_writes'].includes(code);
  const exhausted = context.now() >= claim.job.deadline || claim.job.failures + 1 >= context.limits.maxFailureAttempts;
  const now = context.now(), next = Math.min(now + 1000 * (claim.job.failures + 1), claim.job.deadline);
  // Only local units are registered. A rolled-back SQLite/D1 transaction is proof of no committed unit.
  try {
    await atomic(context.database, [guard(await leaseGuard(context, claim)), guard(activation(context, claim.job, claim.epoch)),
      sql('UPDATE rer_job_jobs SET state=?,reason_code=?,recovery=?,version=version+1,failures=failures+?,not_before=?,updated_at=? WHERE installation_id=? AND id=?', held ? 'waiting' : exhausted ? 'failed' : 'retry_wait', code, held ? 'Restore current authority/revision or compatible data and explicitly resume; inspect partial committed units.' : exhausted ? 'Inspect the unsuccessful outcome and create a new authorized intent.' : 'A local unit failed before commit; retry is bounded by its failure budget and deadline.', held ? 0 : 1, next, now, context.installationId, claim.job.id),
      sql('UPDATE rer_job_attempts SET ended_at=?,classification=?,failure_code=? WHERE installation_id=? AND job_id=? AND fence=? AND ended_at IS NULL', now, held ? 'held' : 'failed', code, context.installationId, claim.job.id, claim.job.fence),
      sql('DELETE FROM rer_job_leases WHERE installation_id=? AND job_id=? AND token_hash=?', context.installationId, claim.job.id, await digest(claim.token)),
    ], 'job_lease_stale');
  } catch (failure) { if (!(failure instanceof JobError && failure.code === 'job_lease_stale')) throw failure; }
}
