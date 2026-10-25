import { bounded, digest, insist, JobError, text } from './codec.ts';
import { one, sql } from './database.ts';
import { admissionReason, capacityRecovery, exhaustedReason, exhaustedRecovery, holdRecovery, reconsiderable } from './eligibility.ts';
import type { Authority, Database, Job, JobKind, Limits, Options, Policy, Sql, State } from './types.ts';

export const defaults: Limits = {
  installationConcurrency: 2, tenantConcurrency: 1, kindConcurrency: 1, sourceConcurrency: 1,
  maxQueued: 1000, maxFailureAttempts: 3, maxUnits: 1000, maxRowsPerUnit: 100, maxBytesPerUnit: 262144,
  maxStatements: 200, maxUnitMs: 10000, leaseMs: 30000, maxJobMs: 86400000,
  maxMetadataBytes: 65536, maxCheckpointBytes: 65536, maxResultBytes: 65536, maxList: 100,
};
const columns = {
  rer_job_jobs: 'id installation_id namespace tenant_key owner_id principal_id kind handler_version codec_version source_key operation_key intent_hash requested_revision requested_revision_hash input_ref input_hash state reason_code recovery version fence checkpoint checkpoint_hash checkpoint_sequence progress_rows progress_bytes progress_units starts failures result_ref result_hash created_at updated_at not_before deadline cancel_requested operations_json undo_of_job_id supersedes_job_id',
  rer_job_units: 'installation_id job_id unit_key input_digest output_digest checkpoint_sequence committed_rows committed_bytes result_ref committed_at',
  rer_job_attempts: 'id installation_id job_id unit_sequence fence started_at ended_at classification failure_code usage_rows usage_bytes',
  rer_job_leases: 'installation_id job_id token_hash holder epoch fence expires_at heartbeat',
  rer_job_control: 'installation_id schema_version epoch mode scheduler holder heartbeat updated_at admission_cursor',
  rer_job_activations: 'installation_id job_id epoch principal_id owner_id authorized_at',
};
export type Row = Record<string, string | number | null>;
export interface Control { epoch: string; mode: string; holder: string | null; heartbeat: number; scheduler: string; admission_cursor: string }
export class Context {
  readonly database: Database; readonly limits: Limits; readonly kinds = new Map<string, JobKind>();
  readonly policy: Policy; readonly installationId: string; readonly now: () => number;
  readonly options: Options;
  constructor(options: Options) {
    this.options = options;
    this.database = options.database; this.policy = options.policy; this.now = options.now ?? Date.now;
    this.installationId = text(options.installationId, 'installation');
    insist(['native', 'manual'].includes(options.scheduler), 'scheduler_unconfigured', 503);
    insist(typeof this.policy?.authorizeScope === 'function' && typeof this.policy?.authorize === 'function' && typeof this.policy?.commitGuards === 'function', 'job_policy_required');
    this.limits = { ...defaults, ...options.limits };
    for (const value of Object.values(this.limits)) insist(Number.isSafeInteger(value) && value > 0, 'job_invalid_limits');
    insist(this.limits.leaseMs > this.limits.maxUnitMs && this.limits.maxStatements <= 500 && this.limits.maxList <= 1000, 'job_invalid_limits');
    for (const kind of options.kinds) {
      text(kind.kind, 'kind');
      insist(kind.capabilities?.length === 1 && kind.capabilities[0] === 'local' && kind.consequential === false, 'job_effect_protocol_required', 503);
      insist(Number.isSafeInteger(kind.version) && kind.version > 0 && Number.isSafeInteger(kind.codecVersion) && kind.codecVersion > 0, 'job_invalid_handler');
      for (const callback of ['decodeInput', 'decodeRevision', 'sourceKey', 'decodeCheckpoint', 'validateRevision', 'runUnit', 'verifyResult'] as const) insist(typeof kind[callback] === 'function', 'job_invalid_handler');
      insist(!this.kinds.has(kind.kind), 'job_duplicate_handler'); this.kinds.set(kind.kind, kind);
    }
  }
  async schema(): Promise<void> {
    try {
      const tables = await this.database.all<{ name: string }>(sql("SELECT name FROM sqlite_master WHERE type='table' AND lower(name) LIKE 'rer_job_%' ORDER BY name"));
      insist(tables.map(t => t.name).sort().join() === Object.keys(columns).sort().join(), 'job_schema_required', 503);
      for (const [table, required] of Object.entries(columns)) {
        const actual = await this.database.all<{ name: string }>(sql(`PRAGMA table_info(${table})`));
        insist(actual.map(column => column.name).join(' ') === required, 'job_schema_required', 503);
      }
      const objects = await this.database.all<{ name: string }>(sql("SELECT name FROM sqlite_master WHERE name IN ('rer_job_intent_immutable','rer_job_due','rer_job_scope','rer_job_kind','rer_job_lease_expiry','rer_job_waiting')"));
      insist(objects.length === 6, 'job_schema_required', 503);
    } catch { throw new JobError('job_schema_required', 503, 'Apply the complete declared durable-jobs migration before starting installation work.'); }
  }
  async control(): Promise<Control | undefined> { return one<Control>(this.database, sql('SELECT epoch,mode,holder,heartbeat,scheduler,admission_cursor FROM rer_job_control WHERE installation_id=?', this.installationId)); }
  async row(id: string): Promise<Row | undefined> { return one<Row>(this.database, sql('SELECT * FROM rer_job_jobs WHERE installation_id=? AND id=?', this.installationId, id)); }
  scope(authority: Authority): void {
    insist(authority.installationId === this.installationId, 'job_not_found', 404);
    for (const name of ['principalId', 'ownerId', 'namespace'] as const) text(authority[name], name);
    if (authority.tenantId !== null) text(authority.tenantId, 'tenant');
  }
  async job(row: Row, effective = true): Promise<Job> {
    const job: Job = {
      id: String(row.id), installationId: String(row.installation_id), namespace: String(row.namespace), tenantId: row.tenant_key === '' ? null : String(row.tenant_key),
      principalId: String(row.principal_id), ownerId: String(row.owner_id), kind: String(row.kind), handlerVersion: Number(row.handler_version), codecVersion: Number(row.codec_version),
      sourceKey: String(row.source_key), operationKey: String(row.operation_key), intentHash: String(row.intent_hash),
      requestedRevision: JSON.parse(String(row.requested_revision)), requestedRevisionHash: String(row.requested_revision_hash), inputRef: JSON.parse(String(row.input_ref)), inputHash: String(row.input_hash),
      state: row.state as State, reasonCode: row.reason_code as string | null, recovery: row.recovery as string | null,
      version: Number(row.version), fence: Number(row.fence), checkpoint: JSON.parse(String(row.checkpoint)), checkpointHash: String(row.checkpoint_hash), checkpointSequence: Number(row.checkpoint_sequence),
      progress: { rows: Number(row.progress_rows), bytes: Number(row.progress_bytes), units: Number(row.progress_units) }, starts: Number(row.starts), failures: Number(row.failures),
      resultRef: JSON.parse(String(row.result_ref)), resultHash: row.result_hash as string | null,
      createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), notBefore: Number(row.not_before), deadline: Number(row.deadline), cancelRequested: row.cancel_requested === 1,
    };
    if (effective && !['succeeded', 'failed', 'cancelled', 'uncertain'].includes(job.state)) {
      const activation = await one(this.database, sql('SELECT 1 FROM rer_job_activations a JOIN rer_job_control c ON c.installation_id=a.installation_id AND c.epoch=a.epoch WHERE a.installation_id=? AND a.job_id=? AND a.principal_id=? AND a.owner_id=?', this.installationId, job.id, job.principalId, job.ownerId));
      const control = await this.control();
      if (!activation) Object.assign(job, { savedState: job.state, state: 'waiting', reasonCode: 'restored_requires_reauthorization', recovery: 'Review restored history and explicitly reauthorize through a supported destination policy; execution authority is not portable.' });
      else if (control?.mode !== 'running') Object.assign(job, { savedState: job.state, state: 'waiting', reasonCode: 'scheduler_unconfigured', recovery: 'Start the declared installation runtime to resume bounded native work.' });
      else if (job.state === 'waiting') {
        const exhausted = exhaustedReason(this, job);
        if (exhausted) Object.assign(job, { savedState: job.state, state: 'failed', reasonCode: exhausted, recovery: exhaustedRecovery });
        else if (reconsiderable.has(job.reasonCode ?? '')) {
          const reason = await admissionReason(this, job);
          Object.assign(job, { savedState: job.state, state: reason ? 'waiting' : 'queued', reasonCode: reason ?? null, recovery: reason === 'job_capacity_exhausted' ? capacityRecovery : reason ? holdRecovery : null });
        }
      }
    }
    return job;
  }
  async checked(id: string, authority: Authority): Promise<Job> {
    this.scope(authority); const row = await this.row(text(id, 'id'));
    if (!row || row.namespace !== authority.namespace || row.tenant_key !== (authority.tenantId ?? '') || (row.principal_id !== authority.principalId && !authority.operator)) throw new JobError('job_not_found', 404);
    const job = await this.job(row);
    insist(await this.policy.authorize('read', job, authority), 'job_not_found', 404);
    return this.project(job, authority);
  }
  async project(job: Job, authority: Authority): Promise<Job> {
    return this.policy.resultAvailable && !await this.policy.resultAvailable(job, authority)
      ? { ...job, resultRef: null, resultAvailability: 'unavailable' } : job;
  }
  predicates(action: Parameters<Policy['commitGuards']>[0], job: Job, authority?: Authority): Sql[] {
    const predicates = this.policy.commitGuards(action, job, authority);
    insist(Array.isArray(predicates) && predicates.length > 0 && predicates.length <= 20 && predicates.every(p => typeof p.sql === 'string' && p.sql.length > 0), 'job_policy_guards_required', 503);
    return predicates;
  }
  async compatible(job: Job): Promise<JobKind> {
    const kind = this.kinds.get(job.kind);
    insist(kind && kind.version === job.handlerVersion && kind.codecVersion === job.codecVersion, 'job_handler_unsupported', 503);
    const checkpoint = bounded(job.checkpoint, this.limits.maxCheckpointBytes);
    insist(await digest(checkpoint) === job.checkpointHash, 'job_checkpoint_corrupt');
    kind.decodeInput(job.inputRef); kind.decodeCheckpoint(job.codecVersion, job.checkpoint);
    insist(await digest(bounded(job.inputRef, this.limits.maxMetadataBytes)) === job.inputHash, 'job_input_corrupt');
    insist(await digest(bounded(job.requestedRevision, this.limits.maxMetadataBytes)) === job.requestedRevisionHash, 'job_revision_corrupt');
    return kind;
  }
}
