/** Structural Workers/D1 contract. Production has no package or Node dependency. */
export type SqlValue = string | number | null | ArrayBuffer | Uint8Array;
export interface Sql { sql: string; params?: readonly SqlValue[] }
export interface D1Statement {
  bind(...values: SqlValue[]): D1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}
export interface D1Database { prepare(sql: string): D1Statement; batch(statements: D1Statement[]): Promise<unknown[]> }
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type EvidenceKind = 'electronic-signature' | 'terms-acceptance' | 'customer-attestation' | 'external-execution';
export type NativeKind = Exclude<EvidenceKind, 'external-execution'>;
export interface ArtifactRef { id: string; version: string; mediaType: string; sha256: string; size: number }
export interface SourceRef { kind: string; id: string; revision: string }
export interface Participant {
  id: string; subjectId: string; action: 'sign' | 'accept' | 'attest' | 'view';
  order: number; documentIds: readonly string[]; authentication: string;
}
export type ConsentPurpose = 'electronic-records' | 'signature-intent' | 'accept-terms' | 'attestation';
export interface ConsentRequirement { purpose: ConsentPurpose; wording: ArtifactRef; language: string }
export interface ConsentEvidence extends ConsentRequirement { acceptedAt: string }
export interface SigningDefinition {
  source: SourceRef; kind: NativeKind; documents: readonly ArtifactRef[]; recipients: readonly Participant[];
  approvalDigest: string; selectionDigest: string | null; expiresAt: string | null;
  /** Exact requirements selected by native policy. No implicit disclosure or checkbox. */
  consents: readonly ConsentRequirement[];
  completion: 'receipt-only' | 'artifacts-required';
  /** Unsupported product transitions are explicitly absent. */
  closures: readonly ('declined' | 'cancelled' | 'withdrawn')[];
  replaces: string | null;
}
export type RequestState = 'draft' | 'issued' | 'in-progress' | 'completed' | 'declined' | 'cancelled' | 'expired' | 'withdrawn';
export interface VersionedId { id: string; revision: number }
export interface RequestRecord extends VersionedId {
  recordKind: 'native'; definition: SigningDefinition; state: RequestState; createdAt: string;
  restored: boolean; root: string | null; completedArtifacts: readonly ArtifactRef[];
}
/** Historical unknowns stay unknown. Adoption must retain the original native record. */
export interface LegacyRecord {
  recordKind: 'legacy'; id: string; source: SourceRef; kind: EvidenceKind; state: RequestState;
  originalId: string; originalAuditRoot: string | null; historical: Json;
  artifacts: readonly ArtifactRef[]; authentication: string | null; consent: readonly ConsentEvidence[] | null;
  createdAt: string; restored: boolean;
}
export interface ReadContext {
  actorId: string;
  /** Trusted server SQL: CURRENT authority for the entire requested evidence scope. Never body input. */
  authority: Sql;
}
export interface CommandContext extends ReadContext {
  operationKey: string;
  /** Stable native person sponsor; never an email. Personal acts refuse every agent. */
  agent: { id: string; sponsorId: string } | null;
}
export interface ParticipantContext extends CommandContext {
  subjectId: string;
  /** Native session/assertion identity; must change on session rotation/revocation. */
  bindingId: string;
  authentication: string;
  /** Trusted peer metadata, or explicit absence. Never accept forwarded/body claims blindly. */
  peer: { ip: string | null; userAgent: string | null };
}
export type PersonalAct =
  | { type: 'typed-signature'; name: string }
  | { type: 'drawn-signature'; name: string; artifact: ArtifactRef }
  | { type: 'accept'; statement: string }
  | { type: 'attest'; statement: string };
export interface ReviewBinding {
  documentIds: readonly string[]; approvalDigest: string; selectionDigest: string | null;
  fields: { [key: string]: Json }; act: PersonalAct;
  consents: readonly ConsentRequirement[];
}
export interface ReviewInput {
  request: VersionedId; recipientId: string; credential: string | null; binding: ReviewBinding;
}
export interface OneUseReview {
  requestId: string; recipientId: string; token: string; signableDigest: string; expiresAt: string;
  documents: readonly ArtifactRef[];
}
export interface ReviewRedemption {
  requestId: string; recipientId: string; credential: string | null; token: string; signableDigest: string;
}
export interface ActionRecord {
  id: string; requestId: string; recipientId: string; actorId: string; subjectId: string;
  authentication: string; bindingDigest: string; kind: NativeKind; at: string;
  source: SourceRef; approvalDigest: string; selectionDigest: string | null;
  documents: readonly ArtifactRef[]; fields: { [key: string]: Json }; act: PersonalAct;
  consents: readonly ConsentEvidence[]; peer: ParticipantContext['peer']; signableDigest: string;
  receiptDigest: string; artifacts: readonly ArtifactRef[];
}
export interface SigningResult { request: RequestRecord; action: ActionRecord }
export interface IssueResult {
  request: RequestRecord;
  /** Raw capability returned only by this authorized command; stored sealed, never exported. */
  invitations: readonly { recipientId: string; token: string; expiresAt: string }[];
}
export interface CloseInput { request: VersionedId; state: 'declined' | 'cancelled' | 'expired' | 'withdrawn'; reason: string }
export interface ExternalExecution {
  request: VersionedId; provider: string; providerRequestId: string;
  provenance: { source: string; receivedAt: string; attribution: string };
  disposition: 'matched' | 'mismatch-accepted' | 'mismatch-pending' | 'rejected';
  artifacts: readonly ArtifactRef[];
}
export interface ExecutionRecord extends ExternalExecution { id: string; kind: 'external-execution'; actorId: string; at: string }
export interface AuditEvent {
  sequence: number; previous: string | null; digest: string;
  algorithm: 'sha256-canonical-json-v1'; payload: {
    operation: 'prepare' | 'issue' | 'review' | 'sign' | 'close' | 'external';
    actorId: string; agent: CommandContext['agent']; at: string; commandId: string;
    request: RequestRecord; action: ActionRecord | null; execution: ExecutionRecord | null;
    detail: Json;
  };
}
export interface EvidenceBundle {
  format: 'agreement-signing/v1'; request: RequestRecord | LegacyRecord;
  actions: readonly ActionRecord[]; events: readonly AuditEvent[]; executions: readonly ExecutionRecord[];
  /** All referenced bytes, including wording and signature images. No credentials/review tokens. */
  artifacts: readonly { reference: ArtifactRef; base64: string }[];
}
export type VerificationIssue = 'shape' | 'artifact-digest' | 'artifact-size' | 'missing-artifact' | 'chain' | 'receipt' | 'root' | 'binding';
export type VerificationResult = { valid: true; root: string | null } | { valid: false; issues: readonly VerificationIssue[] };
export type SigningErrorCode = 'invalid_input' | 'capacity' | 'unauthorized' | 'not_found' | 'conflict' | 'replay_mismatch'
  | 'stale' | 'expired' | 'closed' | 'wrong_participant' | 'ordering' | 'credential' | 'review_used'
  | 'unsupported' | 'artifact_missing' | 'artifact_mismatch' | 'legacy_read_only' | 'restored_inert';
export type NativeOperation = AuditEvent['payload']['operation'];
export interface NativeCommit {
  operation: NativeOperation; commandId: string; request: RequestRecord;
  action: ActionRecord | null; execution: ExecutionRecord | null;
}
export interface SigningOptions {
  database: D1Database;
  /** Seed checks exact source bytes/selection/approval/state and authority in SAME database. */
  sourceGuard(ctx: ReadContext, definition: SigningDefinition, operation: NativeOperation): Sql | Promise<Sql>;
  /** Native participant/session/witness/guardian/category policy, rechecked in commit. */
  participantGuard(ctx: ParticipantContext, request: RequestRecord, participant: Participant, binding: ReviewBinding | null): Sql | Promise<Sql>;
  /** Immutable object custody. put MUST reject different bytes for an existing id/version. */
  artifacts: { read(reference: ArtifactRef): Promise<Uint8Array | null>; put(reference: ArtifactRef, bytes: Uint8Array): Promise<void> };
  /** Pure rendering: no provider/mail/object write. Final bytes are staged before custody. */
  finalize?: (request: RequestRecord, actions: readonly ActionRecord[]) => Promise<readonly { reference: ArtifactRef; bytes: Uint8Array }[]>;
  /** Same-D1 native outcomes/audit, maximum eight SQL statements. No I/O or second writer. */
  nativeCommit(commit: NativeCommit): readonly Sql[] | Promise<readonly Sql[]>;
  /** AES-GCM key for recoverable authorized invitation/review command replay. Excluded from archives. */
  credentialKey: CryptoKey;
  /** Explicit capability mode, no mandatory public tokens. */
  invitations: 'capability' | 'native-session';
  now?: () => Date;
}
export interface SigningService {
  prepare(ctx: CommandContext, definition: SigningDefinition): Promise<RequestRecord>;
  issue(ctx: CommandContext, request: VersionedId): Promise<IssueResult>;
  review(ctx: ParticipantContext, input: ReviewInput): Promise<OneUseReview>;
  sign(ctx: ParticipantContext, input: ReviewRedemption): Promise<SigningResult>;
  close(ctx: CommandContext, input: CloseInput): Promise<RequestRecord>;
  recordExternal(ctx: CommandContext, input: ExternalExecution): Promise<ExecutionRecord>;
  evidence(ctx: ReadContext, requestId: string): Promise<EvidenceBundle>;
  verify(bundle: EvidenceBundle, expectedRoot?: string): Promise<VerificationResult>;
  /** History only: no sessions, credentials, reviews, callbacks or native commitments. */
  restore(ctx: CommandContext, bundle: EvidenceBundle): Promise<RequestRecord | LegacyRecord>;
}
