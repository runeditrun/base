# Adopting agreement signing

The service is optional copied server source. Retain the edition's existing
routes, people, source/selection serializer, screens, artifact store and native
permissions. The service becomes the only live writer for the adopted signing
flow. Public types in [types.ts](types.ts) govern these examples.

## Build the native boundary

Create the adapters beside, rather than inside, `src/base/modules/agreement-signing`.
For example use `src/signing/native.ts` for the current source/session predicates,
native outcome statements and artifact custody. Importing an adapter into the
copied module would turn a refreshable shared source copy into edition code.

`ReadContext.authority` and both guard callbacks return a trusted SQL boolean
expression, such as `EXISTS(SELECT 1 FROM ... WHERE ...)`, that is true only while
the native authorization remains valid. Do not return a standalone `SELECT`
statement. Bind values through `params`. The module composes these predicates into its same-database
checks; never accept SQL, actor, sponsor, subject, session binding, authentication
or peer metadata from a request body. Verify actual session revocation/rotation,
not just a cookie's former validity. An authorization query must cover the
entire evidence bundle when calling `evidence`, including private documents,
consent wording, signer images, actions and audit fields. A grant for one visible
document does not authorize that bundle.

`sourceGuard(ctx, definition, operation)` must fence the native source ID and
revision, exact current approved bytes/digest, selection/options/quantities and
applicable state. Include source/category/mailbox changes that void authority
in the particular product. Hash the same canonical native snapshot used at
preparation; do not recompute a historical agreement from today's mutable prices.

`participantGuard(ctx, request, participant, binding)` must fence the live native subject,
session/assertion binding and actual authentication basis for that participant,
plus witness/group order, guardian/delegate scope, HR/category rights or other
native constraints. Staff launching a tablet does not acquire its participant's
authority. An email string is contact data, not a stable person key or a session.
For review/redemption the binding contains the exact proposed fields and act;
fence the allowed field names/values against native policy and the approved
selection in SQL. For recovery of an already committed command it is `null`:
check current participant authority without creating a new act. Retained actions
contain only `bindingDigest`, never the live session/assertion secret.

`nativeCommit` returns no more than eight same-D1 statements for native outcome
and audit changes. These join the module's transaction: do not run them yourself,
send mail, call providers or write a second signing record outside that commit.
Refuse a cutover that requires two competing live writers. Rendering in
`finalize` is pure; immutable `artifacts.put` owns object writes. Store the
AES-GCM credential key in persistent secret custody with `encrypt` and `decrypt`
usage, excluded from installation archives. Do not generate a new key per
request or recover it from an archive. Loss/rotation of that key must be handled
as loss/revocation of pending invitation replay authority, not new permission.

## Service and Fetch mounting

This complete mount leaves native authorization explicit. `NativeBoundary` is
implemented with the edition's current server-session API and its real D1
schema. The module has no generic HTTP handler and adds no account store.
Pass a server-loaded source definition to preparation in the native route;
the body is input to native approval policy, never proof of approval.

```ts
// src/signing/routes.ts
import { createSigningService, SigningError } from '../base/modules/agreement-signing/index.ts';
import type {
  CloseInput, CommandContext, ExternalExecution, ParticipantContext,
  ReadContext, ReviewInput, ReviewRedemption, SigningDefinition, SigningOptions,
  VersionedId,
} from '../base/modules/agreement-signing/types.ts';

type Command = 'prepare' | 'issue' | 'close' | 'external';

export interface NativeBoundary {
  // All context methods resolve the CURRENT native server session, effective
  // resource permission and trusted peer. They refuse invalid sessions.
  command(request: Request, operation: Command, id: string | null): Promise<CommandContext>;
  participant(request: Request, operation: 'review' | 'sign', id: string): Promise<ParticipantContext>;
  evidence(request: Request, id: string): Promise<ReadContext>;
  approvedDefinition(request: Request, ctx: CommandContext): Promise<SigningDefinition>;
}

async function signingBody<T extends object>(request: Request): Promise<T> {
  const value: unknown = await request.json();
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SigningError('invalid_input');
  }
  return value as T;
}

export function mountSigning(options: SigningOptions, native: NativeBoundary) {
  const signing = createSigningService({
    database: options.database,
    sourceGuard: options.sourceGuard,
    participantGuard: options.participantGuard,
    nativeCommit: options.nativeCommit,
    artifacts: options.artifacts,
    credentialKey: options.credentialKey,
    invitations: options.invitations,
    ...(options.finalize ? { finalize: options.finalize } : {}),
    ...(options.now ? { now: options.now } : {}),
  });

  return async function signingRoute(request: Request): Promise<Response | null> {
    const path = new URL(request.url).pathname;
    try {
      if (path === '/api/agreements' && request.method === 'POST') {
        const ctx = await native.command(request, 'prepare', null);
        const definition = await native.approvedDefinition(request, ctx);
        return Response.json(await signing.prepare(ctx, definition), { status: 201 });
      }
      const match = /^\/api\/agreements\/([^/]+)\/(issue|review|sign|close|external|evidence)$/.exec(path);
      if (!match) return null;
      const id = decodeURIComponent(match[1]);
      const action = match[2];
      if (action === 'evidence' && request.method === 'GET') {
        return Response.json(await signing.evidence(await native.evidence(request, id), id));
      }
      if (request.method !== 'POST' || action === 'evidence') {
        return new Response('Method not allowed', { status: 405 });
      }
      switch (action) {
        case 'issue': {
          const body = await signingBody<Pick<VersionedId, 'revision'>>(request);
          return Response.json(await signing.issue(
            await native.command(request, 'issue', id), { id, revision: body.revision },
          ));
        }
        case 'review': {
          const body = await signingBody<ReviewInput>(request);
          return Response.json(await signing.review(
            await native.participant(request, 'review', id),
            { ...body, request: { id, revision: body.request?.revision } },
          ));
        }
        case 'sign': {
          const body = await signingBody<ReviewRedemption>(request);
          return Response.json(await signing.sign(
            await native.participant(request, 'sign', id), { ...body, requestId: id },
          ));
        }
        case 'close': {
          const body = await signingBody<CloseInput>(request);
          return Response.json(await signing.close(
            await native.command(request, 'close', id),
            { ...body, request: { id, revision: body.request?.revision } },
          ));
        }
        case 'external': {
          const body = await signingBody<ExternalExecution>(request);
          return Response.json(await signing.recordExternal(
            await native.command(request, 'external', id),
            { ...body, request: { id, revision: body.request?.revision } },
          ));
        }
        default: return null;
      }
    } catch (error) {
      if (error instanceof SigningError) {
        return Response.json({ error: error.code }, { status: error.status });
      }
      if (error instanceof SyntaxError || error instanceof URIError) {
        return Response.json({ error: 'invalid_input' }, { status: 400 });
      }
      throw error;
    }
  };
}

export function withSigningRoutes(
  options: SigningOptions,
  native: NativeBoundary,
  existingRoute: (request: Request) => Promise<Response>,
) {
  const signingRoute = mountSigning(options, native);
  return {
    async fetch(request: Request): Promise<Response> {
      return await signingRoute(request) ?? await existingRoute(request);
    },
  };
}
```

The JSON type assertions above only bridge TypeScript; they do not establish
trust. The service validates domain inputs and the native boundary authenticates
the request. Keep the edition's normal CSRF/origin, request-size and error
handling middleware around the route. `withSigningRoutes` returns a Fetch Worker
that continues through the existing router when the signing route returns `null`;
build its options/native boundary from the real Worker bindings and server APIs.

Resolve `operationKey` from the edition's authenticated idempotency protocol,
and attach the current agent/sponsor only from the landed agent door. For human
participants use `agent: null`, stable `actorId`/`subjectId`, current `bindingId`,
actual `authentication` and trusted peer metadata or explicit `null` values.
The same options/service must back human routes and authorized agent tools.

Choose `invitations: 'native-session'` for employee/HR or other native-session
profiles, or `'capability'` for the edition's constrained invitation profile.
Return capability tokens only from the authorized issue command; deliver them
through the existing native mail/identity edge and never log them. Neither a
capability nor agent policy approval grants a personal signature.

Public participant pages must read only the native-authorized document
projection for that participant. `review` returns only its permitted document
references, but each native byte-serving route must enforce the same visibility
and current capability/session. Do not expose `evidence` as a public-link
shortcut: it intentionally requires full-scope native authority. GET preview,
byte download, evidence export and verification do not issue a review or act.

## Fresh installation

1. Select a landed full Base commit and copy/record source using the commands
   below. The runtime source pin is independent of the installed CLI package pin.
2. Copy `schema/agreement-signing.sql` to the next unused numbered native
   migration in the edition's actual migration directory. Record that schema's
   origin commit/path in the edition's adoption notes. Apply it through the
   native migration runner; no sample business records are needed.
3. Implement native guards, immutable artifacts and native outcome SQL. Mount
   the existing human routes against this service, preserving the edition's
   supported media, exact selection serializer and real consent UX.
4. Register the shared conformance flows against the actual Worker and actual
   numbered migrations, then run the touched build/typecheck and native journey.
   Prove both successful and refused current-session/source cases. Walk existing
   review and retained-evidence screens at desktop/mobile sizes.

## Populated installation and history

1. Inventory native requests, source revisions, participants, completed acts,
   original/signed/certificate bytes, amounts/selections, receipt IDs and original
   audit roots. Retain a pre-upgrade backup and native exports. Map stable native
   IDs explicitly; do not use emails or round/recalculate historical amounts.
2. Add a new unused numbered migration for module tables and the explicit source
   ID map/backfill. Use a native maintenance/write fence and either a bounded
   transaction or resumable migration with an explicit completion marker. No
   duplicate live writer may run during or after cutover.
3. Preserve existing completed evidence as history. `LegacyRecord.recordKind`
   is `'legacy'`; retain `originalId`, `originalAuditRoot`, `historical`, exact
   artifacts and actual `kind`. Unavailable authentication/consent remains
   `null`, with other unknowns explicit in the native historical payload.
   Do not invent trusted IPs, consent wording, old digests, certificates or a
   new chain claiming to predate adoption. A Plinth attestation stays an
   attestation. New mutable requests use complete native definitions instead.
4. Reconcile counts, IDs, source maps, exact byte hashes/sizes, historical money
   and selection ties, original roots and public downloads. An unmappable row
   blocks cutover with its ID. Legacy read/export must remain available through
   native current authorization; legacy history is not signable authority.
5. Migrate pending invitations under the same fence. For existing plaintext
   links, retain their current URLs and documented expiry/revocation semantics
   while transitioning lookup to digest custody; seal only secrets needed for
   an existing authorized recovery flow, then remove plaintext. Do not silently
   reissue or export live credentials. Re-review pending source/selection changes
   rather than relabeling old approvals.
6. Switch all native route and tool callers to the one service and remove the
   old writer. Prove the populated upgrade through native routes, wrong/current
   participant and stale selection cases, concurrent replay, exports and inert
   restore. Preserve native retention, hold/erasure and service-validity gates.

Never overwrite, renumber, delete or provenance-refresh applied SQL. Each schema
evolution is another numbered migration. Forward correction is the default for
applied migrations; old code is usable only when it remains compatible with the
new data. Keep schema provenance in documentation rather than registering an
applied numbered SQL file as a copy that `refresh-base` could overwrite.

Business evidence export is distinct from an installation `.rer` archive.
Include domain history and referenced immutable objects in native portability;
exclude the AES-GCM credential key, usable invitations, pending reviews,
sessions and provider authority. `restore` is a history operation: it must not
run `nativeCommit`, resend, invoke callbacks, sign or reactivate a pending source.
Recheck current native visibility on direct read/export and command replay.

## Register reusable conformance

The exported registrar uses the edition's test runner and adapter. This wrapper
is executable test code without a production setup endpoint; pass its `open`
argument from the edition's existing disposable Worker/D1 harness:

```ts
// tests/signing-conformance.ts (test-only)
import { test } from 'node:test';
import { registerAgreementSigningConformance } from '../src/base/modules/agreement-signing/conformance/index.mjs';
import type { AgreementSigningConformanceAdapter } from '../src/base/modules/agreement-signing/conformance/index.mjs';

export function registerNativeSigningConformance(
  open: AgreementSigningConformanceAdapter['open'],
  profiles: AgreementSigningConformanceAdapter['profiles'],
) {
  registerAgreementSigningConformance({ test, adapter: { profiles, open } });
}
```

`adapter.open({ profile, expiresInMs?, legacy? })` starts the actual disposable
native Worker with real D1. For the populated case, create native historical
records before applying the actual numbered forward migrations, and retain
`fixture.legacyBefore` from that pre-upgrade state. Declare only supported
profiles: `text-terms` and/or `pdf-html-signature`; Base exercising both does not
authorize adding a new document profile to an edition.

The returned runtime translates `command`, `evidence`, `download`, `nativeState`
and `reviseSource` into actual public routes/commands and current native
projections. Its `rotateSession` and `revoke` exercise real native session
changes. The fixture actor aliases are harness selectors: resolve them into
native authenticated sessions; never send actor claims as route authorization.
`failArtifactPut` injects a test-only custody-edge fault, and `close` tears down
the disposable runtime. Neither is a public setup API or an application fallback.

Four registrations cover exact version/selection and participant authority;
ordered/parallel/concurrent one-use acts; replacement/expiry/withdrawal; and
artifact custody, populated upgrade, export and inert restore. Keep the actual
native route journeys for the product's supported closures and special rules.
See the [conformance contract](conformance/index.d.mts) for the full runtime
fixture shape. Do not substitute a fake in-memory signing store, count a Base
fixture as adoption, or import Node conformance helpers into production.

## Agent tools and resource mapping

These are binding requirements for the edition's landed agent door, not a
dependency of the runtime module. Use native stable person IDs and a live human
sponsor, with the door's current membership and allow-list checks. A customer,
employee, guardian or signer does not become an operator by being referenced.
Agent policy never adds native permission, and no agent may perform personal
signature, consent, identity proof or a guardian act for its sponsor.

| Native action/resource | Service/boundary | Classes and scope |
| --- | --- | --- |
| Prepare/fill an approved draft | `prepare` through the native draft route | `standard`; also `sensitive` for private documents or fields. Native source approval still required. |
| Invite/send | `issue`, then existing native delivery | `external` for delivery; also `commitment` when sending creates a commitment. A local issue without delivery is classified for its actual local effects. |
| Finalize a company commitment | Authorized native outcome backed by the same service | `commitment`, plus every other actual effect class. Never impersonate a personal signer. |
| Reach a mandatory personal signature, consent or identity step | Stop at the native human gate | `gated`. `review`/`sign` for a personal act refuse agents; a tool cannot fulfill this gate. |
| Decline/cancel/withdraw/expire | Supported native closure → `close` | Classify actual consequences, including `commitment` when obligations change; no invented supported transition. |
| Retain external execution | `recordExternal` | Preserve provenance and mismatch state. Classify local effects (`standard`, `sensitive` or `commitment` as applicable); provider send/read-back separately declares `external`. |
| Restore signing history | Native authorized history route → `restore` | Classify actual native effects and sensitivity. Restored history grants no live participant/provider authority. |
| Read document, request, receipt or evidence export | Native resource projection; `evidence` only for full scope | Current visibility/scope, independent of mutation policy; no fictional `read` class. Mark counterparty-supplied text untrusted. |
| Verify retained bundle | `verify` | Verification only; no session, native grant or assurance upgrade. |

The published class IDs are `standard`, `external`, `money`, `commitment`,
`accounts`, `gated`, `access`, `security`, `destructive`, `sensitive`, `live`.
Declare every applicable class from server facts. Signing does not automatically
imply `money`: charging/debit authorization is separate. If a native combined
tool also changes payment, accounts, access, security, destroys data or performs
live operations, declare those effects too. Use the landed door's currency and
amount units rather than inferring them from native storage. Do not copy company
dispositions, policy evaluation or a client-provided risk flag into this module.

## Copy, record and refresh source

Run from the edition root with its installed package, using a full landed commit
in `BASE_REF`. These commands copy committed bytes rather than a dirty checkout:

```sh
BASE_CHECKOUT=/absolute/base-checkout
BASE_REF=FULL_40_HEX_LANDED_BASE_COMMIT
mkdir -p src/base
git -C "$BASE_CHECKOUT" archive "$BASE_REF" modules/agreement-signing | tar -x -C src/base
node node_modules/@runeditrun/rer/edition-authoring/cli.mjs record-base \
  src/base/modules/agreement-signing modules/agreement-signing "$BASE_REF" \
  --base "$BASE_CHECKOUT"
node node_modules/@runeditrun/rer/edition-authoring/cli.mjs verify-base \
  --base "$BASE_CHECKOUT"
```

The full copy includes conformance/docs/tests; only import `index.ts` and its
runtime dependencies in production. Conformance is test-only. If copying a
smaller runtime selection, preserve relative imports and record every required
sibling; do not import Node test helpers from a Worker. Choose the next native
migration number separately, for example:

```sh
git -C "$BASE_CHECKOUT" show \
  "$BASE_REF:modules/agreement-signing/schema/agreement-signing.sql" \
  > migrations/NEXT_UNUSED_NUMBER_agreement_signing.sql
```

Replace that illustrative directory/filename with the real unused native path
before applying. Do not record the numbered migration for automatic refresh.
Commit module source, `base-copies.json`, native adapters, additive migrations
and adoption/schema provenance together. Regenerate the edition's source lock
through its declared lock command after intentional source changes.

For an upgrade, inspect the upstream diff and existing record, then run:

```sh
node node_modules/@runeditrun/rer/edition-authoring/cli.mjs verify-base \
  --base "$BASE_CHECKOUT"
rer refresh-base --ref FULL_40_HEX_NEXT_LANDED_BASE_COMMIT --base "$BASE_CHECKOUT"
node node_modules/@runeditrun/rer/edition-authoring/cli.mjs verify-base \
  --base "$BASE_CHECKOUT"
```

Refresh may move every recorded module, so inspect the whole planned scope.
Declare intentional copied-file adaptations using the installed package's
`adapt-base <file>` before refreshing; inspect conflicts and retained native
adaptations. Keep adapters outside the copy whenever possible. Add new numbered
migrations for schema changes rather than applying fresh schema over history.
Run the edition's declared lock/check commands and touched product journeys.

The runtime source commit and installed `@runeditrun/rer` package version are
different pins. A landed source commit can be copied before a CLI release;
source-only conformance needs no invented CLI release. When an adoption needs
new CLI behavior, pin an actual published package that contains it. Use the
installed package's authoring CLI above, not legacy copied authoring scripts.
See [edition authoring](../../edition-authoring/README.md#copied-base-source) for
recorded digests/modes, acknowledged adaptations and offline verification.
