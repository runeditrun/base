# Adopt time and billing source

Adopt only the slice already supported by the seed's contract. Keep native
screens, people, roles, work IDs, financial engines and release authority.
The [API reference](README.md) defines methods, arithmetic and capacity limits.
The following examples are server code; they add no new product page or flow.

## Copy, record and refresh source

Choose a landed full Base commit and pin the installed `@runeditrun/rer`
authoring package independently in the seed's package manifest/lock. The runtime
source pin may be newer than the published package; it does not require a
matching package release. The installed package must actually contain the
authoring commands used below. Do not resurrect copied authoring CLI scripts.

From the seed root, with `BASE_CHECKOUT` set to a local Base checkout and
`BASE_COMMIT` set to the chosen full immutable commit:

```sh
mkdir -p src/base
git -C "$BASE_CHECKOUT" archive "$BASE_COMMIT" modules/time-billing \
  | tar -x -C src/base
node node_modules/@runeditrun/rer/edition-authoring/cli.mjs record-base \
  src/base/modules/time-billing modules/time-billing "$BASE_COMMIT" \
  --base "$BASE_CHECKOUT"
node node_modules/@runeditrun/rer/edition-authoring/cli.mjs verify-base \
  --base "$BASE_CHECKOUT"
```

The destination must be absent before the first copy. Preserve relative imports;
the runtime has no sibling-module dependency. Tests/conformance may be omitted
from production copies or copied separately for test use with their own source
record. Keep deliberate seed policy, adapters and route integration outside
`src/base/modules/time-billing`, for example in `src/time-billing/`. Keep D1
types available to the seed's Worker typecheck and retain its existing bundler
support for TypeScript source imports. Never ship test fixtures or Node test
entries into browser or Worker production graphs.

For an upgrade, use the installed CLI from the seed root:

```sh
rer refresh-base --ref "$NEXT_BASE_COMMIT" --base "$BASE_CHECKOUT"
node node_modules/@runeditrun/rer/edition-authoring/cli.mjs verify-base \
  --base "$BASE_CHECKOUT"
```

Refresh may move every recorded module. Review its full changed scope,
reconcile deliberate adaptations explicitly, preserve seed adapters and run the
seed's declared lock/check commands afterward. Commit source provenance with
the adoption. Provenance verifies source bytes; it does not prove runtime
behavior. Applied seed migrations are outside the refreshed source directory.

## Apply a new numbered migration

Copy [schema/time-billing.sql](schema/time-billing.sql) into the seed's actual
migration directory under its **next unused number**. Apply it through the
existing local/deployment lifecycle before mounting the module, on the same D1
database as native membership, work, rates and invoice rows. The schema creates
only module storage, no sample people or business records.

Record the Base source commit and schema path in the seed's adoption notes.
Later schema changes require another next-numbered forward migration. Never
overwrite, renumber, delete or provenance-refresh applied SQL. See the populated
cutover recipe below before switching an existing writer.

## Supply the native adapter

`Options` requires `database`, `policies`, `authorize`, `entryGuard`,
`selectRate` and `reviewGuard`; `nativeLineGuard`, `nativeOutcome` and `now`
are optional. Even capture-only compositions supply the required hooks, while
their routes/policies reject inapplicable operations explicitly. Use a real
native rate resolver only for the billing/cost slice the seed actually has.

Hooks may read native state while preparing a command. A successful earlier
boolean check is insufficient: return current **same-database SQL predicates**
for the mutation batch. The module combines these with revision/uniqueness
fences. Bind every installation, work/person/source ID and policy revision;
whitelist any SQL identifiers. Policy edits must bump their native revision.

The complete adapter below targets an **example adapter-owned native schema**,
whose columns are shown in the local consumer's
[native schema](tests/migrations/0001-native.sql): `native_people`,
`native_work` (projects), `native_memberships`, `native_access_policy`,
`native_capture_policy`, `native_sources`, `native_rates`,
`native_review_policy` and `native_bills`. These names describe an integration
example, not new module tables or a mandated seed data model. Use the seed's
existing equivalent records and stricter policy where applicable. In this
example each project has one current rate, and native bill commitment is an
insert into existing `native_bills`; a seed with invoices/lines instead must
prepare those actual native statements, including its own revision/period
constraints. Do not install the fixture sessions, control clock or fixture
business data as production authentication/configuration.

Put the [example policies](README.md#exact-duration-and-rate-stages) in
`src/time-billing/policies.ts`, changing their type import to
`../base/modules/time-billing/index.ts`. Then create
`src/time-billing/service.ts`:

```ts
import {
  createTimeBilling, TimeBillingError,
  type Action, type BillingPacket, type Context, type Options, type Sql,
} from '../base/modules/time-billing/index.ts';
import { policies } from './policies.ts';

const finance = new Set<Action>([
  'rate', 'preparePacket', 'commitClaims', 'cancelClaims', 'readPacket',
  'exportRecords', 'restoreRecords', 'lock',
]);
const capture = new Set<Action>([
  'recordEntry', 'startTimer', 'stopTimer', 'submit', 'correct',
]);
const sql = (sql: string, params: Sql['params'] = []): Sql => ({ sql, params });

export function timeBilling(db: D1Database) {
  const options: Options = {
    database: db,
    policies,
    now: () => new Date(), // Trusted server clock; never a JSON/body timestamp.
    async authorize(ctx, action, resource) {
      const access = await db.prepare(`
        SELECT a.revision, m.can_finance FROM native_access_policy a
        JOIN native_memberships m ON m.installation=a.installation
        WHERE a.installation=? AND m.person_id=? AND m.work_id=?
      `).bind(ctx.installationId, ctx.personId, resource.work.id)
        .first<{ revision: string; can_finance: number }>();
      if (!access) throw new TimeBillingError('forbidden');
      const capability = finance.has(action) ? 'm.can_finance=1'
        : action === 'decide' ? 'm.can_review=1'
        : capture.has(action) ? 'm.can_capture=1' : 'm.can_read=1';
      const scoped = capture.has(action) && resource.timekeeperId !== undefined;
      return {
        projection: access.can_finance === 1 ? 'financial' : 'time',
        policyRevision: access.revision,
        predicate: sql(`EXISTS(
          SELECT 1 FROM native_memberships m
          JOIN native_people p ON p.installation=m.installation AND p.id=m.person_id
          JOIN native_work w ON w.installation=m.installation AND w.id=m.work_id
          JOIN native_access_policy a ON a.installation=m.installation
          WHERE m.installation=? AND m.person_id=? AND m.work_id=?
            AND ?='project' AND a.revision=? AND m.active=1
            AND p.active=1 AND w.active=1 AND ${capability}
            AND m.can_finance=?
            ${scoped ? 'AND (m.timekeeper_id IS NULL OR m.timekeeper_id=?)' : ''}
        )`, [ctx.installationId, ctx.personId, resource.work.id,
          resource.work.kind, access.revision, access.can_finance,
          ...(scoped ? [resource.timekeeperId!] : [])]),
      };
    },
    async entryGuard(ctx, entry) {
      const policy = policies.find(p => p.id === entry.policyId);
      if (!policy) throw new TimeBillingError('unsupported');
      return sql(`EXISTS(
        SELECT 1 FROM native_work w
        JOIN native_people p ON p.installation=w.installation
        JOIN native_sources s ON s.installation=w.installation AND s.work_id=w.id
        JOIN native_capture_policy c ON c.installation=w.installation
        WHERE w.installation=? AND w.id=? AND ?='project' AND w.active=1
          AND p.id=? AND p.active=1 AND s.kind=? AND s.id=?
          AND s.revision=? AND s.active=1 AND c.id=? AND c.revision=? AND c.active=1
      )`, [ctx.installationId, entry.work.id, entry.work.kind, entry.timekeeperId,
        entry.source.kind, entry.source.id, entry.source.revision,
        policy.id, policy.revision]);
    },
    async selectRate(ctx, entry, stage) {
      const r = await db.prepare(`SELECT * FROM native_rates
        WHERE installation=? AND work_id=?`)
        .bind(ctx.installationId, entry.work.id).first<{
          id: string; revision: string; currency: string;
          minor_numerator: string; duration_denominator: string; effective_at: string;
        }>();
      if (!r) throw new TimeBillingError('not_found');
      return {
        rate: { id: r.id, revision: r.revision, currency: r.currency,
          minorNumerator: r.minor_numerator, durationMsDenominator: r.duration_denominator,
          effectiveAt: r.effective_at, selectedAt: stage,
          source: { kind: 'native-rate', id: r.id, revision: r.revision } },
        guard: sql(`EXISTS(SELECT 1 FROM native_rates WHERE installation=?
          AND work_id=? AND id=? AND revision=? AND currency=?
          AND minor_numerator=? AND duration_denominator=? AND effective_at=?)`,
          [ctx.installationId, entry.work.id, r.id, r.revision, r.currency,
            r.minor_numerator, r.duration_denominator, r.effective_at]),
      };
    },
    async reviewGuard(ctx, entry) {
      const r = await db.prepare(`SELECT revision FROM native_review_policy
        WHERE installation=? AND work_id=?`)
        .bind(ctx.installationId, entry.work.id).first<{ revision: string }>();
      if (!r) throw new TimeBillingError('forbidden');
      return { policyRevision: r.revision, predicate: sql(`EXISTS(
        SELECT 1 FROM native_review_policy r JOIN native_memberships m
          ON m.installation=r.installation AND m.work_id=r.work_id
        WHERE r.installation=? AND r.work_id=? AND r.revision=? AND r.enabled=1
          AND m.person_id=? AND m.active=1 AND m.can_review=1
          AND m.person_id<>? AND m.person_id<>?
      )`, [ctx.installationId, entry.work.id, r.revision, ctx.personId,
        entry.timekeeperId, entry.preparerId]) };
    },
    async nativeOutcome(outcome) {
      if (outcome.action !== 'commitClaims' && outcome.action !== 'cancelClaims') return [];
      const p = outcome.result as BillingPacket;
      const i = outcome.context.installationId;
      if (outcome.action === 'commitClaims') return [sql(`
        INSERT INTO native_bills(installation,packet_id,state,amount_minor,currency)
        VALUES(?,?,'approved',?,?)`, [i, p.id, p.totalMinor, p.currency])];
      if (p.artifact === null) return []; // Cancelling an uncommitted prepared packet.
      return [
        sql(`UPDATE native_bills SET state='cancelled' WHERE installation=?
          AND packet_id=? AND state='approved' AND amount_minor=? AND currency=?`,
          [i, p.id, p.totalMinor, p.currency]),
        // native_bills CHECK permits only approved/cancelled: refuse absent/mismatched bills.
        sql(`INSERT INTO native_bills(installation,packet_id,state,amount_minor,currency)
          SELECT ?,?,'refused',?,? WHERE NOT EXISTS(SELECT 1 FROM native_bills
            WHERE installation=? AND packet_id=? AND state='cancelled'
              AND amount_minor=? AND currency=?)`,
          [i, p.id, p.totalMinor, p.currency, i, p.id, p.totalMinor, p.currency]),
      ];
    },
  };
  return createTimeBilling(options);
}

export type NativeTimeContext = Context;
```

Native context comes from the seed's verified session/agent door, with
installation chosen by server configuration or verified membership. Native
people IDs are stable; email remains contact/display data. The example checks
the financial projection against the current membership again inside the batch.
More detailed field visibility, timekeeper scopes, principal exceptions,
reviewer separation, corrector exclusions or whole-sheet coverage must use the
seed's real predicates. `reviewGuard` also receives the decision when policy
distinguishes approval from return. It must not grant native sign-off merely
because an agent policy allowed the tool call.

Rate precedence, applicability dates and rounding are product policy. The
example's one-current-rate query is appropriate only for that example schema;
replace it with the seed's real resolver and a predicate that fences every
selected rate fact, including the selected revision and effective period.
Keep original rate/currency/precision at the seed's existing entry, approval or
invoice selection stage. Do not refresh historical snapshots to current rates.

`nativeLineGuard` is required before accepting already-priced native lines.
It must fence source kind/ID/revision, work visibility, amount/currency and the
native calculation revision/basis in this same database. The module performs no
cost-plus, discount, tax, FX or clinical calculation on those lines.

`nativeOutcome` returns at most eight SQL statements, not executed writes or
provider calls. They run after module mutations in the same atomic D1 batch,
only for a new command. A native failure rolls back module state, claims and
bytes; replay does not repeat native effects. The example uses the native bill
table's actual constraints to refuse an inconsistent cancellation. Actual
invoice adapters must likewise assert expected native revisions, periods,
amounts and authorization; a zero-row UPDATE alone is not proof of commitment.
Omitting the hook provides no atomic native invoice commitment. Restore does
not invoke it or recreate native invoices.

## Mount through existing authenticated routes

Existing routes should parse/validate their normal request schema and call the
same service, for example:

```ts
import { timeBilling, type NativeTimeContext } from './service.ts';

export async function recordManualTime(db: D1Database, ctx: NativeTimeContext) {
  // ctx is already authenticated; work, source and worker must exist natively.
  return timeBilling(db).recordEntry(ctx, {
    id: 'time-42', operationKey: 'record-time-42', expectedRevision: 0,
    work: { kind: 'project', id: 'project-7' }, timekeeperId: ctx.personId,
    source: { kind: 'work-log', id: 'log-42', revision: '1' },
    policyId: 'manual-invoice', category: 'service', billable: true,
    duration: { milliseconds: '14400000', original: { value: '4', unit: 'hour' },
      basis: 'manual', timezone: 'Australia/Brisbane', workDate: '2026-10-28',
      datePolicy: 'native-work-date@1' },
  });
}
```

For a frameworkless Fetch mount, this optional adapter handles only a projected
entry read and a single named manual capture command. Add other methods
explicitly with the seed's normal request validation, CSRF controls and route
permissions. Do not expose `restoreRecords` as a general command-dispatch route.

```ts
import {
  LIMITS, TimeBillingError, type ErrorCode, type RecordInput, type TimeBilling,
} from '../base/modules/time-billing/index.ts';
import type { NativeTimeContext } from './service.ts';

export async function handleTimeBilling(
  request: Request, service: TimeBilling, ctx: NativeTimeContext,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const entry = /^\/api\/time\/entries\/([^/]+)$/.exec(path);
  if (!entry && path !== '/api/time/entries') return null;
  try {
    if (entry && request.method === 'GET') {
      let id: string;
      try { id = decodeURIComponent(entry[1]); }
      catch { throw new TimeBillingError('invalid'); }
      return Response.json(await service.readEntry(ctx, id));
    }
    if (!entry && request.method === 'POST') {
      // Bound the decoded UTF-8 bytes even when Content-Length is absent/untrusted.
      const reader = request.body?.getReader();
      if (!reader) throw new TimeBillingError('invalid');
      const chunks: Uint8Array[] = [];
      let length = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > LIMITS.jsonBytes) { await reader.cancel(); throw new TimeBillingError('capacity'); }
        chunks.push(value);
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      let input: unknown;
      try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
      catch { throw new TimeBillingError('invalid'); }
      if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        throw new TimeBillingError('invalid');
      }
      // The module validates RecordInput fields; the cast supplies no authority.
      return Response.json(await service.recordEntry(ctx, input as RecordInput), { status: 201 });
    }
    return new Response(null, { status: 405, headers: { Allow: entry ? 'GET' : 'POST' } });
  } catch (error) {
    if (!(error instanceof TimeBillingError)) throw error;
    const status: Record<ErrorCode, number> = {
      invalid: 400, capacity: 413, unsupported: 422, not_found: 404,
      forbidden: 403, conflict: 409, locked: 409, custody: 409, storage: 503,
    };
    return Response.json({ code: error.code }, { status: status[error.code] });
  }
}
```

In the existing Worker fetch handler, resolve `ctx` through native verified
authentication first, call `handleTimeBilling(request, timeBilling(env.DB), ctx)`
and return a non-null response. Continue normal routing on null. Retain existing
setup/session/CSRF/error handling. No body field can replace `ctx`. For malformed
untyped input, the seed's normal schema validator should reject before calling
the module; TypeScript casts do not constitute validation. The adapter adds no
generic Fetch API to the core service.

## Populated upgrade and writer cutover

Do this on a representative populated copy before deployment, then repeat the
verified numbered sequence against the real installation under its native
maintenance/write fence:

1. Capture old public reads and portable exports, including original IDs,
   states, timestamps/units/date policy, rates/selection stage, currencies,
   amounts, approvals, invoice/source ties and actual artifact bytes/digests.
   Record the mapping from each native source/revision to module identity.
2. Append the next unused schema migration, followed by a new numbered
   seed-owned backfill migration. Preserve old tables/readability. Backfill
   exact module rows and required revision history, source maps, packet lines,
   claims and D1 artifacts with their original bytes. Do not run current rating
   or manufacture historical reviewers/approvals to fill gaps.
3. Use `LegacyEntry` for genuinely missing facts: `kind: 'legacy'`, original
   `id`, `revision`, `work`, `source`, nullable `duration`, original `state`,
   nullable `amountMinor`/`currency`, explicit `unknown`, original `historical`
   payload and `locked: true`. Preserve known original amount/currency even
   when current defaults differ. New complete entries must satisfy their
   configured profile. Legacy rows stay readable and cannot be rated/corrected
   as if they were newly reviewed entries.
4. Keep the backfill bounded and atomic, or use resumable numbered steps with
   an explicit native completion marker. Verify counts, every source tie,
   exact monetary totals/currencies, review evidence and artifact bytes/digests
   against the pre-upgrade public evidence. Prove the new public reads and
   export on the populated database, not merely an empty install.
5. Stop the old writer with the seed's native cutover marker/fence, finish the
   final reconciliation under that fence, and enable the new sole writer only
   when the completion marker and checks agree. Exercise the old public write
   route and prove it refuses. Do not retain a hidden fallback or dual writer.

Unrepresentable history **blocks cutover**: report exact IDs and reasons.
Examples include missing issued artifact bytes/digest, contradictory or
duplicate active source claims, unmappable native identities, required review
facts that the union cannot honestly retain, or records exceeding supported
bounds. `unknown` is not permission to invent or drop a fact. Do not silently
truncate, reprice, reround, change currency or replace issued bytes. Existing
retention/hold/erasure and installation archive policies still apply. Applied
schema recovery is a new forward migration; old code is usable only if it is
compatible with the resulting data and single-writer fence.

## Agent resources and effect classes

The domain module has no agent-door dependency. After the seed adopts the
landed door, register wrappers calling this same service with current native
person ID, agent attribution and live sponsor membership/allow-list checks.
There is no alternate agent mutation path and no email primary key. A sponsor
is not automatically the timekeeper, approver, signer or an operator account.

| Actual operation/effect | Door classification and resource |
| --- | --- |
| Capture/timer/submission/review/correction/lock, rating and draft packet preparation | `standard`; scoped entry/timer/review history or packet |
| Scoped entry/packet/claim/export-manifest read | Current native visibility; reads have no invented `read` class |
| Private rate/pay/personnel access | Add `sensitive` where the actual returned fields require it |
| Provider/customer export or delivery | Add `external`; scope the actual destination and artifact |
| Native bill/invoice commitment (`commitClaims` when wired to native commitment) | Add `commitment`; classify the actual native effect and server amount |
| Money movement | Separate native `money` effect; no module method moves funds |
| Cancellation/restoration or other native actions | Classify all actual additional effects under the landed door's published classes and policy |

Class facts come from server-reviewed packet/native results, not client amount
or risk flags. Use the door's published amount/currency units rather than
assuming they match integer minor-unit storage. Policy permission does not
grant a native permission or sign-off. Preserve the seed's real reviewer,
principal/self-review, project and period rules. Withhold amounts from time-only
resources and recheck visibility on export and replay.

## Register real public conformance

The test-only [conformance entry](conformance/index.mjs) exports
`registerTimeBillingConformance`; [index.d.mts](conformance/index.d.mts) exports
`TimeBillingConformanceAdapter`, `TimeBillingConformanceRuntime`,
`TimeBillingProfile`, `ConformanceActor` and command types. Register the same
four groups through the adopter's test runner:

```ts
import { test } from 'node:test';
import { registerTimeBillingConformance } from '../src/base/modules/time-billing/conformance/index.mjs';
import { adapter } from './time-billing-native-adapter.mjs';

registerTimeBillingConformance({ test, adapter });
```

Implement `adapter` against the declarations, backed by the adopter's actual
Worker, native authentication and real D1 with its numbered migrations.
`profiles` declare applicable review/timer/billing capabilities and exact sample
outputs; unsupported capabilities are skipped explicitly, never fake success.
`open({profile, populatedUpgrade})` provides authenticated public `command`,
`readEntry`, `readPacket` and `exportRecords` calls. Native hooks `source`,
`membership`, `reviewPolicy`, `rate`, `clock`, `outcomeFailure`, `nativeState`,
optional `nativeAdjustment`, `legacyRead`, `legacyWrite`, `upgrade`, `target`,
`restart` and `close` are private fixture lifecycle/control hooks, not mounted
application routes. The Base [registration](tests/conformance.test.ts) and
[runtime adapter](tests/runtime.mjs) are test-only integration examples;
`openTimeBillingRuntime` is declared in [runtime.d.mts](tests/runtime.d.mts).
Its container/toolchain imports are test dependencies, not runtime dependencies
of copied production source. `legacyRead` uses the old populated public route before
the real next migrations; `target` creates native membership/work only, leaving
the restore scope empty. Always close Workers and temporary resources.

The groups cover observation/identity/current authority, exact review and
additive correction/locks, rating/claim contention/replay/cancellation, and
populated upgrade/export/inert restore with bytes. Preserve meaningful native
journeys for payroll, active effort, multi-stage review and cost-plus; the
generic profiles cannot prove those algorithms. Verify applicable DST/local
dates, rounding boundaries, snapshot versus current rates, native transaction
rollback, revoked authority and actual human/agent routes. Keep existing
record → review → packet/export screens usable at 1440/390 where they already
exist. Base conformance is reusable evidence, not an adoption or deployment
certificate; record only the exact adopter checks actually run.
