# Agreement signing

Optional server source for exact-document electronic signatures, terms acceptance
and customer attestations. It owns the request, one-use review, personal act,
immutable receipt and audit lineage. The edition owns its people, sessions,
source records, routes, screens, rendering, storage and policy.

Import [index.ts](index.ts) in a Workers/D1 application; production uses Web APIs
and has no Node or framework dependency. Apply the SQL in
[schema/agreement-signing.sql](schema/agreement-signing.sql) through a new native
numbered migration. See [ADOPTING.md](ADOPTING.md) for complete service/mount
examples, populated cutover, provenance and agent bindings.

## Evidence profiles

| Kind | Meaning |
| --- | --- |
| `electronic-signature` | A human's typed or drawn signature intent on the exact reviewed document and selection. |
| `terms-acceptance` | A human's acceptance statement against the exact terms. |
| `customer-attestation` | A human's attestation about the exact native selection or statement. |
| `external-execution` | Provider/import evidence with its original provenance and mismatch disposition; never a native personal act. |

Media and evidence kind are independent. Text, HTML, PDF, original document
bytes, drawn-signature images and disclosure wording use `ArtifactRef` with
immutable ID/version, media type, SHA-256 and byte size. A TXT acceptance need not
produce a PDF; a PDF hash or receipt does not establish a PKI signature or legal
certification. The module does not upgrade link possession to verified identity.
Record the actual authentication basis and the actual consent requirements.
New native definitions require the matching `signature-intent`, `accept-terms`
or `attestation` wording artifact. Electronic-records disclosure is a separate
requirement when native policy calls for it; this adds no default checkbox or
invented historical disclosure.

## Public entry

```ts
import {
  artifactRef,
  canonical,
  createSigningService,
  sha256,
  SigningError,
} from './base/modules/agreement-signing/index.ts';
import type {
  CommandContext,
  Json,
  ParticipantContext,
  SigningDefinition,
  SigningOptions,
} from './base/modules/agreement-signing/types.ts';

export function makeSigning(options: SigningOptions) {
  return createSigningService(options);
}

export async function prepareApprovedTerms(
  signing: ReturnType<typeof makeSigning>,
  ctx: CommandContext,
  approved: {
    source: SigningDefinition['source'];
    participant: SigningDefinition['recipients'][number];
    termsId: string;
    termsVersion: string;
    termsBytes: Uint8Array;
    approval: Json;
    consent: SigningDefinition['consents'];
    expiresAt: string | null;
  },
  artifacts: SigningOptions['artifacts'],
) {
  const terms = await artifactRef(
    approved.termsId, approved.termsVersion, 'text/plain; charset=utf-8',
    approved.termsBytes,
  );
  await artifacts.put(terms, approved.termsBytes);
  const definition: SigningDefinition = {
    source: approved.source,
    kind: 'terms-acceptance',
    documents: [terms],
    recipients: [approved.participant],
    approvalDigest: await sha256(canonical(approved.approval)),
    selectionDigest: null,
    expiresAt: approved.expiresAt,
    consents: approved.consent,
    completion: 'receipt-only',
    closures: ['cancelled'],
    replaces: null,
  };
  return signing.prepare(ctx, definition);
}

export async function acceptReviewedTerms(
  signing: ReturnType<typeof makeSigning>,
  ctx: ParticipantContext,
  input: Parameters<typeof signing.review>[1],
) {
  // Called after the native UI presents these exact documents, fields,
  // consent wording and statement, and the human explicitly submits them.
  const review = await signing.review(ctx, input);
  return signing.sign(ctx, {
    requestId: review.requestId,
    recipientId: review.recipientId,
    credential: input.credential,
    token: review.token,
    signableDigest: review.signableDigest,
  });
}

export function signingFailure(error: unknown): Response {
  if (error instanceof SigningError) {
    return Response.json({ error: error.code }, { status: error.status });
  }
  throw error;
}
```

The `approved` input above comes from the edition's approved source loader, not
from a client's claim of approval. Its digest serializer must be the same one
used by `sourceGuard`; `approval` is that exact native approved snapshot, including
its byte/selection references where applicable. Native participant IDs, document visibility and consent
artifacts must already be resolved; the example deliberately leaves policy to
the actual edition adapters. `artifactRef` computes a reference; the immutable
store still has to retain the bytes. `sha256` accepts bytes or a string;
`canonical` serializes a `Json` value for stable hashing.

For a separated review/submit UI, keep the review token with that participant's
session and redeem it only after the human submits. Never make GET perform
`review`, `sign`, issue or a closure. `review` is itself an audited command and
creates one-use authority; it is not the read-only preview operation.

## Methods and state

[types.ts](types.ts) is the complete contract, including closed input types and
`SigningErrorCode`. Contexts always come from trusted server code.
Boundary/storage failures surface as `unavailable` (503), preserving their cause
for server diagnostics; they never report a completed outcome or substitute data.

| Method | Contract |
| --- | --- |
| `prepare(ctx, definition)` | Bind approved native source, immutable bytes, exact selection, participants, required consents and completion policy. |
| `issue(ctx, { id, revision })` | Issue that revision. Capability mode returns authorized invitation tokens; native-session mode requires no public invitation. Delivery is edition-owned. |
| `review(ctx, input)` | Check current participant/session, source, order and exact act/fields/consents; create a short-lived one-use signable review. Returned documents are restricted to that participant. |
| `sign(ctx, redemption)` | Redeem that review for its human/session and commit one personal act, receipt, audit lineage and native outcomes together. Every agent is refused. |
| `close(ctx, input)` | Close the exact current revision. Decline/cancel/withdraw must be enabled by the definition; expiry uses the declared expiry. |
| `recordExternal(ctx, input)` | Retain separately attributed provider-original artifacts and reconciliation disposition. No provider I/O or native signer event. |
| `evidence(ctx, id)` | Read the complete evidence bundle under a current native grant for its entire scope. No state change. |
| `verify(bundle, expectedRoot?)` | Verify the supplied bundle's references, receipts and audit lineage; optionally anchor to a separately retained expected root. No authorization or identity proof is conferred. |
| `restore(ctx, bundle)` | Retain verified history inertly, without creating live credentials, sessions, reviews, provider work or native commitments. |

Normal state is `draft → issued → in-progress → completed`; supported terminal
states are `declined`, `cancelled`, `expired` and `withdrawn`. A correction is a
new definition with `replaces` pointing to its predecessor. A participant act
and request completion are distinct. Equal-order participants can act in
parallel; required earlier orders must finish before later orders. Advanced
group, witness, guardian and category rules remain current native guards.

Keep `operationKey` stable when recovering one command. Exact same actor,
operation, key and payload recovers one result; changed replay refuses. Signing
also binds the native participant/session, credential, review digest, exact
source/selection, fields, act and consent requirements. Rotation, revocation,
replacement, closure and expiry must invalidate pending authority through the
native source/session guards as well as the module's request checks.

## Required boundaries

`createSigningService` takes a `SigningOptions` object:

- `database`: the same D1 database used by the native authority, source and
  participant predicates and native outcomes.
- `sourceGuard`: trusted SQL checking current exact source revision, approved
  bytes/digest, selection and state for the operation. A prior JavaScript read
  alone cannot guard a concurrent commit.
- `participantGuard`: trusted SQL checking the present subject, session binding,
  authentication basis, resource/category rights and any witness, delegated or
  guardian authority. Its fourth argument carries the exact proposed binding
  for native field/selection policy (`null` for committed-command recovery).
  Request JSON cannot supply authority. Portable actions retain only a digest
  of the session binding, never its usable credential.
- `nativeCommit`: at most eight SQL statements joining native outcomes/audit to
  the module's D1 transaction. No network I/O, independent transaction or second
  native signing writer.
- `artifacts.read` and `artifacts.put`: immutable byte custody. `put` must refuse different bytes
  for an existing ID/version; `read` must return those exact bytes or absence.
- `credentialKey`: a persistent native AES-GCM `CryptoKey` used for recoverable
  authorized command replay. Keep it in secret custody, outside archives,
  evidence exports, browser code and logs.
- `invitations`: explicitly choose `capability` or `native-session`. Possession
  remains the stated assurance when capabilities are used; a native session
  profile does not need a public token.
- Optional `finalize`: a pure renderer returning final artifact references and
  bytes. It must not write objects, mail, provider state or native records. With
  `completion: 'artifacts-required'`, supply the actual final artifacts; with
  `receipt-only`, no executed PDF or certificate is invented.

Evidence times come from the Worker clock; expiry is also rechecked with the
database clock inside the write transaction. There is no backdating input.

Artifact custody is staged before completion. A failed artifact write must not
leave a completed request with missing final bytes; immutable staged objects
may need native retention cleanup after a refused database commit. Treat object
custody and D1 as different systems, even when the adapter stores native BLOBs.
The first guarded signing attempt retains its actual act/consent time in a
transient intent, so retrying after failed custody renders the same evidence.
Render from frozen source and acts, and address immutable output by those facts;
unrelated kernel revisions must not reuse an ID/version for different bytes.

The exported `limits` bound each request to 16 documents, 32 participants,
4 consent purposes, 64 artifact references, 8 MiB per artifact and 32 MiB of
artifact bytes. Persisted JSON records are at most 64 KiB; there are at most
128 audit revisions and outstanding signing intents, and 8 native SQL statements
per commit. Review authority lasts at most 10 minutes, and invitation authority
at most 30 days, capped by request expiry. Capacity refusals never publish a
partial act. Size the native D1 tier and archive runner for the bounded batch.
New invitation tokens use 256 random bits. Imported current links can retain
their existing encoding (up to 512 characters); exact digest custody and all
native/module authority, scope, expiry and revocation guards still apply.

## Scope and proof

Keep Inkwell routing/witnesses, Platter commercial selections/current-owner
countersign, Willow employee/HR/category/compensation rules, Strap guardian and
adult/debit-consent boundaries, Cabin amendment/access gates, Pantry sent versus
accepted copies, Glove disclosures/drawn media, Mallet repair-line choices,
Plinth delegation/attestation and Locket provider mismatch review native. Chest
PDF fidelity/PKI sealing and governed publication, Lodge mailbox/source voiding
and non-PKI receipts, OTP/mail delivery, provider transport and guardian UI are
not implemented by this kernel. Extraction does not complete their missing
product clauses or change an approved page.

[conformance](conformance/index.d.mts) exports a small reusable public-route
suite. It exercises the adopter's actual Worker, native numbered migrations and
D1, including a populated upgrade and inert restore. Base proof is not proof of
an edition's integrated routes, retention or deployment. Adoption must also walk
its existing prepare → review → act → evidence screens and downloads, including
the media and identity profile it actually supports.

From the Base root, the targeted reference consumer command is:

```sh
node --test --test-concurrency=2 modules/agreement-signing/tests/*.test.ts
./default-seed/node_modules/.bin/tsc --project modules/agreement-signing/tsconfig.json
./default-seed/node_modules/.bin/tsc --project modules/agreement-signing/tests/tsconfig.json
```

`tests/conformance.test.ts` is discovered by the existing module glob in
`scripts/ci/module-shard.mjs`. Runtime TypeScript and conformance declarations
also participate in `default-seed/tsconfig.seed-copies.json`; no separate CI
shard or npm export is required.
