# Opt-in complete-parent imports

`rer-bounded-waves/1` is a grant-only source protocol. Ordinary `/plan`, including
the logical-package path, keeps its existing aggregate refusal and quotas.
Transport segments never grant execution authority. This source change does not
adopt the protocol in an edition, raise a grant, approve an aggregate, or authorize
a real import. An ordinary whole snapshot above its record grant continues to refuse.

Apply `importDoorBoundedWavesMigration` in a new numbered edition migration after
the existing door migrations. The maintained reference includes the additive
`0042_import_bounded_waves.sql`; it supplies no bounded source or Business tasks.
Existing jobs, originals, approvals and migration names stay intact. The schema
adds root, ordered child, hashed membership and approval tables. Source content
uses the existing door snapshot chunks, and original/attachment bytes use the
ordinary D1 job custody. Erasure withdraws snapshots and equivalent authorized
package segments, marks their roots withdrawn, and retires affected root journals
with the existing stream/reuse/history closure. Peer native rows are retained
unless the product's erasure statements select them. Withdrawal is not Undo.

The edition supplies `ImportDoorBoundedSource` from `types.ts` as `source.bounded`
alongside its existing `source.package`. This is an actual typed input boundary;
no HappyToHelp reader, parser, native grouping or Business approval implementation
is supplied here. Those upstream integrations must exist and be independently
qualified before adoption. The ordinary whole-array package `read` is not used
by preparation.

`describe(upload)` independently enumerates the complete source and returns one
finite `WaveCensus`, including source/native counts by kind/table, originals,
objects, logical/stored/native/blob/context bytes, accounting version, source
mode/high water and complete inventory/relationship/baseline digests.
`page(upload, ordinal, limits)` returns exactly one indivisible `WaveUnit` with
all its primary identities, file roles and dependencies on earlier units. The
adapter must include metadata/context/archive/rejected aliases in its reader's
erasure recognition, and coalesce cycles and publication closures before paging.
Files, source identities, additional subject aliases and native projection keys each have exactly one owner.
`aliases` explicitly indexes context, archive, rejected and metadata subjects that
are not primary source units; their files must be in the verified package. The
census reports their separate count and its inventory digest includes every
alias. The server-owned erasure adapter can supply exact
`D1ImportPerson.aliases: [{installationId, namespace, kind, sourceId}]`, including
a subject that never became a native target. It persists scoped digest tombstones
even before preparation. These selectors are never client input. Wave erasure uses the journaled
four-argument `retireD1ImportCustody` API and the actual restore checkpoint; the
separate legacy `operationKey` erasure-step interface refuses wave custody with
`IMPORT_WAVE_JOURNAL_REQUIRED`. The journal API retains its existing 1000-statement
and 2 MiB RPC bounds.
An unsupported indivisible unit refuses; no remainder is silently deferred.

`native(plan)` enumerates every actual expanded native row, including joins,
origin/hold rows and native blob chunks, with its stable key, projection digest
and stored/blob byte sizes. Its totals cannot be smaller than the kit effects.
It must describe the installed native adapter, including unchanged reused rows;
an effect/container is not a substitute record unit. The native adapter's
`read`, exact `matches` and full-set predicates must cover those physical rows,
references and byte representations. Kit protocol/journal metadata is separate.
`batchSize` optionally lowers the ordinary engine batch (1..20), without changing
the independent source and expanded-native execution quotas.

`waveInventoryHash({source,native,files})`, exported from the door, defines the
complete census digest. Source rows supply kind, stable ID and payload hash;
native rows supply the full `WaveNativeRow`, and `aliases` supplies additional
`WaveAlias` records; verified files also supply their
role and logical bytes. `inventoryMember(type, identity, content)` exposes each
hashed leaf. Sort its hexadecimal digest leaves in ascending ASCII order and
hash their canonical JSON array. The server computes this from its immutable
membership index with bounded keyset pages, without building a full inventory
JSON value. An adapter can do the same in its paged reader or use the convenience
function for a small complete census.

`relationshipsHash` hashes the ordered array of each unit's relationship digest.
`baselineHash` is the previous complete parent fingerprint, or SHA-256 of
canonical `[]` for the initial snapshot. Each child separately commits its exact
native before-images. The sealed parent commits all child fingerprints, census,
package, destination/claim, migration/revision/policy, mapping and erasure epoch.

`authority(binding, action)` MUST return a same-database scalar predicate for the
CURRENT installation, owner/claim, migration/revision/policy and active exact
parent/child approvals. It must consult the edition/Business approval rows;
returning a cached boolean or constant permission defeats the integration.
The door combines it with current enablement, trust/key revocation, single-use
nonce, expiry, namespace/destination binding and erasure epoch before and after
each existing D1 transaction. A root approval has no apply authority.

For example, the trusted signer issues fresh grants using these additional
payload members (the existing issuer/audience/owner/nonce/expiry/quotas remain):

```ts
const bounded = {
  protocol: 'rer-bounded-waves/1', migration: 'migration-17',
  revision: 'revision-2', policy: 'policy-1',
};
// prepare / seal-parent / wave-status: { bounded }
// review-parent:
const reviewedParent = {
  ...bounded, parentFingerprint, parentApprovalRecordId, parentApprovedAt,
};
// { bounded: reviewedParent, fingerprint: parentFingerprint,
//   approvalRecordId: parentApprovalRecordId, approvedAt: parentApprovedAt }
// apply-child:
// { bounded: {...reviewedParent, childFingerprint}, fingerprint: childFingerprint,
//   approvalRecordId: childApprovalRecordId, approvedAt: childApprovedAt }
```

The concrete POST bodies are:

```json
{"uploadId":"server-upload-id","ordinal":0}
{"parentId":"server-parent-id","ordinal":1}
{"parentId":"server-parent-id"}
{"parentId":"server-parent-id","ordinal":0,"reviewedFingerprint":"<child-sha256>"}
```

The first two are `/prepare`. The third is `/seal-parent`, `/review-parent`,
`/wave-status`, `/finalize-parent` or `/reverse-parent` under its own action
grant. The fourth is `/apply-child`. Before approval, `/prepare` with
`{"parentId":"server-parent-id","cancel":true}` can discard private custody;
the previous complete head stays authoritative. A cancelled revision is not
mutated/reused: review a new revision. All routes remain on `/api/rer/import/`.

Child responses say `childSuccess` and always `aggregateSuccess:false`. Missing,
altered, foreign, unapproved, revoked or out-of-order children refuse. Fresh
grants resolve lost responses through durable inventory/status, operation keys
and the existing D1 checkpoints. A child uses an ordinary D1 job, preserving
attachment/original eligibility, strict before-images, apply and rollback. The
kit's internal source namespace binds the reviewed snapshot revision, not a
child/upload/attempt; the logical namespace and migration lineage never split.

Finalization requires all exact children, current approvals, readable custody,
complete inventory totals and exact native/provenance reconciliation. Only that
transaction advances the complete head and releases gone-but-retained reporting.
Absence never deletes. `wave-status` reports progress/completion history, not a
fresh aggregate proof; the sender consumes `/finalize-parent` itself.
Routine grants marked `catchup:'bounded'` require the global strict under-five-
percent comparison and all existing gone/conflict/rejected/unmapped exclusions.
A separately reviewed proposal can describe a complete snapshot with absence;
its previous targets remain attributed and retained. Catch-up Undo preserves
unchanged original owners. Reverse checks all known conflicts first, then uses
ordinary strict Undo or partial-job rollback, descending dependants first. It is
bounded, resumable reversal, not whole-database atomicity.

Every request retains the existing plan/value/parser/SQL/transport limits. A
complete reconciliation or baseline read that cannot fit the actual request
budget refuses before publication; there is no unchecked paged remainder or
hosted-capacity claim. Independent qualification must establish the capacity of
the adopting edition and its exact native adapter. The tiny-grant public proof
does not establish capacity for a production-sized legacy snapshot.

The reusable sender is `cli/business/bounded-waves.mjs`, with its actual typed
`BoundedArrangement` in `bounded-waves.d.mts`. `rer business run` opts in only
when Business supplies `task.bounded_waves`; ordinary tasks keep their path.
Business supplies the claimed destination and fresh action grants, then the
exact server parent fingerprint and ordered immutable child approvals. The
sender cannot synthesize them or treat task completion as reconciliation.
An arrangement without approval prepares/seals and pauses truthfully. Approval
arrangement, grant minting, edition-native grouping, and real adoption remain
upstream dependencies, not evidence supplied by this Base implementation.
