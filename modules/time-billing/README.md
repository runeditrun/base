# Time and billing source module

`runeditrun/base:modules/time-billing` is optional server source for Workers and
D1. It owns observed time, entry revisions, ordinary timers, exact review
history, retained ratings, source claims and immutable billing bytes. The seed
keeps its people, permissions, work records, screens and invoice engine.
Start with [ADOPTING.md](ADOPTING.md) for source provenance, migration and a
native SQL adapter. Production imports are from [index.ts](index.ts); this is
not an npm subpath or a hosted service. There is no framework, Node runtime,
operator-auth or agent-door dependency.

## Public contract

`createTimeBilling(options: Options): TimeBilling` constructs the service.
[types.ts](types.ts) exports every input/result and adapter type. Each method
takes a trusted `Context` first, created by native server authentication:

```ts
type Context = {
  installationId: string;
  personId: string;
  agentId?: string;
  sponsorId?: string;
};
type WorkRef = { kind: string; id: string };
type SourceRef = WorkRef & { revision: string };
type Write = { operationKey: string; expectedRevision: number };
```

IDs are native opaque IDs, scoped by installation. `timekeeperId` identifies
the worker; `preparerId` is recorded from the acting context. Sponsor attribution
does not make a sponsor the worker or reviewer. Never take the context from
request JSON, an unchecked header, or an email lookup.
For an agent context, `personId` is its current native human sponsor and
`sponsorId` must equal `personId`; `agentId` retains the separate agent identity.
Human contexts omit both optional fields.

| Method | Second argument | Result and effect |
| --- | --- | --- |
| `recordEntry` | `RecordInput` (`EntryInput & Write`) | New `TimeEntry`, revision 1; draft or directly approved by policy |
| `startTimer` | `StartInput` | Server-started `Timer`; policy controls overlap |
| `stopTimer` | `StopInput` (`id`, `entryId`, write) | Stops one timer and creates one `TimeEntry` atomically |
| `submit` | `EntryWrite` (`id`, write) | Exact revision becomes submitted |
| `decide` | `DecisionInput` (entry write, `decision: 'approve' \| 'return'`, `reason`) | New entry revision and content-bound review |
| `correct` | `CorrectionInput` (entry write, `replacement: EntryInput`, `reason`) | New linked entry; original history remains |
| `lock` | `EntryWrite` | Locks an approved revision against further correction/review |
| `rate` | `EntryWrite` | Retains `RatedTime`; claims no source |
| `preparePacket` | `PrepareInput` (write, `id`, `destination`, `entries: {id, revision}[]`, optional `nativeLines`) | Frozen `BillingPacket`, revision 1; claims no source |
| `commitClaims` | `CommitInput` (entry write, artifact media type and `Uint8Array` bytes) | Approved packet, exact bytes and exclusive source claims in one transaction |
| `cancelClaims` | `CancelInput` (entry write, nonempty `reason`) | Cancelled packet; releases claims with retained history |
| `readEntry` | entry ID | `EntryView` (`entry`, `reviews`), projected by current authority |
| `readPacket` | packet ID | Financial `PacketView` (`packet`, `claims`, artifact ref and bytes) |
| `exportRecords` | `WorkRef` | Financial scoped `ExportResult` (`manifest`, canonical archive `bytes`); no mutation |
| `restoreRecords` | write plus `archive: Archive` | `{restored: true}` into an empty authorized scope; restored history is inert |

`EntryInput` contains `id`, `work`, `timekeeperId`, `duration`, `billable`,
`category`, `source` and `policyId`. `TimerInput` substitutes `timezone` for
`duration`. Creation and restore require `expectedRevision: 0`; later commands
use the exact observed revision. Keep an operation key for retrying the same
payload: actor/subject/action-scoped replay returns the retained result under
current native authority, without repeating native outcomes. Changing content
under that key conflicts. GET/read/export methods never claim or commit.

`EntryRecord` is a discriminated union: `kind: 'entry'` is a complete
`TimeEntry`; `kind: 'legacy'` is locked `LegacyEntry` with nullable historical
duration, amount and currency, explicit `unknown` fields and original
`historical` data. Never cast legacy records into new entries. Time-only entry
views withhold rates and legacy amounts/currency/private historical payloads;
packet reads and exports require financial projection.

## Exact duration and rate stages

`Duration` keeps nonnegative integer `milliseconds`, lossless decimal
`original: {value, unit: 'ms' | 'second' | 'minute' | 'hour'}`, `basis:
'interval' | 'manual' | 'active-effort'`, `timezone`, `workDate` and
`datePolicy`. Intervals also require matching explicit-offset `start`/`end`.
Timers use the trusted server clock and retain boundaries and date policy.
Active-effort accumulation and heartbeat acceptance remain native.

`RateSnapshot` keeps `id`, `revision`, `currency`, exact `minorNumerator /
durationMsDenominator`, `effectiveAt`, `selectedAt` and native `source` revision.
For USD 125/hour use `minorNumerator: '12500'` and
`durationMsDenominator: '3600000'`. No binary floating-point money is used.
`selectedAt` must match the policy's `entry`, `approval` or `invoice` stage.
Entry/approval snapshots remain frozen; invoice-stage rating selects the
current native rate, and each prepared packet retains that chosen result.

Policies explicitly separate observation → capture rounding → billing
duration rounding → minor-unit rounding. For example:

```ts
import type { CapturePolicy } from './modules/time-billing/index.ts';

export const policies: readonly CapturePolicy[] = [
  {
    id: 'reviewed', revision: '1', review: 'required', rateStage: 'approval',
    manual: { incrementMs: '1', mode: 'exact' },
    timer: {
      rounding: { incrementMs: '1000', mode: 'half-up' },
      dateBasis: 'stop', overlap: 'person',
    },
    billing: { rounding: { incrementMs: '360000', mode: 'ceil' }, money: 'half-up' },
  },
  {
    id: 'manual-invoice', revision: '1', review: 'none', rateStage: 'invoice',
    manual: { incrementMs: '60000', mode: 'half-up' }, timer: null,
    billing: { rounding: { incrementMs: '3600', mode: 'half-up' }, money: 'half-up' },
  },
];
```

These are explicit examples, not a universal policy for adopting seeds.
The second models Pantry's manual/no-review variation: hundredths of observed
hours become whole minutes, then thousandths of invoice hours. At USD 125/hour:

| Profile | Observed | Captured | Billed | Amount |
| --- | --- | --- | --- | --- |
| Reviewed | `0.01 hour = 36000 ms` | `36000 ms` | `360000 ms` | `1250` cents |
| Manual invoice | `0.01 hour = 36000 ms` | `60000 ms` | `61200 ms` | `213` cents |
| Manual invoice | `4 hour = 14400000 ms` | `14400000 ms` | `14400000 ms` | `50000` cents |

Rounding supports `exact`, `ceil`, `floor`, `half-up` and an optional minimum
(a minimum is incompatible with `exact`). `manual: null`, `timer: null` or
`billing: null` disables the respective rating/timer capability; do not invent
a review or billing workflow for capture-only adopters. A capture-only profile
can retain observations without invoking rating. Pure helpers `rateTime`,
`roundDuration`, `timerDuration`, `validateDuration`, `validateRate` and
`validatePolicy` are exported; they do not authorize or commit anything.

## Claims, bytes and restore

Preparing or rating retains evidence but does not reserve an entitlement.
`commitClaims` uniquely claims `(installation, source kind, source id)` across
source revisions. Two competing packets cannot both commit. A linked correction
does not silently erase the original or authorize rebilling it; cancellation,
reversal and replacement invoice policy remain native. `NativeLine` permits
already-priced signed adjustments/cost-plus results only with a current native
calculation/source guard. Mixed-currency packets are refused.

Artifacts are bounded CSV, JSON or PDF bytes held in D1, not URLs or unverified
object-store references. `ArtifactRef` includes SHA-256 digest, media type,
byte length and `custody: 'd1'`. Bytes, claims, module state and SQL returned by
`nativeOutcome` commit atomically. Without a native outcome adapter this is
only a module commitment; it does not create or issue a native invoice.
No provider I/O belongs in that transaction.

`Archive` uses `{"format":"time-billing/1"}` and retains entries, immutable revisions,
ratings, reviews, timers, packets/claims/artifact bytes and event bodies.
`verifyArchive` checks the content digest, packet fingerprints and artifact
digest/length before custody transfer. Retain the returned archive bytes through
the seed's existing portable export/backup mechanism; a reference or digest
alone is not custody. Native invoices, people and other native data need their
own existing export coverage. Retention, legal holds and erasure remain the
seed's policy; immutable history has no public mutation/deletion API and needs
a deliberate compatible archival/erasure integration.

Restore requires native people/work/access to exist and the destination module
scope to be empty. It preserves IDs, amounts, bytes and claims; locks entries,
marks packets restored, returns submitted entries to an inert returned state,
and makes every timer inert. Source command replay keys, sessions and live
review/timer authority are not imported. Restored events retain their bodies;
destination event sequence numbers are newly allocated. Restore is an explicit
maintenance operation, not an import that resumes business commands.

## Errors and bounds

Catch `TimeBillingError` and use its closed `code` union: `invalid`, `capacity`,
`unsupported`, `not_found`, `forbidden`, `conflict`, `locked`, `custody`,
`storage`. Do not match database text or rely on error message wording.

Exported `LIMITS` describes this deliberately bounded implementation:

| Limit | Value |
| --- | --- |
| Declared policies | 16 |
| Lines per packet | 24 |
| Archive records (entries, timers, packets, revision/rating history and events combined) | 128 |
| Artifact bytes | 65,536 |
| Encoded JSON bytes per value/archive | 131,072 |
| Native outcome SQL statements per command | 8 |
| Bound parameters per SQL statement | 90 |
| Integer digits / original-duration decimal places | 24 / 9 |
| ID / operation-key characters | 128 / 128 |

SQL text is also bounded to 16,000 characters and a transaction to 256
statements; archive query tables have individual row bounds. These intersect:
an archive below the record ceiling can still exceed the JSON or restore SQL
budget. Capacity errors never mean a truncated export or successful partial
restore. Use this only where real scopes fit, or implement and prove a larger
compatible source change before adoption. Converting integer strings to a
provider's numeric API requires an explicit safe-range check.

## Supported boundary and proof

This is ordinary elapsed/manual-time storage, single-step review, additive
correction, bounded exact hourly rating and packet custody. Native multi-stage
review, employment/payroll/overtime law, schedules/breaks/punch rounding,
active-effort accumulation, clinical timed units/certification, FX, tax,
discounts, cost-plus calculation, invoice numbering/posting/payments and
provider delivery remain native. Balm clinical billing is outside adoption by
default. Capturing time never adds customer billing to a seed that has none.

The reusable [conformance entry](conformance/index.mjs) registers four compact
public-route flows; its [adapter declarations](conformance/index.d.mts) state
the real Worker/D1 requirements. The local consumer declares cases for a reviewed
profile and the manual invoice variation, including populated historical migration.
This source and its cases are not proof that another seed's permissions,
arithmetic, migration, UI or deployment are correct. Run the adopter's actual
applicable routes and seed-only journeys as described in [ADOPTING.md](ADOPTING.md).
