import type { Decimal, Rational } from './decimal.ts';
import type { Arithmetic } from './arithmetic.ts';
export type { Decimal, Rational, Arithmetic };

export type PartyRef = { kind: string; id: string };
export type ItemRef = { source: string; id: string; revision: string };
export type Actor = { personId: string; agentId?: string; sponsorId?: string };
/** Constructed by the authenticated native route, never from request JSON. */
export type Context = { installation: string; actor: Actor };
export type Action = 'offers' | 'selection' | 'commit' | 'snapshot' | 'export';
export type SqlValue = string | number | null;
/** Trusted server SQL expression, evaluated in the same database as the write. */
export type Predicate = { sql: string; bindings: readonly SqlValue[] };
export type Statement = { sql: string; bindings: readonly SqlValue[] };
export interface Prepared {
  bind(...values: SqlValue[]): Prepared;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}
export interface Database {
  prepare(sql: string): Prepared;
  batch(statements: Prepared[]): Promise<unknown[]>;
}
export type AuthorityGrant = { revision: string; guard: Predicate; fields: 'commercial' | 'cost' };
export interface Authority {
  authorize(context: Context, action: Action, subject: PartyRef): Promise<AuthorityGrant | null>;
}
export type Offer = {
  item: ItemRef; offerId: string; revision: string; description: string;
  unit: string; price: Decimal | null; currency: string; currencyExponent: number;
  audience: PartyRef; termsRevision: string;
};
export type SelectionLine = { id: string; item: ItemRef; offerId: string; quantity: Decimal };
export type Selection = { subject: PartyRef; lines: readonly SelectionLine[] };
export type CalculationPart = {
  kind: 'price' | 'discount' | 'tax' | 'cost' | 'fee';
  amount: Decimal; source: ItemRef; visibility: 'commercial' | 'cost';
};
export type CommercialTerms = {
  revision: string; description: string; counterparty: PartyRef;
  delivery: string | null; payment: string | null;
  /** Native resolved configuration, addresses or terms: bounded canonical JSON. */
  facts: Readonly<Record<string, string | boolean | null>>;
};
export type PricingLine = {
  id: string; price: Decimal; conversion: Rational; arithmetic: Arithmetic;
  breakdown: readonly CalculationPart[];
  calculation: { basis: 'exact' } | { basis: 'native-final'; extension: Decimal; inputFingerprint: string };
};
export type PricedLine = {
  id: string; offer: Offer; quantity: Decimal; baseQuantity: Decimal | null; baseQuantityRatio: Rational;
  conversion: Rational; extension: Decimal; arithmetic: Arithmetic;
  calculationBasis: 'exact' | 'native-final'; inputFingerprint: string | null;
  breakdown: readonly CalculationPart[];
};
export type ResolvedSelection = {
  subject: PartyRef; currency: string; currencyExponent: number;
  lines: readonly PricedLine[]; total: Decimal; terms: CommercialTerms;
};
export type Draft = { id: string; revision: number; selection: Selection; previous: string | null };
export type Review = Draft & { fingerprint: string; commercial: ResolvedSelection };
export type CommercialSnapshot = ResolvedSelection & {
  status: 'specified'; id: string; revision: number; previous: string | null;
  fingerprint: string; actor: Actor;
};
/** Imported historical bytes are never interpreted as new-write authority. */
export type LegacySnapshot = {
  status: 'legacy'; id: string; subject: PartyRef; source: ItemRef;
  currency: string | null; arithmetic: string | null; original: string;
  fingerprint: string;
};
export type Snapshot = CommercialSnapshot | LegacySnapshot;
export type NativeOutcome = { kind: string; id: string; revision: string };
export type Receipt = { snapshotId: string; outcome: NativeOutcome; replay: boolean };
export interface Offers {
  list(context: Context, subject: PartyRef, page: { cursor: string | null; limit: number }): Promise<{ offers: readonly Offer[]; next: string | null; guard: Predicate }>;
  load(context: Context, subject: PartyRef, selection: readonly SelectionLine[]): Promise<{ offers: readonly Offer[]; guard: Predicate }>;
}
export interface Pricing {
  resolve(context: Context, subject: PartyRef, lines: readonly { selection: SelectionLine; offer: Offer }[]): Promise<{ lines: readonly PricingLine[]; terms: CommercialTerms; guard: Predicate }>;
}
export type FreezeInput = { draftId: string; expectedRevision: number; fingerprint: string; operation: string; key: string };
export interface NativeCommands {
  /** No I/O here. Contribute native intent/order/outcome/audit to one local batch. */
  prepareCommit(context: Context, input: { snapshot: CommercialSnapshot; operation: string; key: string }): Promise<{ guard: Predicate; postcondition: Predicate; statements: readonly Statement[]; outcome: NativeOutcome }>;
}
export type ErrorCode = 'invalid_input' | 'capacity' | 'invalid_quantity' | 'unavailable_offer' | 'unpriced_offer' | 'currency_mismatch' | 'stale_review' | 'revision_conflict' | 'authority_refused' | 'idempotency_conflict' | 'not_found' | 'source_unavailable' | 'native_conflict' | 'storage_failure' | 'invalid_artifact';
export type Result<T> = { ok: true; value: T } | { ok: false; error: { code: ErrorCode } };
export type ExportRecord = { snapshot: Snapshot; receipts: readonly { operation: string; key: string; actor: Actor; outcome: NativeOutcome }[]; events: readonly { kind: string; actor: Actor; fingerprint: string }[]; sources: readonly { source: string; kind: string; legacyId: string; revision: string }[] };
export type ExportArtifact = { format: 'catalogue-ordering/1'; records: readonly ExportRecord[]; fingerprint: string };
export interface CatalogueOrdering {
  listOffers(context: Context, input: { subject: PartyRef; cursor: string | null; limit: number }): Promise<Result<{ offers: readonly Offer[]; next: string | null }>>;
  resolveSelection(context: Context, selection: Selection): Promise<Result<ResolvedSelection>>;
  saveDraft(context: Context, input: { id: string; expectedRevision: number; selection: Selection; previous: string | null }): Promise<Result<Draft>>;
  reviewSelection(context: Context, input: { draftId: string; expectedRevision: number }): Promise<Result<Review>>;
  freezeSelection(context: Context, input: FreezeInput): Promise<Result<Receipt>>;
  readSnapshot(context: Context, input: { id: string }): Promise<Result<Snapshot>>;
  exportRecords(context: Context, input: { subject: PartyRef; after: string | null; limit: number }): Promise<Result<{ artifact: ExportArtifact; next: string | null }>>;
}
export type Options = { db: Database; authority: Authority; offers: Offers; pricing: Pricing; native: NativeCommands };
