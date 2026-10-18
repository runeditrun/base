# Optional D1 import door

Import `createImportDoorHandler`, `importDoorSchema`,
`writeImportDoorSettings` and `readImportDoorHistory` from `./index.ts`.
The handler returns `(request: Request) => Promise<Response | null>`; pass
unhandled requests to the seed's existing router. Only POST routes under
`/api/rer/import/` are supported. Nothing mounts a route automatically.

Construct the handler with these seed-owned options:

| Option | Meaning |
| --- | --- |
| `database`, `targets` | D1 database and its real `D1TargetAdapter`. |
| `claim` | The same server-owned `OwnerClaimConfig` and trusted key ring used by owner-claim. |
| `ownerPrincipalId` | Actual owner principal used by the seed's ordinary import history and undo context. |
| `destination`, `mapping` | Product destination and reviewed `ImportMapping`. |
| `format`, `parse` | `'json'` or `'ndjson'`, and the product's parser of source records. |
| `limits` | Optional reader limits; grant quotas still apply. |

Apply the statements in `importDoorSchema: string[]` in a new product-owned
numbered migration after the D1 import-kit schemas. Preserve existing applied
migration names. Copy the import-kit runtime and its sibling owner-claim and
D1 transport dependencies with their relative topology intact.

Upgrading an installed door also requires a new numbered migration containing
the additive `CREATE TABLE IF NOT EXISTS ik_door_scopes` statement from
`importDoorSchema` (or all of its idempotent statements). It binds each logical
namespace to the product destination on the first uploaded chunk, before a
plan/job exists. Old applied namespaces remain scoped through their kit job id
or the recoverable `door:<plan id>` operation key. Rows the previous door wrote
in a namespace with neither link (an unplanned upload, a plan never applied,
or rows a rolled-back previous Worker keeps writing) were never applied by any
destination, so every destination's erasure withdraws them. No seed migration
has to bind them.

Import-kit custody retirement withdraws the record content in scope whole, in
the same D1 batch as native erasure, the restore checkpoint and the journal:
uploaded chunks, upload headers and saved snapshot bodies, including unapplied
uploads. The journal counts the withdrawn rows. Withdrawing door content fences
the erasure, so a values-only erasure that touches it requires the restore
checkpoint (`IMPORT_RETIREMENT_CHECKPOINT_REQUIRED` without one). Plans,
approvals, namespace heads and namespace bindings hold no record content and
stay, so the seed's history still lists a surviving import "via Business",
and `status` and `undo` keep working through its kit job. Where a withdrawn
snapshot is needed (`reconcile`, catch-up `plan`, an `apply` that has not
completed) the door answers 410 `snapshot_withdrawn` with `details.planId`.
Door work already in flight is fenced against the erasure: every snapshot
batch and the batch completing a plan require the source upload, a catch-up's
previous snapshot and the chunks before it, and every kit batch an `apply`
writes requires the plan's snapshot. A `plan` or `apply` racing an erasure
answers the same 410 and never writes withdrawn content back; replaying `apply`
on a completed import still answers its job. Every door batch, and every kit
batch a door request runs, also asserts that the destination's erasure journal
count is unchanged since the request was admitted, so any other request an
erasure overtakes (an upload chunk, say) answers 410 `erased_during_request`
and leaves nothing behind. `plan` refuses a bundle holding an erased record
with 409 `source_erased` and deletes that upload, whatever else would refuse
that plan first: a withdrawn snapshot, a pending import, interrupted staging,
the catch-up shape or a bound. Any other bundle keeps that refusal and stays.
A catch-up keeps each unchanged record as a zero-effect entry in its own kit
job. Erasing a target a door import wrote severs the same source record in every
kit job of that door namespace, and withdraws the originals that hold it. A
resumable erasure's final step reads those jobs even when an earlier step read
them, and an erasure fails closed if a catch-up joins that namespace while it
reads; a retry then erases it too.
Later imports start a new namespace, or a new baseline after `undo`.
Enablement, key revocations and grant replay protection survive.

The door starts disabled and returns 404 until explicitly enabled. From the
seed's server-only owner control, call
`writeImportDoorSettings(database, installationId, { enabled, revokedKids? },
ownerPredicate)`. The `D1Sql` predicate must check the existing owner session,
or provisioning authority under the owner's approved plan, in the same database.
No public door route enables itself. Revoked key ids persist across settings
writes; removal is unsupported. Rotate to a new `kid` to grant access again.

Call `readImportDoorHistory(database, installationId, ownerPredicate)` to show
approval metadata joined to real kit jobs. The caption is
"approved via Business by <owner> at <time>, fingerprint <x>". Keep the ordinary
seed history and undo flow, using the configured owner principal and its current
owner-session predicate. Existing operator job binding remains unchanged.

## Grants

Each request carries `Authorization: Bearer <compact JWS>`. The exact protected
header is `{ "alg": "ES256", "typ": "rer-import-grant+jwt", "kid": "..." }`.
Use the existing owner-claim trusted key ring; the door does not supply a signer.
The required flat payload fields are:

| Fields | Constraint |
| --- | --- |
| `v`, `iss`, `aud` | Version `1` and the configured owner-claim issuer/audience. |
| `installationId`, `email` | Exact installation and owner identity. |
| `jti` | UUID nonce, durably single-use. |
| `iat`, `exp` | Issued/expiry Unix seconds; lifetime at most 300 seconds, future issue allowance at most 30 seconds. |
| `action` | Exactly the requested route suffix. |
| `namespace` | Logical import-tool namespace. |
| `maxBytes`, `maxChunks`, `maxRecords` | Positive quotas capped at 300,000,000 bytes, 1,024 chunks and 1,000,000 records. |

Unknown keys are rejected. Apply additionally requires `fingerprint` (64 hex
characters), `approvalRecordId` and `approvedAt` (canonical ISO timestamp).
Plan grants carry no fingerprint. Optional `catchup: 'bounded'` is accepted only
for plan/apply; bounded plan and apply grants carry the same standing owner
`approvalRecordId` and `approvedAt`. The apply body `reviewedFingerprint` must
match both the signed fingerprint and the exact retained plan.

Expired, replayed, forged, wrong-installation and wrong-fingerprint grants fail
closed. Every request needs a fresh nonce, including each chunk, upload inventory
read, status call and retry. Current enablement, key revocation and expiry are
checked inside kit mutation batches, so a previously accepted request does not
grant continuing authority after revocation or expiry.

## Requests

All bodies are JSON. Quotas are admission limits, not a hosted capacity promise.

| POST route suffix | Body and result |
| --- | --- |
| `uploads` | `{ uploadId?, name, bundleSha256, totalBytes, totalChunks, index, chunkSha256, base64 }`; decoded chunks are exactly 64 KiB except the final chunk. `totalChunks` must equal `ceil(totalBytes / 65536)`. Omit `uploadId` on the first chunk to receive a server-generated UUID. Reuse it and the same bundle metadata for subsequent chunks. Both chunk and complete bundle SHA-256 are checked before reporting completion. |
| `uploads` | `{ uploadId }` returns received-chunk inventory for resuming. An identical duplicate chunk is idempotent with a fresh grant. |
| `plan` | `{ uploadId, catchup?: boolean }` returns `planId`, `fingerprint`, server-derived counts, summary, rejected rows with reasons and differences including gone source ids. Planning makes no native target writes. |
| `apply` | `{ planId, reviewedFingerprint }` creates or resumes the real kit job in bounded batches. Repeat with a fresh valid grant to continue. |
| `status` | `{ planId }` reads current job progress. |
| `reconcile` | `{ planId }` derives source-id disposition/presence and native/provenance revision, value, attachment and count checks on the server. |
| `undo` | `{ planId }` reverses the newest snapshot's attributed effects in bounded kit work, preserving native edits. |

Bodies are limited to 100,000 bytes. The 1,024-chunk bound limits one bundle to
64 MiB even if a grant's byte quota is larger. A smaller grant quota wins.

Uploaded bytes and retained originals remain in the seed; RER retains receipts
only. Parsing and mapping are product-owned and cannot send, enqueue or activate
access. An adopting seed supplies its native field sampling and integrated
acceptance evidence; this module has no external side effects.

## Catch-up and recovery

A logical namespace tracks a lineage of snapshots; each snapshot's kit namespace
derives from the logical namespace and exact bundle SHA-256. Original source ids
remain intact. Unchanged records produce no effects but remain accounted for.
Replacements use the revision in original import provenance as
`expectedRevision`, and compare native values too, protecting edits even when
their revision was unchanged. Gone source records are reported without deletion.

Only one plan may remain pending per logical namespace until applied or undone.
Committed kit state recovers lineage after an interrupted call. Repeating a
bundle reuses its exact retained plan; use a fresh explicit namespace and review
for a different mapping. Undo snapshots newest first, including undo from the
seed's ordinary owner history.

An interrupted private plan preparation reports
`plan_staging_interrupted_cancel_and_replan` with `details.planId`. Call `undo` with that `planId`
to cancel its private preparation, then plan the retained upload again. A
preparation with no kit job cancels without native effects. Once a job exists,
the same route uses the kit's guarded rollback/undo instead.

Bounded catch-up requires an existing nonempty baseline and standing owner
approval. It refuses gone, conflicting, rejected or unmapped records. Additions
plus replacements divided by baseline source count must be strictly below 5%;
the server derives these counts. A refusal leaves Business to present a new
proposal for owner review. No caller-supplied totals relax this boundary.
