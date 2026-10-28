import type { BillingPacket, EntryView, ExportResult, NativeLine, PacketView, SourceRef, TimeBilling, WorkRef } from '../types.ts';

export type ConformanceActor = 'worker' | 'preparer' | 'reviewer' | 'finance' | 'timeOnly' | 'outsider' | 'agent';
export interface TimeBillingProfile {
  id: string;
  policyId: string;
  review: boolean;
  timer: boolean;
  billing: boolean;
  /** Exact outputs for the retained 0.01-hour manual observation. */
  sample: { capturedMs: string; billedMs: string; at12500: string; at20000: string };
}
export type Command = Exclude<keyof TimeBilling, 'readEntry' | 'readPacket' | 'exportRecords'>;
export type CommandInput<K extends Command> = Parameters<TimeBilling[K]>[1];
export type CommandOutput<K extends Command> = Awaited<ReturnType<TimeBilling[K]>>;
export interface NativeState {
  commands: number;
  events: number;
  claims: number;
  outcomes: number;
  activeBills: number;
}
export interface TimeBillingConformanceRuntime {
  /** Must dispatch through native authenticated public command routes. Never call an imitation service. */
  command<K extends Command>(action: K, input: CommandInput<K>, actor?: ConformanceActor, installation?: string): Promise<CommandOutput<K>>;
  readEntry(id: string, actor?: ConformanceActor, installation?: string): Promise<EntryView>;
  readPacket(id: string, actor?: ConformanceActor, installation?: string): Promise<PacketView>;
  exportRecords(work: WorkRef, actor?: ConformanceActor, installation?: string): Promise<ExportResult>;
  /** Private setup hooks below use direct D1 access and are never mounted application routes. */
  source(source: SourceRef, work: WorkRef): Promise<void>;
  membership(actor: ConformanceActor, change: { active: boolean }): Promise<void>;
  reviewPolicy(change: { enabled: boolean; revision: string }): Promise<void>;
  rate(change: { minorNumerator: string; durationMsDenominator: string; revision: string }): Promise<void>;
  clock(iso: string): Promise<void>;
  outcomeFailure(enabled: boolean): Promise<void>;
  nativeState(installation?: string): Promise<NativeState>;
  nativeAdjustment?(): Promise<NativeLine>;
  /** Read the consumer's populated old public route before applying the next numbered migrations. */
  legacyRead(): Promise<{ entry: EntryView['entry']; packet: BillingPacket; claims: PacketView['claims']; bytes: Uint8Array }>;
  legacyWrite(): Promise<unknown>;
  upgrade(): Promise<void>;
  /** Create native membership/work rows only, leaving the new module scope empty. */
  target(installation: string): Promise<void>;
  restart(): Promise<void>;
  close(): Promise<void>;
}
export interface TimeBillingConformanceAdapter {
  profiles: readonly TimeBillingProfile[];
  /** Real Worker/D1, native auth and actual numbered migrations, with no application/database doubles. */
  open(options: { profile: TimeBillingProfile; populatedUpgrade?: boolean }): Promise<TimeBillingConformanceRuntime>;
}
export function registerTimeBillingConformance(input: {
  test: (name: string, run: () => Promise<void>) => unknown;
  adapter: TimeBillingConformanceAdapter;
}): void;
