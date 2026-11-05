# gr-base-bounded-waves-fix-1 · lifetime FIX1 of 2

Date: 2026-11-05 UTC. Repository: runeditrun/base. Role: sole correction writer.

Product branch: cloud/gr-base-bounded-waves-fix-1
Final product head: c0539b0001d71a6246c755e100c47141f525bf5e
Original immutable source: 8ff4d564234407ef91009390411cd0e1a1e0e6b4
Accepted main: 264805b3d5f74fdb6934c2c2fb2c7c1a8f08d74e
Draft PR: https://github.com/runeditrun/base/pull/825
Exact-head ordinary Verify: 42125479357, https://github.com/runeditrun/base/actions/runs/42125479357

## Scope and custody

Fresh shallow/blobless clone started at the exact original branch head. Deepening enough to reconcile history proved both original source and fetched current main are ancestors. Main did not advance during reconciliation; no merge was needed, no published commit was rewritten. Two new commits: c2c61c4120f9ee623e88e526e02e975de5f29287 (source/copies, skip ci) and c0539b0001d71a6246c755e100c47141f525bf5e (source provenance). Both normal product pushes succeeded on attempt 1 using the fleet guard. The final checkout was clean. Identity audits cover all 9/10 candidate commits respectively, including merge side parents; every author and committer is Run Edit Run fleet <fleet@runeditrun.com>, with no trailers. One draft PR supplied the ordinary candidate event. No dispatch, rerun, tag, empty commit, force push, main push, release, owner action or production import occurred.

## Full plan

The complete pre-publication plan is in PLAN.md. In order: establish exact original and main ancestry, reproduce only the two blockers, make the minimal disposition and README corrections, run the original focused behavior and mechanical checks, preserve SQL/ledger bytes, export CLI copies, publish source then provenance, open one draft PR, watch only exact-SHA ordinary CI within the bounded REST budget, and publish explicitly selected actual receipts on the separate evidence ref. Review and lander holds remain throughout.

## Blocking A / R3

`modules/import-kit/src/door/waves/lifecycle.ts` now uses the incumbent `recordKey` with each immutable snapshot's `differences.unchanged` set when counting targetless records for the catch-up exclusion. A verified unchanged source keeps its previous disposition, including an empty target set. Rejection counts are still enforced; new or changed targetless sources are still counted. No percentage, complete-baseline, absence, native-accounting, approval, ownership, current-native, erasure or transaction fence changed. Finalization's success logic is unchanged, so retaining an earlier rejected record does not imply native success.

The shipped reference supplied FIX1-BLOCKERS.md inline but did not supply its cited executable catchup-exclusion.py. The adaptation is explicit: catchup-exclusion-adapted.py, retained outside the product and identical before and after. It creates a temporary test in the repository root and removes it afterward. It reuses the actual mounted ES256 HTTP door, SQLite/D1 runtime and CLI package transport helpers with source6/native5 and one rejected user source. It is an equivalent one-off reproduction, not a claim that the absent original was run unchanged. The same frozen reviewer should run the retained original probe on this candidate.

Before: exit 1; six pages prepared; seal 409 `catchup_requires_proposal:rejected_or_unmapped_records`; native rows 5, unchanged. Baseline aggregateSuccess=true/nativeSuccess=false.
After: exit 0; six pages prepared; seal 200; full catch-up completes with source6/native5, reused6, aggregateSuccess=true/nativeSuccess=false; all five native rows, including revisions, remain byte-identical within the run. Raw observations and hashes: catchup-before.log and catchup-after.log. Different independent fixture runs intentionally have different generated revisions/hashes; preservation is asserted within each run.

## Blocking BAR

The selected existing command was preserved exactly:

`node --test --test-timeout=240000 --test-concurrency=1 --test-name-pattern='every complete relocated module copy' foundation/public-copy-secrets.test.mjs`

An initial environment attempt found Gitleaks missing; the repository's checksum-pinned installer supplied Gitleaks 8.30.1, then the unchanged command reproduced the reported deterministic source finding. The valid before run failed only the import-kit copy and its parent: 29 tests, 27 pass, 2 fail, one module-copy finding `scan.github-incomplete src/base/modules/import-kit/src/door/waves/README.md`.

Scanner reference extraction identified ambiguous slash expressions `rer-bounded-waves/1` and `mode/high` in the new README. The corrected README refers to the concrete protocol example below (which retains the exact protocol value) and says source mode and high water. No scanner, detector, allowlist, fixture list, public-flow assertion, test, timeout or skip changed. After: exit 0, 29/29 tests, complete history/environment guarantees and zero findings in each relocated module copy. Raw logs: bar-before-with-prerequisites.log, bar-after.log; initial prerequisite failure retained as bar-before.log.

## Focused validation

- Existing P2 package registration: 1/1 pass. Its existing bounded proof exercises all five original behavior areas, prior schema/data and replay, quotas and native expansion, cumulative catch-up/gone exclusions, authority, strict native edits/reversal, concurrent preparation, real partial-write rollback, erasure, context-only subjects, original/blob byte reconciliation, and the actual `rer business run --once` subprocess. No additional permanent registration was added. See p2-regression.log.
- Existing ordinary catch-up registrations: 2/2 pass, including previously unsupported source retention and new rejected/global threshold/gone refusals. See ordinary-catchup.log.
- `pnpm typecheck:modules`: exit 0, strict TypeScript stages plus 498 module JavaScript checks. See module-typecheck.log.
- Existing portable CLI deterministic inventory / independent execution test: 1/1 pass. See export-mechanical-test.log.
- `node scripts/export-cli.mjs default-seed`: exit 0 before and after the source commit. Final inventory version 0.2.99-dev.gc2c61c41 identifies that source commit. Actual source/copied bytes and every SHA-256 match across 1239 CLI files and 93 onboarding files. See inventory-final.json and export-final.log.
- Default-seed `node scripts/rer.mjs check --profile first-party` and final equivalent `node default-seed/scripts/rer.mjs check --cwd default-seed --profile first-party`: exit 0. The earlier accidental Base authoring-root invocation returned exit 3 for absent OPERATIONS.json, then the correct default-seed invocation passed. Both raw receipts are retained.
- Declared `source:check` frozen offline lockfile check: exit 0. Toolchain used available Node 24.19.0 / pnpm 10.12.4; source:check warns about default-seed's Node 22.20.0 pin. The supplied root toolchain selects a newer available runtime when no root pin exists. Exact pinned CI remains authoritative.
- All 139 tracked SQL/ledger files are byte-identical to original source. Migration/ledger check not needed because none changed. See migration-byte-receipt.json. No SQL, ledger or migration edit.
- `git diff --check`: exit 0. Root CONTRACT/source-lock/contract view regeneration N/A in this author repository; nested module contracts and default-seed/template views were not changed. No acceptance/status/claims/count promotion occurred.

## Clause status and integration boundaries

A/R3 implementation: corrected locally; same frozen independent reviewer pending. BAR source finding: corrected locally; exact final ordinary CI result recorded separately below. Frozen R1/R2/R4/R5 remain unchanged MET; no new acceptance judgment is asserted. Source/native counts stay 6/5, nativeSuccess stays false. Existing whole 157478>100000 refusal is unchanged. HH/BZ real adoption/import/cutover remain UNMET-EXTERNAL. No guessed compiler/grouping/arrangement/signer/vendor integration.

Source, stack and independent-review holds remain active on both original and FIX1. Root must route the SAME frozen reviewer (original first verdict 1 of 2, no new lifetime) against this exact correction. Final integration still needs exact FINAL ordinary AND explicit journeys=true qualification and COMPLETE full-history publication scan through the Mac lander. The ordinary PR event does not enable explicit journeys. Selected relocated-copy scans do not replace full product-history publication qualification. No hold release, landing, submit/readmit or live customer/provider action is claimed. app.happytohelp.com was untouched.

## CI and evidence return

CI is recorded in ci-latest.json and the raw ci-run-*.json receipts; github-calls.jsonl records the bounded calls. One watcher checks each run no more than once every 300 seconds including discovery. A final CI outcome and remaining dependency will be appended before evidence publication.

This packet contains actual non-secret reports, synthetic probe code/logs, identity, mechanical and custody receipts. It is published only under refs/heads/evidence/gr-base-bounded-waves-fix-1, separate from product history and READY/PUSHED custody. Evidence publication is not acceptance or landing.

## Terminal ordinary qualification

2026-11-05 23:20:22 UTC: Verify 42125479357 completed/success on exact final product SHA c0539b0001d71a6246c755e100c47141f525bf5e. Seven of ten recorded GitHub calls used (one PR creation, one discovery, five run polls), with the single run queried at five-minute intervals. No failed-job logs, dispatch or rerun were necessary. Terminal custody is READY for the pushed branch; it is not landing or acceptance. Same frozen review, exact FINAL ordinary plus explicit journeys=true qualification and COMPLETE full-history Mac publication scan remain required, with all source/stack/review holds active. See terminal-receipt.json and ci-run-7.json.
