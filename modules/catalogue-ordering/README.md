# Catalogue ordering

Optional Workers/D1 server source for audience-scoped offer selection, exact
commercial lines, reviewed immutable snapshots and once-only native commitments.
Import [index.ts](index.ts) directly; no npm runtime export, framework, storefront
or agent-door dependency is required. [ADOPTING.md](ADOPTING.md) covers copying,
refresh, populated migration and the twelve deliberately different consumers.

The native application owns catalogue editing, identity, pricing policy, stock,
payments and its routes/screens. This module owns the common draft, arithmetic,
review, snapshot, receipt, source-map and local atomic publication mechanisms.

## Construct and mount

Keep application adapters outside the copied directory. All five adapters are
required; there is no permissive default adapter.

```ts
import {
  createCatalogueOrdering,
  parseDecimal,
  type Actor,
  type CatalogueOrdering,
  type Context,
  type Options,
} from './base/modules/catalogue-ordering/index.ts';

// options is constructed on the server from the native DB and adapters below.
export function mountCatalogue(options: Options, installation: string) {
  const service = createCatalogueOrdering(options);
  return async function catalogueRequest(
    request: Request,
    actor: Actor, // resolved by the existing authenticated route/session
  ): Promise<Response> {
    const context: Context = { installation, actor };
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname.startsWith('/catalogue/snapshot/')) {
      return Response.json(await service.readSnapshot(context, {
        id: decodeURIComponent(url.pathname.slice('/catalogue/snapshot/'.length)),
      }));
    }
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    let input;
    try { input = await request.json(); }
    catch { return Response.json({ ok: false, error: { code: 'invalid_input' } }); }
    switch (url.pathname) {
      case '/catalogue/offers': return Response.json(await service.listOffers(context, input));
      case '/catalogue/selection': return Response.json(await service.resolveSelection(context, input));
      case '/catalogue/draft': return Response.json(await service.saveDraft(context, input));
      case '/catalogue/review': return Response.json(await service.reviewSelection(context, input));
      case '/catalogue/commit': return Response.json(await service.freezeSelection(context, input));
      case '/catalogue/export': return Response.json(await service.exportRecords(context, input));
      default: return new Response(null, { status: 404 });
    }
  };
}

// The same service is callable from an existing route or native agent tool.
export async function reviewedPurchase(service: CatalogueOrdering, context: Context) {
  const saved = await service.saveDraft(context, {
    id: crypto.randomUUID(), expectedRevision: 0, previous: null,
    selection: {
      subject: { kind: 'trade-account', id: 'account-17' },
      lines: [{ id: 'line-1',
        item: { source: 'native-catalogue', id: 'item-42', revision: '7' },
        offerId: 'account-offer-42', quantity: parseDecimal('1.250', 3) }],
    },
  });
  if (!saved.ok) return saved;
  return service.reviewSelection(context, {
    draftId: saved.value.id, expectedRevision: saved.value.revision,
  });
}
```

Pass the returned review to the native human/agent review step. After that review,
call `freezeSelection(context, {draftId: review.id, expectedRevision:
review.revision, fingerprint: review.fingerprint, operation: 'native-order', key:
durableOperationKey})`. Keep that exact input for retries. A preview or successful
calculation alone does not authorize commitment. The example paths are an optional
mount; adopters retain their existing public paths, request limits and HTTP status
conventions. Authenticate before invoking it; never read `Context` or `Actor` from
request JSON. GET only reads.

## Server adapters and transaction contract

The closed interfaces are in [types.ts](types.ts). The concrete
[`nativeOptions(db, session)` adapter](tests/native-adapters.mjs) implements all
five options with native D1 records, revision predicates and a native order,
command outcome, audit and durable payment intent. The
[Worker mount](tests/worker.mjs) resolves native sessions before calling it;
[runtime.mjs](tests/runtime.mjs) creates real disposable D1 and applies numbered
fresh/populated migrations. These files are test-only source, not application
dependencies. The fixture's permissions apply equally to its test actions;
production adapters must implement each native action's actual permissions.

| Option | Required native implementation |
|---|---|
| `db` | A D1-compatible database with atomic `batch`, prepared bindings, `first`, `all` and `run`. All guard predicates and native SQL execute in this same database. |
| `authority.authorize(context, action, subject)` | Resolve current native person/sponsor permissions for the specific `offers`, `selection`, `commit`, `snapshot` or `export` action. Return `null` to refuse; otherwise return `{revision, fields, guard}`. The guard is a bound SQL boolean expression checking the live membership, action permission, audience and permission revision, not a cached session boolean. |
| `offers.list` / `offers.load` | Load currently visible, available native offers. Return a revision/state guard. `load` returns exactly one offer per selected line, in selection order, matching item/source/revision/offer identity. Prices, audiences, currencies and terms revisions come from trusted native records. Remote failure remains explicit. |
| `pricing.resolve` | Resolve native tiers, unit rules, discounts, tax and terms from the loaded offers. Return matching line IDs/order, exact price/conversion/profile, typed breakdown and a guard covering all commercial inputs, including account terms and configuration revisions. |
| `native.prepareCommit` | Prepare at most twelve local order/intent/command/audit statements, an exact native precondition guard, a postcondition proving the expected native outcome exists, and `{kind,id,revision}` identifying that outcome. No network/provider I/O. |

For example, a native permission guard can be `EXISTS(SELECT 1 FROM
native_memberships WHERE installation=? AND person_id=? AND account_id=? AND
can_order=1 AND revision=?)`, with values bound from the authenticated context,
resolved subject and current membership revision. The actual native schema and
each action's predicate belong to the adopter. Include current agent/sponsor
checks where applicable. Never use client SQL or `guard: {sql:'1',bindings:[]}`
for an authorization or mutable native state boundary.

Write batches assert authority and draft, offer, pricing and native revisions,
publish the snapshot/lines, execute native statements, assert the native
postcondition, and record the receipt/event/source map together. A failed guard
rolls the batch back. Native statements must reference the prepared snapshot ID
and their expected native revision; a conditional SQL update affecting zero rows
is not proof of success. Prepare an outcome whose existence/state is checked by
the postcondition. A remote reservation/payment cannot join this transaction.

Review binds installation, actor, draft, resolved commercial facts and authority
revision, which is retained as `authorityRevision` on the snapshot. Editing a
draft clears its review. Commit resolves current facts again;
changed facts require another review. Replay checks current authority, requires
the exact actor and full freeze input, and recovers the existing receipt without
repeating native effects. Amendments use a new draft with `previous` pointing at
the existing same-subject snapshot; they never update that snapshot.

`fields: 'commercial'` removes cost-visible breakdown entries from specified
results. `fields: 'cost'` allows those entries. The native resolver must keep
private cost out of commercial totals, descriptions and facts: projection cannot
infer an embedded secret. Legacy `original` bytes are opaque and are not field
redacted. Only a legacy record explicitly classified `visibility:'commercial'`
is returned to commercial-only readers; absent/unknown visibility requires cost
access. Classify from established native source evidence during migration,
or preserve a separately approved commercial projection. Do not label unknown
opaque history commercial merely to make it readable.

## Arithmetic and source evidence

Decimals represent `coefficient / 10**scale`, with integer strings and bigint
arithmetic. Money is expressed in major currency units: USD 1.25 is
`{coefficient:'125', scale:2}`. `currencyExponent` describes currency metadata;
it does not silently rescale a stored extension or convert currency.

Only the complete revision-1 built-in profiles are accepted:

| Export | Quantity scale ≤ | Price scale ≤ | Extension scale | Final rounding |
|---|---:|---:|---:|---|
| `CENTS_WHOLE` | 0 | 2 | 2 | half away from zero |
| `CENTS_THOUSANDTH` | 3 | 2 | 2 | half away from zero |
| `CENTS_MILLIONTH` | 6 | 2 | 2 | half away from zero |
| `EXACT_TWELVE` | 6 | 6 | 12 | exact; refuse loss |
| `SIX_PLACE` | 6 | 6 | 6 | half away from zero |
| `RATIONAL_EIGHTEEN` | 18 | 18 | 2 | half away from zero |

`priceExtension(quantity, price, profile, {numerator,denominator})` multiplies the
exact rational converted quantity and price before one final rounding. All
profiles require exact representable base quantities at their quantity scale,
except `RATIONAL_EIGHTEEN`: it preserves a nonterminating quantity as
`baseQuantityRatio` with `baseQuantity: null`. Quantities/conversion factors must
be positive; signed prices support native discount lines. Negative half-cent
ties round away from zero. Parsing rejects whitespace/exponent notation and
over-precision, never rounds an input. Helpers throw `TypeError`/`RangeError`;
service methods return the result union below.

`PricingLine.calculation: {basis:'exact'}` uses this multiplication. A specialized
native result uses `{basis:'native-final', extension, inputFingerprint}` with the
final extension at the declared profile scale and a nonempty fingerprint of at
most 128 characters. It retains trusted final amounts, native source revisions,
profile and bounded breakdown/facts. It does **not** prove or recompute a native
formula, tier engine, tax engine or Pencil expression. Its quantity, price and
conversion must still satisfy the selected profile. A fingerprint is evidence of
which inputs were used, not authorization or a signature.

All lines in a new selection require the same explicit three-letter uppercase
currency and currency exponent. Totals add at the highest line extension scale
without rounding away precision. A missing price is unpriced;
zero is a price. No automatic FX or legacy currency inference occurs.

## Results and bounds

Every service method returns `{ok:true,value}` or `{ok:false,error:{code}}`.
The public error codes are:

| Codes | Meaning/action |
|---|---|
| `invalid_input`, `invalid_quantity`, `capacity` | Closed input shape, exact quantity/profile or bounded payload refused. Correct the request. |
| `unavailable_offer`, `unpriced_offer`, `currency_mismatch` | Source identity/availability, missing price or incompatible monetary metadata. Resolve native facts before review. |
| `stale_review`, `revision_conflict` | Commercial/review/draft state changed. Reload and review the current revision. |
| `authority_refused`, `not_found` | Current permission refused or requested local record absent. |
| `idempotency_conflict` | Operation key already belongs to different content/actor. Never automatically change the key and resubmit. |
| `source_unavailable`, `native_conflict`, `storage_failure` | Native source failed, native guarded outcome could not be committed, or storage failed. Recover through native durable operation/replay rules. |
| `invalid_artifact` | Export checksum/shape failed recovery validation. |

`LIMITS` exports the runtime bounds: 40 selection lines, pages of 1–50, 16
breakdown entries per line, 32 scalar term facts, 4,096-character descriptions,
128-character ordinary identifiers, 36-digit external coefficients, scales 0–18,
240,000-byte canonical snapshots and 800,000-byte export artifacts. Computed
arithmetic permits 96-digit coefficients. Currency exponents are integers 0–6.
Native statements/guard expressions allow at most 80 bindings and 8,000 SQL
characters each; native commits allow twelve statements. JSON objects reject
unknown fields; optional fields are only those declared in [types.ts](types.ts).

## Export, recovery and retention

`exportRecords` is a current-authority, subject-scoped page with `after`/`next`.
It includes immutable snapshots, receipts, actor/event evidence and source maps.
`verifyExportArtifact` checks its canonical SHA-256 checksum; this is **not a
signature**, trusted origin or permission to import/replay anything. Keep the
native business export and installation archive doors distinct.

`restoreHistory(db, {installation, artifact})` is an administrative helper for a
separately authorized, write-fenced empty destination. It restores one bounded
artifact atomically, refuses existing drafts/snapshots and batches above 900
statements, retains history/source maps and marks receipts inert (`live=0`). It
creates no drafts, native orders, sessions, memberships, provider credentials or
payment/stock authority. Do not expose it as a customer/agent restore route or
call it once per page against the same installation; larger installation recovery
needs the native archive workflow. Re-establish current native authority and
integration configuration separately.

Published snapshots/lines, receipts, events and source maps are append-only.
There is no erasure/retention API. The adopter must settle lawful retention and
redaction boundaries before writing personal data to immutable terms or opaque
legacy bytes; a scoped export is not a deletion operation. Retain referenced
native artifacts and exact historical source bytes for the required period.

## Reusable public-door conformance

[conformance/index.mjs](conformance/index.mjs) exports
`registerCatalogueOrderingConformance({test, adapter})`. The adapter explicitly
lists supported profiles and opens the adopter's real Worker/routes or commands.
It registers three bounded groups: audience/arithmetic/immutable terms;
review/replay/revocation/atomic native outcome; scoped export/populated upgrade/
inert recovery. Test-private controls seed/change native records and inspect
effects; production operations dispatch through the real public door. See the
declaration beside the ESM entry and the executable fixture under [tests](tests).
Passing this Base fixture establishes no seed adoption or finished storefront.
