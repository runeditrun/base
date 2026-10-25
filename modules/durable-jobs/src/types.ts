export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Value = string | number | null;
export interface Sql { sql: string; params?: Value[] }
export interface Database {
  all<T = Record<string, unknown>>(statement: Sql): Promise<T[]>;
  atomic(statements: Sql[]): Promise<Record<string, unknown>[][]>;
}
export interface D1Statement {
  bind(...values: Value[]): D1Statement;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}
export interface D1Database {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Promise<unknown[]>;
}
export interface Authority {
  installationId: string; namespace: string; tenantId: string | null;
  principalId: string; ownerId: string; operator?: boolean;
}
export type State = 'queued' | 'running' | 'waiting' | 'retry_wait' | 'cancelling' | 'cancelled' | 'succeeded' | 'failed' | 'uncertain';
export type Action = 'create' | 'read' | 'claim' | 'commit' | 'publish' | 'cancel' | 'resume' | 'status';
export interface Job {
  id: string; installationId: string; namespace: string; tenantId: string | null;
  principalId: string; ownerId: string; kind: string; handlerVersion: number; codecVersion: number;
  sourceKey: string; operationKey: string; intentHash: string;
  requestedRevision: Json; requestedRevisionHash: string; inputRef: Json; inputHash: string;
  state: State; savedState?: State; reasonCode: string | null; recovery: string | null;
  version: number; fence: number; checkpoint: Json; checkpointHash: string; checkpointSequence: number;
  progress: { rows: number; bytes: number; units: number }; starts: number; failures: number;
  resultRef: Json; resultHash: string | null; resultAvailability?: 'available' | 'unavailable'; createdAt: number; updatedAt: number;
  notBefore: number; deadline: number; cancelRequested: boolean;
}
export interface Limits {
  installationConcurrency: number; tenantConcurrency: number; kindConcurrency: number; sourceConcurrency: number;
  maxQueued: number; maxFailureAttempts: number; maxUnits: number; maxRowsPerUnit: number; maxBytesPerUnit: number;
  maxStatements: number; maxUnitMs: number; leaseMs: number; maxJobMs: number;
  maxMetadataBytes: number; maxCheckpointBytes: number; maxResultBytes: number; maxList: number;
}
export interface Claim { job: Job; token: string; epoch: string; holder: string; expiresAt: number }
export interface CommitUnit {
  type: 'commit'; unitKey: string; expectedCheckpointSequence: number; statements: Sql[];
  /** Exact domain postconditions, including rows/cursor: checked after all writes. */
  guards: Sql[]; checkpoint: Json; rows: number; bytes: number; resultRef?: Json;
}
export type Unit = CommitUnit | { type: 'yield'; notBefore: number } | { type: 'wait'; reasonCode: string; recovery: string };
export interface JobKind {
  kind: string; version: number; codecVersion: number; capabilities: ['local'];
  consequential: false; dependencies: string[];
  decodeInput(value: Json): Json;
  sourceKey(input: Json): string;
  decodeCheckpoint(codecVersion: number, value: Json): Json;
  validateRevision(job: Job): Promise<boolean>;
  runUnit(claim: Claim, context: { database: Database; signal: AbortSignal; limits: Limits }): Promise<Unit>;
  verifyResult(job: Job, result: Json): Promise<boolean>;
}
export interface Policy {
  authorizeScope(authority: Authority): Promise<boolean>;
  authorize(action: Action, job: Job, authority?: Authority): Promise<boolean>;
  resultAvailable?(job: Job, authority: Authority): Promise<boolean>;
  /** Mandatory live same-database authority, requested-revision and erasure predicates. */
  commitGuards(action: Action, job: Job, authority?: Authority): Sql[];
}
export interface Intent {
  kind: string; operationKey: string; requestedRevision: Json; inputRef: Json;
  notBefore?: number; deadline?: number;
}
export interface Mutation { expectedVersion: number; operationKey: string; reason?: string }
export interface Options {
  database: Database; installationId: string; kinds: JobKind[]; policy: Policy;
  limits?: Partial<Limits>; scheduler: 'native' | 'manual'; now?: () => number;
  dependencies?: Record<string, () => Promise<boolean>>;
}
