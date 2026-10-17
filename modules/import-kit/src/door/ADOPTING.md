# Adopt one import pipeline

The seed's signed-in move-in screen, `rer` and Business must share **upload →
plan → reviewed fingerprint → apply → reconcile → undo**. Keep source readers,
mappings and native target adapters; delete the old importer routes, separate
job creation/apply code and their callers. Do not leave a hidden second importer.
Owner history and undo must include jobs from either authority.

## Add to the seed

1. **Schema and copies.** Vendor `modules/import-kit/src` and its sibling
   `modules/d1-transport` with relative paths intact; record copies using the
   seed's existing Base provenance workflow. Install the D1 kit schemas from
   `modules/import-kit/src/d1/database.ts` (`d1Schema` and the additional
   schemas used by `initializeD1ImportStorage`) and applicable evolutions, then
   `importDoorSchema` from `modules/import-kit/src/door/schema.ts` in the next
   numbered seed migration. Never rename applied migrations.
2. **Native adapter.** Supply the seed's real `D1TargetAdapter`, parser,
   `ImportMapping`, destination and actual owner principal. Read/write/remove
   guards must protect native revisions and values in the same D1 transaction.
   Mapping only creates inert native records: importing cannot send mail, page
   someone, activate monitors or grant access. Keep any activation as a separate
   owner-approved product action. Declare unsupported records as rejections or
   explained omissions; never fabricate success.
3. **Operator mount.** Import `createImportOperatorHandler` from
   `modules/import-kit/src/door/operator.ts`. Supply the runtime options in
   `types.ts`, plus server-owned `installationId`, `appOrigin`, `ownerEmail`,
   `namespace`, and `authorize(request, action)`. That callback authenticates the
   current owner with the seed's normal session/CSRF checks and returns a
   `D1Sql` predicate checking that exact session and owner in the same database;
   return `null` for other callers. The predicate is rechecked inside mutations.
   Mount the handler before ordinary route rejection, including the host router
   and body-size boundary; pass its `null` response to the next dispatcher.
4. **Settings and grants.** Create the installation settings row with
   `writeImportDoorSettings(db, installationId, {enabled:false}, ownerPredicate)`.
   This flag controls Business grants, not the owner's own imports. If the seed
   has owner-claim, additionally mount `createImportDoorHandler` from `index.ts`
   with the **same** server-owned claim/key-ring configuration. Dispatch this
   grant handler **before** the operator handler. Enable only through an owner
   settings action or the owner's provisioning approval. Keep durable key
   revocations and show them in that settings row; re-enabling never unrevokes.
5. **Move-in screen.** Call POST `/api/operator/import/{uploads,plan,apply,status,
   reconcile,undo}` with the current owner cookie, exact `Origin` and normal
   seed CSRF headers. Bodies and results are in [README.md](README.md). Upload
   original bytes, show the returned counts, rejections and differences, then
   require the owner's review before posting `{planId, reviewedFingerprint}`.
   Repeat bounded apply calls with that fingerprint until `job.state` is
   `completed`; reconcile from native data and expose Undo. Never mint an import
   grant for this screen. Use `readImportDoorHistory` with the current owner
   predicate for approval metadata; local approvals are labelled `approved by`,
   Business approvals `approved via Business by`.
6. **Erasure.** Include retained uploads/chunks, plan snapshots/chunks, approvals,
   namespace lineage and grant metadata in the seed's erasure/custody inventory,
   alongside ordinary kit originals/provenance. Withdraw an indivisible bundle
   when erasing any contained subject; preserve unrelated native records. Keep
   installation settings and permanent revoked keys. Exercise the **existing
   public erasure route with door tables installed**, even with grants disabled.
   Do not omit tables from retirement tallies to hide retained personal data.
7. **Tests.** Extend existing HTTP journeys within the seed's 200-test cap. Use
   its actual migrated Worker, real sign-in, synthetic exports and public native
   reads. Cover anonymous/non-owner and cross-origin refusal, no-write planning,
   fingerprint refusal, apply/reconcile/undo, native edit protection, session
   revocation during mutation, disabled/revoked grants, owner undo while Business
   is off, and erasure of retained door custody. No test skips or SQL bypasses.

**Without owner-claim:** vendor the operator runtime, omitting the three optional
grant-only files `door/index.ts`, `door/admission.ts` and `door/grants.ts` from
the source-copy inventory. Import `operator.ts` directly. This also lets a seed
typecheck its entire copied source tree without unresolved owner-claim imports.
Do not vendor owner-claim or operator-auth merely for imports: the operator
runtime has no dependency on either;
use the seed's existing owner authentication. All `/api/rer/import/*` requests
return 404 through that mount. No signer, dummy claim configuration or grant is
needed. To add Business later, add those three grant files and owner-claim's
verifier dependencies, then
configure its trusted ring, mount the grant handler first and explicitly opt in.
The existing grant signature, nonce, scope, expiry and approval rules do not change.

## Real integration example: Spool

[Spool PR 9](https://github.com/just-every/run-spool/pull/9) demonstrates the
native integration: `migrations/core/0041_business_import_door.sql`,
`src/domain/sentry-import/door.server.ts`, `source.ts`, `mapping.ts`, `targets.ts`
and `context.ts`; settings/history in `business-routes.ts` and
`src/ui/workbench/BusinessImports.tsx`; custody in
`src/domain/erasure/business-custody.ts`; public HTTP proof in
`tests/business-import.mjs` using `tests/worker.mjs`, `tests/auth.mjs` and
`tests/archive.mjs`. These paths are in Spool. Its Sentry parser and adapter are
reused, imports remain historical, and project erasure withdraws duplicate door
custody. That PR still keeps `/api/imports/sentry`: finishing single-path adoption
requires replacing that caller with the operator mount and deleting that route.
Do not copy its older vendored door instead of current Base.

## Copyable public HTTP conformance

Copy the following into an existing seed test journey and call `checkDoor`.
It needs only Node built-ins. `request(action, body, review)` must return the
actual HTTP `Response`: use owner-cookie requests to the operator mount, or
mint a **fresh action-bound grant per call** for the grant mount (the apply
`review` argument supplies its signed fingerprint/approval). `nativeSnapshot`
reads a stable projection of native records through the seed's public API/export,
excluding import bookkeeping. Supply nonempty synthetic source bytes plus
`assertApplied(before, after, report)` and `assertUndone(before, after)` to check
real field values and the seed's undo policy. Those hooks must use public reads,
not SQL, mocks or precomputed results. The existing seed journey separately
covers settings, revocation, native edits and erasure as above.

```js
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';

export async function checkDoor({request, bytes, name, nativeSnapshot,
  assertApplied, assertUndone}) {
  const hash = b => createHash('sha256').update(b).digest('hex');
  const json = async (action, body, review, expected = 200) => {
    const response = await request(action, body, review);
    assert.equal(response.status, expected, `${action}: ${response.status}`);
    return response.json();
  };
  const until = async (action, body, review, state) => {
    for (let batch = 0; batch < 100; batch++) {
      const result = await json(action, body, review);
      if (result.job?.state === state) return result.job;
      assert.ok(['queued','applying','undoing'].includes(result.job?.state));
    }
    assert.fail(`${action} did not finish`);
  };
  assert.ok(bytes.length > 0);
  const before = await nativeSnapshot(), bundleSha256 = hash(bytes);
  const totalChunks = Math.ceil(bytes.length / 65536);
  let uploadId;
  for (let index = 0; index < totalChunks; index++) {
    const chunk = bytes.subarray(index * 65536, (index + 1) * 65536);
    const uploaded = await json('uploads', {uploadId, name, bundleSha256,
      totalBytes:bytes.length, totalChunks, index,
      chunkSha256:hash(chunk), base64:chunk.toString('base64')});
    uploadId = uploaded.uploadId;
  }
  const inventory = await json('uploads', {uploadId});
  assert.equal(inventory.complete, true);
  assert.equal(inventory.bundleSha256, bundleSha256);
  assert.equal(inventory.received.reduce((n,c) => n + c.size, 0), bytes.length);
  const plan = await json('plan', {uploadId});
  assert.equal(plan.bundleSha256, bundleSha256);
  assert.ok(plan.summary.sourceRecords > 0);
  assert.deepEqual(await nativeSnapshot(), before);
  const review = {fingerprint:plan.fingerprint,
    approvalRecordId:randomUUID(), approvedAt:new Date().toISOString()};
  const wrong = (plan.fingerprint[0] === '0' ? '1' : '0') + plan.fingerprint.slice(1);
  await json('apply', {planId:plan.planId, reviewedFingerprint:wrong}, review, 403);
  assert.deepEqual(await nativeSnapshot(), before);
  const job = await until('apply', {planId:plan.planId,
    reviewedFingerprint:plan.fingerprint}, review, 'completed');
  const status = await json('status', {planId:plan.planId});
  assert.equal(status.job.id, job.id);
  assert.equal(status.job.state, 'completed');
  const report = await json('reconcile', {planId:plan.planId});
  assert.equal(report.ok, true);
  assert.equal(report.fingerprint, plan.fingerprint);
  assert.equal(report.bundleSha256, bundleSha256);
  assert.equal(report.counts.sourceRecords, plan.summary.sourceRecords);
  assert.equal(report.counts.present + report.counts.explained, report.counts.sourceRecords);
  assert.equal(report.sourceIds.length, report.counts.sourceRecords);
  await assertApplied(before, await nativeSnapshot(), report);
  await until('undo', {planId:plan.planId}, undefined, 'undone');
  await assertUndone(before, await nativeSnapshot());
}
```

For a concrete grant client and harness see Spool's `tests/business-import.mjs`;
its `grant`, `doorRequest`, `nativeSnapshot`, `startTestWorker` and `signIn`
provide those network edges. Run with `nice -n 15 node <existing-test-journey>`
after the seed's normal build. No `rer check` extension is required.
