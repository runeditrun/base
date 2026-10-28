import type { Decimal, ExportArtifact, ItemRef, PartyRef, Result, Selection } from '../types.ts';

export type ConformanceProfile = 'CENTS_WHOLE' | 'CENTS_THOUSANDTH' | 'CENTS_MILLIONTH' | 'EXACT_TWELVE' | 'SIX_PLACE' | 'RATIONAL_EIGHTEEN';
export type PublicOperation = 'offers' | 'selection' | 'draft' | 'review' | 'commit' | 'snapshot' | 'export';
export interface ProfileExample {
  profile: ConformanceProfile;
  arithmeticId: string;
  selection: Selection;
  total: Decimal;
  extension: Decimal;
  baseQuantity?: Decimal | null;
  baseQuantityRatio?: { numerator: string; denominator: string };
  calculationBasis?: 'exact' | 'native-final';
  inputFingerprint?: string;
}
export interface ConformanceFixture {
  /** Opaque test session selectors, never person IDs accepted as request authority. */
  actors: { buyer: string; peer: string; outsider: string };
  selection: Selection;
  foreignSelection: Selection;
  missingSelection: Selection;
  unpricedSelection: Selection;
  profiles: readonly ProfileExample[];
  /** Populated native row migrated through the adopter's real numbered upgrade. */
  history: { id: string; original: string; source: ItemRef };
  forbiddenExportStrings: readonly string[];
}
export interface EffectCounts {
  orders: number;
  outcomes: number;
  audit: number;
  paymentIntents: number;
  /** Live snapshots only; immutable restored or legacy history is counted separately. */
  snapshots: number;
  liveReceipts: number;
}
export interface RecoveryInspection {
  effects: EffectCounts;
  sessions: number;
  memberships: number;
  drafts: number;
  history: readonly { id: string; snapshot: unknown }[];
  sources: readonly { legacy_id: string; revision: string }[];
}
export interface RecoveredRuntime {
  result: Result<{ restored: number }>;
  request(actor: string | null, operation: PublicOperation, input: unknown): Promise<Result<any>>;
  inspect(): Promise<RecoveryInspection>;
  close(): Promise<void>;
}
export interface CatalogueConformanceRuntime {
  fixture: ConformanceFixture;
  /** Translate through the adopter's actual authenticated route or native command. */
  request(actor: string | null, operation: PublicOperation, input: unknown): Promise<Result<any>>;
  /** Test infrastructure only. These controls must never be shipped as application routes. */
  controls: {
    changeCommercialFacts(): Promise<void>;
    setMembership(actor: string, active: boolean): Promise<void>;
    setNativeCommitAllowed(allowed: boolean): Promise<void>;
    effects(): Promise<EffectCounts>;
    verifyArtifact(artifact: ExportArtifact): Promise<boolean>;
    restore(artifact: ExportArtifact): Promise<RecoveredRuntime>;
  };
  close(): Promise<void>;
}
export interface CatalogueConformanceAdapter {
  /** Declare only profiles this adopter actually implements; each requires a native fixture. */
  profiles: readonly ConformanceProfile[];
  /** Disposable real Worker/database, actual numbered migrations, native authentication. */
  open(): Promise<CatalogueConformanceRuntime>;
}
export function registerCatalogueOrderingConformance(input: {
  test: (name: string, run: () => Promise<void>) => unknown;
  adapter: CatalogueConformanceAdapter;
}): void;
