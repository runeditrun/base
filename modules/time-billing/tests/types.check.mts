import { createTimeBilling, roundDuration, timerDuration, rateTime, verifyArchive, type Archive, type Context, type Options, type RecordInput, type TimeBilling, type TimeEntry, type RatedTime } from '../index.ts';
import { registerTimeBillingConformance, type TimeBillingConformanceAdapter } from '../conformance/index.mjs';
import { openTimeBillingRuntime } from './runtime.mjs';
import { profiles, policies } from './profiles.ts';

const adapter: TimeBillingConformanceAdapter = { profiles, open: openTimeBillingRuntime };
export function register(test: Parameters<typeof registerTimeBillingConformance>[0]['test']): void {
  registerTimeBillingConformance({ test, adapter });
}
export async function consumerTypes(options: Options, context: Context, record: RecordInput, archived: Archive): Promise<void> {
  const service: TimeBilling = createTimeBilling(options);
  const entry: TimeEntry = await service.recordEntry(context, record);
  const view = await service.readEntry(context, entry.id);
  if (view.entry.kind === 'legacy') {
    const unknown: readonly string[] = view.entry.unknown;
    void unknown;
    // @ts-expect-error Historical records never pretend to have a current rate snapshot.
    view.entry.rate;
  } else {
    const milliseconds: string = view.entry.duration.milliseconds;
    void milliseconds;
  }
  const rated: RatedTime = await service.rate(context, { id: entry.id, operationKey: 'type-rating', expectedRevision: entry.revision });
  rateTime(entry, rated.rate);
  roundDuration(entry.duration.milliseconds, { incrementMs: '1000', mode: 'half-up' });
  timerDuration('2026-11-01T05:59:59.500Z', '2026-11-01T06:00:01.000Z', 'America/New_York', policies[0]);
  await verifyArchive(archived);
  await service.restoreRecords(context, { operationKey: 'type-restore', expectedRevision: 0, archive: archived });
  // @ts-expect-error Actor context belongs to the server, not inside the public entry input.
  await service.recordEntry(context, { ...record, context });
  // @ts-expect-error Exact observed milliseconds cannot cross the public boundary as a number.
  await service.recordEntry(context, { ...record, duration: { ...record.duration, milliseconds: 36000 } });
}
