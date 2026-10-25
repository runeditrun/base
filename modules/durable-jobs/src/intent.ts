import { bounded, canonical, digest, identifier, insist, JobError, terminal, text } from './codec.ts';
import { atomic, guard, one, sql } from './database.ts';
import { Context, type Row } from './storage.ts';
import type { Authority, Intent, Job, Json, Mutation } from './types.ts';

export async function initializeControl(context: Context): Promise<void> {
  await context.schema();
  await context.database.atomic([sql("INSERT OR IGNORE INTO rer_job_control(installation_id,schema_version,epoch,mode,scheduler,holder,heartbeat,updated_at) VALUES(?,?,?,'paused',?,NULL,?,?)", context.installationId, 1, identifier(), context.options.scheduler, context.now(), context.now())]);
}
export async function request(context: Context, intent: Intent, authority: Authority): Promise<{ job: Job; created: boolean }> {
  context.scope(authority); await context.schema();
  const kind = context.kinds.get(text(intent.kind, 'kind'));
  insist(kind, 'job_handler_unsupported', 503); text(intent.operationKey, 'operation_key');
  const input = bounded(intent.inputRef, context.limits.maxMetadataBytes), revision = bounded(intent.requestedRevision, context.limits.maxMetadataBytes);
  let decoded: Json;
  try {
    decoded = kind.decodeInput(intent.inputRef);
    insist(canonical(kind.decodeRevision(intent.requestedRevision)) === revision, 'job_invalid_input');
  }
  catch { throw new JobError('job_invalid_input', 400, 'Supply the registered kind\'s bounded input reference.'); }
  insist(canonical(decoded) === input, 'job_invalid_input');
  const sourceKey = text(kind.sourceKey(intent.inputRef), 'source');
  const now = context.now(), notBefore = intent.notBefore ?? now, deadline = intent.deadline ?? now + context.limits.maxJobMs;
  // Defaults depending on wall clock are excluded; explicitly requested scheduling is part of immutable intent.
  const intentHash = await digest(bounded({ kind: kind.kind, handlerVersion: kind.version, codecVersion: kind.codecVersion, inputRef: intent.inputRef, requestedRevision: intent.requestedRevision, notBefore: intent.notBefore ?? null, deadline: intent.deadline ?? null }, context.limits.maxMetadataBytes));
  const existing = () => one<Row>(context.database, sql('SELECT * FROM rer_job_jobs WHERE installation_id=? AND namespace=? AND tenant_key=? AND principal_id=? AND operation_key=?', context.installationId, authority.namespace, authority.tenantId ?? '', authority.principalId, intent.operationKey));
  const saved = async (row: Row) => {
    insist(row.intent_hash === intentHash, 'job_intent_conflict');
    return { job: await context.checked(String(row.id), authority), created: false };
  };
  const prior = await existing(); if (prior) return saved(prior);
  insist(Number.isSafeInteger(notBefore) && notBefore >= 0 && Number.isSafeInteger(deadline) && deadline > now && deadline - now <= context.limits.maxJobMs && notBefore < deadline, 'job_invalid_deadline');
  const checkpointHash = await digest('null');
  const job: Job = { id: identifier(), installationId: context.installationId, namespace: authority.namespace, tenantId: authority.tenantId,
    principalId: authority.principalId, ownerId: authority.ownerId, kind: kind.kind, handlerVersion: kind.version, codecVersion: kind.codecVersion,
    sourceKey, operationKey: intent.operationKey, intentHash, requestedRevision: intent.requestedRevision, requestedRevisionHash: await digest(revision), inputRef: intent.inputRef, inputHash: await digest(input),
    state: 'queued', reasonCode: null, recovery: null, version: 1, fence: 0, checkpoint: null, checkpointHash, checkpointSequence: 0,
    progress: { rows: 0, bytes: 0, units: 0 }, starts: 0, failures: 0, resultRef: null, resultHash: null, createdAt: now, updatedAt: now, notBefore, deadline, cancelRequested: false };
  insist(await context.policy.authorize('create', job, authority), 'job_forbidden', 403);
  insist(await kind.validateRevision(job), 'job_revision_stale');
  await initializeControl(context); const control = await context.control(); insist(control, 'job_schema_required', 503);
  const predicates = context.predicates('create', job, authority);
  try {
    await atomic(context.database, [
      ...predicates.map(guard),
      guard(sql("(SELECT COUNT(*) FROM rer_job_jobs WHERE installation_id=? AND state IN ('queued','waiting','retry_wait','running','cancelling'))<?", context.installationId, context.limits.maxQueued)),
      sql(`INSERT INTO rer_job_jobs(id,installation_id,namespace,tenant_key,owner_id,principal_id,kind,handler_version,codec_version,source_key,operation_key,intent_hash,requested_revision,requested_revision_hash,input_ref,input_hash,state,checkpoint_hash,created_at,updated_at,not_before,deadline) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'queued',?,?,?,?,?)`,
        job.id, job.installationId, job.namespace, authority.tenantId ?? '', job.ownerId, job.principalId, job.kind, job.handlerVersion, job.codecVersion, sourceKey, job.operationKey, intentHash, revision, job.requestedRevisionHash, input, await digest(input), checkpointHash, now, now, notBefore, deadline),
      sql('INSERT INTO rer_job_activations(installation_id,job_id,epoch,principal_id,owner_id,authorized_at) VALUES(?,?,?,?,?,?)', context.installationId, job.id, control.epoch, job.principalId, job.ownerId, now),
      ...predicates.map(guard),
    ], 'job_capacity_exhausted');
  } catch (error) {
    const duplicate = await existing(); if (duplicate) return saved(duplicate);
    if (error instanceof JobError && error.code === 'job_capacity_exhausted') {
      const capacity = await one<{ n: number }>(context.database, sql("SELECT COUNT(*) AS n FROM rer_job_jobs WHERE installation_id=? AND state IN ('queued','waiting','retry_wait','running','cancelling')", context.installationId));
      if (Number(capacity?.n) >= context.limits.maxQueued) throw new JobError('job_capacity_exhausted', 429, 'Wait for admitted work to finish or cancel eligible queued work, then retry the same intent.');
      throw new JobError('job_intent_guard_refused');
    }
    throw error;
  }
  return { job: await context.checked(job.id, authority), created: true };
}

export async function mutate(context: Context, action: 'cancel' | 'resume', id: string, mutation: Mutation, authority: Authority): Promise<Job> {
  await context.schema(); const job = await context.checked(id, authority), row = await context.row(id); insist(row, 'job_not_found', 404);
  text(mutation.operationKey, 'operation_key'); insist(Number.isSafeInteger(mutation.expectedVersion) && mutation.expectedVersion > 0, 'job_invalid_version');
  if (mutation.reason !== undefined) text(mutation.reason, 'reason', 200);
  const hash = await digest(canonical({ action, expectedVersion: mutation.expectedVersion, reason: mutation.reason ?? null }));
  const operations = JSON.parse(String(row.operations_json)) as { key: string; hash: string }[];
  const prior = operations.find(operation => operation.key === mutation.operationKey);
  if (prior) { insist(prior.hash === hash, 'job_operation_conflict'); return job; }
  // Terminal resume is a version-bound read, with no new operation receipt or
  // execution authorization. Only its canonical read content is admissible.
  if (action === 'resume' && terminal(job.state)) {
    insist(job.version === mutation.expectedVersion && mutation.reason === undefined, 'job_operation_conflict');
    return job;
  }
  insist(job.version === mutation.expectedVersion, 'job_version_conflict');
  insist(await context.policy.authorize(action, job, authority), 'job_forbidden', 403);
  if (terminal(job.state)) {
    insist(operations.length < 64, 'job_operation_limit');
    const encoded = bounded([...operations, { key: mutation.operationKey, hash }] as unknown as Json, context.limits.maxMetadataBytes);
    const predicates = context.predicates(action, job, authority);
    await atomic(context.database, [...predicates.map(guard),
      guard(sql('EXISTS(SELECT 1 FROM rer_job_jobs WHERE installation_id=? AND id=? AND version=? AND operations_json=?)', context.installationId, id, job.version, String(row.operations_json))),
      sql('UPDATE rer_job_jobs SET operations_json=? WHERE installation_id=? AND id=?', encoded, context.installationId, id), ...predicates.map(guard)]);
    return job;
  }
  insist(job.state !== 'uncertain', 'job_uncertain');
  if (action === 'resume') {
    insist(job.reasonCode !== 'restored_requires_reauthorization', 'restored_requires_reauthorization');
    const kind = await context.compatible(job); insist(await kind.validateRevision(job), 'job_revision_stale');
    insist(job.failures < context.limits.maxFailureAttempts && context.now() < job.deadline, 'job_budget_exhausted');
    insist(row.state !== 'running' && row.state !== 'cancelling', 'job_already_running');
  }
  insist(operations.length < 64, 'job_operation_limit');
  const encoded = bounded([...operations, { key: mutation.operationKey, hash }] as unknown as Json, context.limits.maxMetadataBytes);
  const predicates = context.predicates(action, job, authority), now = context.now();
  await atomic(context.database, [
    ...predicates.map(guard), guard(sql('EXISTS(SELECT 1 FROM rer_job_jobs WHERE installation_id=? AND id=? AND version=?)', context.installationId, id, job.version)),
    sql(`UPDATE rer_job_jobs SET state=?,reason_code=NULL,recovery=NULL,version=version+1,fence=fence+1,not_before=?,updated_at=?,cancel_requested=?,operations_json=? WHERE installation_id=? AND id=? AND version=?`, action === 'cancel' ? 'cancelled' : 'queued', now, now, action === 'cancel' ? 1 : 0, encoded, context.installationId, id, job.version),
    sql("UPDATE rer_job_attempts SET ended_at=?,classification=? WHERE installation_id=? AND job_id=? AND ended_at IS NULL", now, action === 'cancel' ? 'cancelled' : 'yielded', context.installationId, id),
    sql('DELETE FROM rer_job_leases WHERE installation_id=? AND job_id=?', context.installationId, id), ...predicates.map(guard),
  ]);
  return context.checked(id, authority);
}
