# Adopting catalogue ordering

Use [README.md](README.md) for the finalized service/types, numeric profiles and
adapter contract. This guide authorizes no seed migration, UI change or launch.
Twelve native commercial slices are candidates; only Pier, Barrow, Stall and
Larder have order engines, and only Barrow/Stall are buyer-facing catalogue/order
products. Adopt the narrow slice that already exists.

## Copy committed source and record its origin

Choose a landed full Base runtime commit. Keep its source pin separate from the
installed authoring CLI pin (`@runeditrun/rer@0.2.85`). Source reuse does not
require publishing this module as an npm runtime package. Use the seed's existing
package manager to pin that CLI; for an npm-managed seed:

```sh
npm install --save-dev --save-exact @runeditrun/rer@0.2.85
```

From the seed root, set the two source variables to the actual checkout and
full commit before running this recipe. The variables are inputs, not a claim
that an unlanded candidate has already been adopted.

```sh
BASE_CHECKOUT=/absolute/path/to/base
BASE_RUNTIME_REF=FULL_40_HEX_LANDED_BASE_COMMIT
mkdir -p src/base
git -C "$BASE_CHECKOUT" archive "$BASE_RUNTIME_REF" modules/catalogue-ordering | tar -x -C src/base
node node_modules/@runeditrun/rer/edition-authoring/cli.mjs record-base src/base/modules/catalogue-ordering modules/catalogue-ordering "$BASE_RUNTIME_REF" --base "$BASE_CHECKOUT"
node node_modules/@runeditrun/rer/edition-authoring/cli.mjs verify-base --base "$BASE_CHECKOUT"
```

This copies committed bytes, including schema template and test-only conformance
source. Production imports only `src/base/modules/catalogue-ordering/index.ts`;
never import the fixture, Node helpers or test controls into a Worker. Copies may
omit upstream tests, as described by [Copied Base source](../../edition-authoring/README.md#copied-base-source).
Keep native adapters outside the copied directory. Commit `base-copies.json`,
copied files and the seed's normal source lock and baselines together. Record the CLI
version, full runtime commit, copied origin/destination and schema provenance in
the seed's adoption evidence. Run its declared lock/check commands; the installed
authoring helper is `node node_modules/@runeditrun/rer/edition-authoring/cli.mjs`.

To refresh, first verify the old record and review the upstream module diff. Then
use the installed package, from the seed root:

```sh
node node_modules/@runeditrun/rer/edition-authoring/cli.mjs verify-base --base "$BASE_CHECKOUT"
BASE_NEXT_REF=FULL_40_HEX_NEXT_LANDED_BASE_COMMIT
./node_modules/.bin/rer refresh-base --ref "$BASE_NEXT_REF" --base "$BASE_CHECKOUT"
node node_modules/@runeditrun/rer/edition-authoring/cli.mjs verify-base --base "$BASE_CHECKOUT"
```

The public command is `rer refresh-base --ref FULL_COMMIT --base CHECKOUT`.
It may advance **every recorded copy**, including other modules: inspect that
scope and each acknowledged adaptation. For an intentional local adaptation,
use the installed helper's `adapt-base path/to/file` before refreshing and
reconcile reported upstream conflicts. Do not restore copied legacy CLI scripts.
Re-lock the edition's selected source and run its touched product checks after
refresh. Schema evolution remains a separate forward migration.

## Fresh schema and populated cutover

For a fresh installation, copy [schema/catalogue-ordering.sql](schema/catalogue-ordering.sql)
into the seed's **next unused numbered migration**, in its actual native migration
directory. The template creates `co_*` tables and immutable publication guards;
it seeds no catalogue, customer or business data. Apply it through the existing
native migration runner. Keep the numbered SQL outside refreshable module-copy
ownership and record its Base source commit separately. Never overwrite,
renumber, delete or refresh applied SQL. Later changes get new migration numbers.
If `verify-base` discovers the verbatim numbered SQL as `unrecordedCopies`, list
that seed-owned immutable migration in `base-copies.json`'s `ignore` array and
retain its source commit and digest in adoption evidence. The refreshable schema
template under the module copy remains recorded normally.

For an already populated seed:

1. Inventory the existing commercial snapshots, originals, native IDs, currencies,
   arithmetic, revisions, approvals, receipts, exports and source links. Keep native
   catalogue/stock/ledger records authoritative. Pick a bounded page/batch size and
   a durable progress/completion marker for the actual native schema.
2. Add the fresh schema in a new numbered migration. Add another forward migration
   or explicit resumable backfill under a maintenance/write fence. Preserve every
   original serialized byte; do not recompute old totals with a new profile.
3. Map each source with installation/source/kind/legacy ID/revision in
   `co_source_map`. Keep original native IDs and revision links. Fully supported
   historical facts may be copied as specified snapshots only when their real
   metadata is known. Otherwise use `LegacySnapshot` with `status:'legacy'`, exact
   `original`, native `source`, and explicit `currency:null`/`arithmetic:null` where
   unknown. Do not invent review, actor or policy facts to fit new-write types.
   Opaque originals need native visibility classification: set
   `visibility:'commercial'` only for an established commercial source format.
   Missing classification requires current cost access. The fixture's retained
   customer order document is a known commercial-only native format.
4. Insert snapshots unpublished, insert their lines, then publish inside one
   atomic bounded transaction. The SQL publication trigger verifies line count.
   Legacy rows have zero structured lines; keep their original bytes opaque.
   Use the seed's backfill for populated installs; `restoreHistory` is an
   empty-destination recovery helper, not an incremental migration API.
5. Tie out counts, native IDs, source maps, original bytes, monetary values,
   currencies, retained artifacts and exports before setting the completion
   marker and switching the single writer. An unmappable row blocks cutover with
   its ID. Never drop it, round it or assign an implicit AUD default.
6. Route existing human routes/tools to the shared service, remove the superseded
   writer and keep read/export current-authority checks. Preserve existing screens
   and native state sequences. Applied-schema correction moves forward; rollback
   code only when compatible with the new data.

Barrow's documented historical AUD convention is native evidence to preserve
when actually established, not a module default for missing historical currency.
Larder's recorded AUD→USD originals/differences and Platter's exact legacy AUD
agreements likewise remain native history. Unknown currency cannot be combined
into a new monetary total. Never seed migration data as sample business records.

## Native slices and exclusions

| Consumer | Shared slice and arithmetic | Preserve in native code |
|---|---|---|
| **Pier** | Catalogue/dated USD offers, immutable order lines; six-place quantity/price and `EXACT_TWELVE` extensions. Missing price remains unpriced. | Current stock, movements, hard reservations, backorders, price-list/tier policy and the existing command sequence. |
| **Barrow** | Account-private assortments, reviewed account/group price terms; `CENTS_MILLIONTH`, explicit current currency and one cent round per line. | Quantity/case-pack constraints, graduated pricing and Eastern-time windows. Preserve **reserve before export**, Pier stock authority and reservation key `barrow-${orderId}`. |
| **Stall** | Approved variants/personalization and guest/account commercial selection; USD `CENTS_WHOLE`. | Persist one durable local purchase **before Stripe I/O**. After verified payment, reserve Pier stock; retain paid-shortfall behavior. Payment, refunds and guest custody remain native. |
| **Larder** | Quote/sales snapshot with resolved manufacturing configuration/cost; `SIX_PLACE` quantity and money, six-place half-away rounding. | BOM/manufacturing, schedules, order amendments, exact conversions, cent accounting export and historical currency conversion evidence. |
| **Purse** | Approved catalogue reference copied into request/PO revisions; `CENTS_THOUSANDTH`, explicit configured currency. | Procurement approval, budget commitments, bundles, attachments and receiving. Do not convert POs into sales orders. |
| **Mallet** | Frozen parts/labour/fee estimate lines; USD `CENTS_THOUSANDTH`. Use trusted native-final amounts for specialized pricing. | Rate/markup precedence, minimums, upward increments, discounts/tax policy and line-specific customer authorization; tax rounds separately. |
| **Platter** | Copied proposal package lines and frozen sent/accepted prices; USD `CENTS_THOUSANDTH`. | Independent packages, private cost authority, proposal/signature workflow, exact legacy AUD agreements. Acceptance does not reserve stock. |
| **Strap** | Only intro offer → reviewed preview → once-only sale/pack; integer-cent offer using `CENTS_WHOLE`. | Digest/eligibility recheck, entitlements, recurring debt, UTC-second membership proration and separate debit consent. No generic checkout/autopay is added. |
| **Glove** | Copied service/material/task quote terms, descriptions/images/cost and signed discount lines; `CENTS_THOUSANDTH`, negative half-cent ties away from zero. | Task composition, category markup, tax, acceptance and accepted invoice terms. |
| **Pantry** | Versioned service/non-stock items and frozen estimate commercial terms; `CENTS_THOUSANDTH`, extension/tax rounded separately. | Income accounts, tax categories, financial posting, deposit/progress and invoice issue. Pier owns stock. |
| **Plinth** | Dated vendor/assembly/template source revisions and reviewed digest; `RATIONAL_EIGHTEEN` retains exact rational factors through final cent rounding. | Construction waste/productivity and assembly expansion. No universal six-place parser or recomputation of native formulas. |
| **Pencil** | Published form/revision/payment-step/product-or-choice identity and retained Checkout lines; fixed USD products/options use `CENTS_WHOLE`. | Native form calculations keep JS/Math.round semantics; freeze trusted final cents as `native-final` with input fingerprint. No global SKU/catalogue/cart/inventory. |

All consumers retain tax jurisdiction/promotion engines, customer/portal
identity, Stripe capture/refunds, delivery/returns, legal documents and native
state machines. This module introduces no stock ledger, manufacturing engine,
universal order lifecycle or new customer permissions.

## People, agents and current authority

Construct `Context` from the live native session. `actor.personId` is a stable
native person ID; email is contact/display data. Map native account/customer/
procurement/form references as opaque `PartyRef`s, not as new operators. An agent
uses its own `agentId`, live human `sponsorId` and the appropriate person mapping
through the landed agent door. Verify sponsor membership/allow-list and native
permissions on every action, including replay/read/export. A policy approval
does not grant native access or impersonate a signer.

Native tool adapters call this same service and declare actual effect classes:

| Operation | Agent class/facts |
|---|---|
| Offer/snapshot resources | Current scoped visibility; no invented `read` class. Private cost reads additionally use `sensitive` where applicable. |
| Prepare selection/draft/review | `standard`; preparation alone is not payment or commercial commitment. |
| Native order/PO/intro sale commit | `commitment` with exact reviewed value, currency and counterparty from the server snapshot. |
| Transmit PO/confirmation | Additionally `external`; preserve the native external-effect protocol. |
| Capture/refund | Separately `money`; no authority inferred from a successful selection or review. |

Use the landed door's declared currency/amount units; module decimal storage
does not define tool fact units. Declare every applicable class from actual
server data. The module's SQL guard separately enforces native authority and
revision at write time. An agent cannot widen audience, approve its own native
review, manufacture price facts or bypass a changed commercial fingerprint.

## Prove the adopter through its public door

Copy/use the test-only ESM conformance entry and its declaration. Register it with
the existing test runner and an adopter-owned real-runtime adapter:

```js
import { test } from 'node:test';
import { registerCatalogueOrderingConformance } from
  '../src/base/modules/catalogue-ordering/conformance/index.mjs';
import { openNativeCatalogueRuntime } from './support/native-catalogue-runtime.mjs';

registerCatalogueOrderingConformance({
  test,
  adapter: {
    profiles: ['CENTS_MILLIONTH'], // only profiles this native slice implements
    open: openNativeCatalogueRuntime,
  },
});
```

`openNativeCatalogueRuntime` is the adopter's test adapter, not a module runtime
export: implement the exported declaration using its real Worker/D1 schema,
public HTTP routes/commands and native session door. Test controls may seed or
mutate native records and inspect durable effects; they must not replace public
service operations with an in-memory application. The executable
[Base registration](tests/conformance.test.ts) uses the exported
[`runtime` and `supportedProfiles`](tests/runtime.mjs), the concrete
[native adapters](tests/native-adapters.mjs) and [Worker](tests/worker.mjs).
Its `CO_MODULE_ROOT` environment override bundles a copied module/schema while
keeping the same native fixture. `CO_NATIVE_ADAPTER` can select a seed-owned
adapter outside the copied tree; the disposable consumer can then prove that
refresh preserves the adapter it actually runs. For example, from Base:

```sh
CO_MODULE_ROOT=/absolute/seed/src/base/modules/catalogue-ordering \
CO_NATIVE_ADAPTER=/absolute/seed/src/native-catalogue-adapter.mjs \
node --test --test-concurrency=2 modules/catalogue-ordering/tests/*.test.ts
```

The optional adapter here implements the fixture's native schema; a real seed
instead implements its own conformance runtime and native adapters. This
copy check is separate from the adopter's own routes and populated history proof.
Only paid/network provider edges may be faked. Close every Worker/server after
each group.

The three registrations cover audience/precision/copied terms;
stale/concurrent/replay/revoked/atomic native outcomes; and scoped export with
populated history plus inert recovery. Supply each opted-in profile's real native
selection example. Include realistic existing records, two audiences, a changed
offer, native command refusal and the adopter's actual next numbered migration.
Keep Pencil formula tests native; conformance proves final-line freezing.

Run touched typechecks/tests and the actual native human/resource/export/agent
doors. Inspect existing affected screens at 1440 and 390 widths with realistic
data. Record exact commands/results, full source/CLI pins, migration numbers,
populated tie-outs and CI head. Base fixture success, source discovery or this
guide alone is not populated seed acceptance. No seed has been migrated by
adding this module documentation.
