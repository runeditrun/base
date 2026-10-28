/** All IDs are native opaque IDs, scoped by installation. Context is server-created. */
export type WorkRef = { kind: string; id: string };
export type SourceRef = WorkRef & { revision: string };
export type Sql = { sql: string; params?: readonly (string | number | null | ArrayBuffer)[] };
export type Context = { installationId: string; personId: string; agentId?: string; sponsorId?: string };
export type Duration = {
  milliseconds: string;
  original: { value: string; unit: 'ms' | 'second' | 'minute' | 'hour' };
  basis: 'interval' | 'manual' | 'active-effort';
  timezone: string; workDate: string; datePolicy: string;
  interval?: { start: string; end: string };
};
export type Rounding = { incrementMs: string; minimumMs?: string; mode: 'ceil' | 'floor' | 'half-up' | 'exact' };
export type CapturePolicy = {
  id: string; revision: string; review: 'required' | 'none';
  rateStage: 'entry' | 'approval' | 'invoice';
  manual: Rounding | null;
  timer: null | { rounding: Rounding; dateBasis: 'start' | 'stop'; overlap: 'person' | 'work' | 'allow' };
  billing: null | { rounding: Rounding; money: 'half-up' | 'floor' | 'ceil' };
};
export type TimeEntry = {
  restored?: true;
  kind: 'entry'; id: string; revision: number; work: WorkRef; timekeeperId: string; preparerId: string;
  duration: Duration; billable: boolean; category: string;
  state: 'draft' | 'submitted' | 'approved' | 'returned' | 'void';
  corrects: string | null; source: SourceRef; policy: CapturePolicy;
  rate: RateSnapshot | null; locked: boolean; attribution: Context;
};
export type LegacyEntry = {
  kind: 'legacy'; id: string; revision: number; work: WorkRef; source: SourceRef;
  duration: Duration | null; state: string; amountMinor: string | null; currency: string | null;
  unknown: readonly string[]; historical: Readonly<Record<string, unknown>>; locked: true;
};
export type EntryRecord = TimeEntry | LegacyEntry;
export type RateSnapshot = {
  id: string; revision: string; currency: string; minorNumerator: string; durationMsDenominator: string;
  effectiveAt: string; selectedAt: 'entry' | 'approval' | 'invoice'; source: SourceRef;
};
export type RatedTime = {
  kind: 'time'; entryId: string; entryRevision: number; source: SourceRef;
  observedMs: string; capturedMs: string; billedMs: string; amountMinor: string; currency: string;
  policy: string; rate: RateSnapshot;
};
/** Cost-plus and signed financial adjustments are calculated and authorized natively. */
export type NativeLine = {
  kind: 'native'; source: SourceRef; amountMinor: string; currency: string;
  calculation: { engine: string; revision: string; basis: Readonly<Record<string, string>> };
};
export type PacketLine = RatedTime | NativeLine;
export type ArtifactRef = { id: string; digest: string; mediaType: string; byteLength: number; custody: 'd1' };
export type SourceClaim = { source: SourceRef; destination: WorkRef; packetId: string; state: 'claimed' | 'released'; revision: number };
export type BillingPacket = {
  restored?: true;
  id: string; revision: number; destination: WorkRef; currency: string; lines: readonly PacketLine[];
  totalMinor: string; state: 'prepared' | 'approved' | 'cancelled'; sourceFingerprint: string;
  artifact: ArtifactRef | null; attribution: Context;
};
export type Timer = {
  id: string; revision: number; work: WorkRef; timekeeperId: string; preparerId: string;
  startedAt: string; stoppedAt: string | null; state: 'running' | 'stopped' | 'inert';
  policy: CapturePolicy; timezone: string; category: string; billable: boolean; source: SourceRef;
  entryId: string | null; attribution: Context;
};
export type Action = 'recordEntry' | 'startTimer' | 'stopTimer' | 'submit' | 'decide' | 'correct' | 'lock' |
  'rate' | 'preparePacket' | 'commitClaims' | 'cancelClaims' | 'readEntry' | 'readPacket' | 'exportRecords' | 'restoreRecords';
export type Resource = { subject: string; work: WorkRef; timekeeperId?: string; preparerId?: string };
export type Authority = { predicate: Sql; policyRevision: string; projection: 'time' | 'financial' };
export type GuardedRate = { rate: RateSnapshot; guard: Sql };
export type Write = { operationKey: string; expectedRevision: number };
export type EntryInput = { id: string; work: WorkRef; timekeeperId: string; duration: Duration; billable: boolean; category: string; source: SourceRef; policyId: string };
export type TimerInput = Omit<EntryInput, 'duration'> & { timezone: string };
export type RecordInput = EntryInput & Write;
export type StartInput = TimerInput & Write;
export type StopInput = Write & { id: string; entryId: string };
export type EntryWrite = Write & { id: string };
export type DecisionInput = EntryWrite & { decision: 'approve' | 'return'; reason: string };
export type CorrectionInput = EntryWrite & { replacement: EntryInput; reason: string };
export type PrepareInput = Write & { id: string; destination: WorkRef; entries: readonly { id: string; revision: number }[]; nativeLines?: readonly NativeLine[] };
export type CommitInput = Write & { id: string; artifact: { mediaType: 'text/csv' | 'application/json' | 'application/pdf'; bytes: Uint8Array } };
export type CancelInput = EntryWrite & { reason: string };
export type CommandResult = EntryRecord | Timer | BillingPacket | RatedTime | SourceClaim[];
export type Outcome = { action: Action; context: Context; operationKey: string; subject: string; result: CommandResult };
export type Options = {
  database: D1Database; policies: readonly CapturePolicy[];
  /** Returns SQL over current native membership/scope/visibility in this same database. */
  authorize(context: Context, action: Action, resource: Resource): Promise<Authority>;
  /** Also resolves project/person/source validity; new writes require a current predicate. */
  entryGuard(context: Context, entry: EntryInput): Promise<Sql>;
  selectRate(context: Context, entry: TimeEntry, stage: RateSnapshot['selectedAt']): Promise<GuardedRate>;
  reviewGuard(context: Context, entry: TimeEntry, decision: DecisionInput['decision']): Promise<{ predicate: Sql; policyRevision: string }>;
  /** Native cost-plus/adjustment source validity and calculation fence. */
  nativeLineGuard?(context: Context, line: NativeLine): Promise<Sql>;
  /** SQL only, same atomic batch. No provider I/O; called only for a new command. */
  nativeOutcome?(outcome: Outcome): Promise<readonly Sql[]>;
  /** Trusted server clock, never taken from request JSON. */
  now?: () => Date;
};
export type EntryView = { entry: EntryRecord; reviews: readonly Review[] };
export type Review = { entryId: string; revision: number; decision: 'submit' | 'approve' | 'return' | 'correct' | 'lock'; personId: string; agentId: string | null; policyRevision: string; contentDigest: string; reason: string };
export type PacketView = { packet: BillingPacket; claims: readonly SourceClaim[]; artifact: { ref: ArtifactRef; bytes: Uint8Array } | null };
export type Archive = {
  format: 'time-billing/1'; installationId: string; work: WorkRef; exportedAt: string;
  history: { revisions: readonly { entryId: string; revision: number; entry: EntryRecord }[]; ratings: readonly RatedTime[] };
  entries: readonly EntryView[]; timers: readonly Timer[]; packets: readonly PacketView[];
  events: readonly { sequence: number; body: string }[];
  digest: string;
};
export type ExportResult = { manifest: Archive; bytes: Uint8Array };
export type ErrorCode = 'invalid' | 'capacity' | 'unsupported' | 'not_found' | 'forbidden' | 'conflict' | 'locked' | 'custody' | 'storage';
export interface TimeBilling {
  recordEntry(context: Context, input: RecordInput): Promise<TimeEntry>;
  startTimer(context: Context, input: StartInput): Promise<Timer>;
  stopTimer(context: Context, input: StopInput): Promise<TimeEntry>;
  submit(context: Context, input: EntryWrite): Promise<TimeEntry>;
  decide(context: Context, input: DecisionInput): Promise<TimeEntry>;
  correct(context: Context, input: CorrectionInput): Promise<TimeEntry>;
  lock(context: Context, input: EntryWrite): Promise<TimeEntry>;
  /** A retained exact result, never a source claim. */
  rate(context: Context, input: EntryWrite): Promise<RatedTime>;
  preparePacket(context: Context, input: PrepareInput): Promise<BillingPacket>;
  commitClaims(context: Context, input: CommitInput): Promise<BillingPacket>;
  cancelClaims(context: Context, input: CancelInput): Promise<BillingPacket>;
  readEntry(context: Context, id: string): Promise<EntryView>;
  readPacket(context: Context, id: string): Promise<PacketView>;
  exportRecords(context: Context, work: WorkRef): Promise<ExportResult>;
  /** Explicit empty-scope archive import. No commands or live timer/review authority resumes. */
  restoreRecords(context: Context, input: Write & { archive: Archive }): Promise<{ restored: true }>;
}
