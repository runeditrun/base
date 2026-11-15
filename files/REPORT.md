# gr-base-flake-backoff-1 report

Signed: Run Edit Run fleet, 2026-11-15.

Repository: runeditrun/base
Branch: cloud/gr-base-flake-backoff-1
Candidate: a7ccc0cd247ce1fb2fa3ce84e22c117c29a5673b
Base: bd23185acf2d54b57edee962cd9267e2b83c252b

## Plan and cause

The complete plan is in PLAN.md. Inspect the clocks and production delay, reproduce ordinary timer precision without load generation, correct only the test infrastructure, run touched tests and typecheck, scan full history, push the named branch, create a draft PR, observe exact-SHA native Verify, and publish this evidence packet separately.

The brief's wall-clock hypothesis does not match the source: listingEdge already uses performance.now(). Production collect() in modules/deploy-kit/provider.mjs awaits node:timers/promises.setTimeout(20000, undefined, {signal}); it has no exported backoff constant. Node timers use millisecond scheduling and do not guarantee an exact high-resolution elapsed duration. Merely replacing Date.now() with performance.now() would therefore be a no-op.

The standalone timer-diagnostic.mjs runs 2,000 sequential real 5 ms waits and records both clocks, with no stress workload, retries or CI loops. On CI's Node 22.20.0, eight waits measured 4 ms with Date.now(); eight monotonic waits measured under 5 ms, with a minimum of 4.113691 ms. On the VM's Node 24.19.0, eleven wall-clock waits and twelve monotonic waits measured early, with a monotonic minimum of 4.093968 ms. This demonstrates the cause on the actual monotonic clock too; changing clocks alone cannot remove it. These samples reproduce the timer behavior; they do not reconstruct the precise delta in the historical failed CI run.

## Change and scope

Only cli/deploy-pagination.test.mjs changes. Keep performance.now() timestamps and the real 20000 ms production timer. A scoped async_hooks observer records native Timeout configuration without mocking, replacing or advancing the timer. The real-wait test independently requires a configured 20000 ms delay, then compares its monotonic elapsed measurement rounded upward to Node's millisecond timer precision against 20000. The failure diagnostic includes the raw measurement. This explicitly permits the sub-millisecond scheduling difference demonstrated above while retaining the exact configured backoff; it does not promise a strict high-resolution physical lower bound that setTimeout itself does not provide.

Production code, production backoff, retry count and real timer execution are unchanged. No new permanent test is added. Existing assertions for no writes during backoff, successful retry and one upload remain. The real-time fixture never enables mock timers. The other timer-controlled scenarios still prove no retry at 19999 ms and a retry after the final millisecond. The new observer reads Node's Timeout _idleTimeout field and is disabled by test cleanup; Node 22.20.0 and 24.19.0 behavior were examined, and the touched test run uses the CI-pinned Node 22.20.0.

The CLI exporter and maintained inventory both exclude this test file (inventory-check.json); no CLI copy or inventory regeneration is needed. No contract source, generated contract view, source lock, claim, clause status, gap or evidence cell changed.

## Local proof

- node --test --test-concurrency=1 cli/deploy-pagination.test.mjs: PASS once, 27/27 tests, zero failures/skips/cancellations. The real-wait test passed in 20570.22903 ms. Complete output: touched-tests.log.
- pnpm --dir default-seed typecheck: PASS with Node 22.20.0 and pnpm 10.12.4. Output: typecheck.log.
- pnpm typecheck:modules: PASS, including syntax, unused-declaration and switch-fallthrough checks of 506 module JavaScript files. Output: typecheck-modules.log.
- Real timer diagnostic: complete script and two actual JSON result files retained.
- Test registrations: eight top-level before and after; 27 expanded executions before and after. Added tests: zero. The pre-change failure count is the one failure reported in the brief; the local pre-change file was not rerun.
- git diff --check: PASS.
- Full-history clone: not shallow. Candidate identity and complete-message audit: PASS, one candidate commit including all parents, fleet author and committer, no trailers (identity-receipt.json).

## Publication and CI custody

Full-history publication scan: PASS and COMPLETE on a7ccc0cd247ce1fb2fa3ce84e22c117c29a5673b, with zero blocking findings and zero warnings. It inspected 1,647 commits/messages, 1,626 trees, 10,849 blobs and 115 tag messages. Its declared remote public base is https://github.com/runeditrun/base.git#main. The scanner classified 166 findings as pre-existing under that public-base policy; they are retained in the complete actual publication-scan.json. No scanner finding was waived or changed by this round.

The guarded product push succeeded on its first attempt. A Git ref probe confirmed the named remote branch advertises the exact candidate SHA. No main/default-branch push, force push, workflow dispatch or rerun occurred. The draft PR is https://github.com/runeditrun/base/pull/870. Its head matches the candidate. The first REST discovery call at 22:17:45 UTC found no runs yet; the single observer waits at least 300 seconds before any further run discovery or status call. Native exact-SHA Verify run 43768480456 completed successfully, observed by REST at 2026-11-15T22:42:45.521692+00:00. The returned head_sha is exactly a7ccc0cd247ce1fb2fa3ce84e22c117c29a5673b, status is completed and conclusion is success. Run: https://github.com/runeditrun/base/actions/runs/43768480456. No contract-generator exception was used. The single watcher made six discovery/status calls spaced at least 300 seconds apart; including the draft PR creation, explicit PR/CI calls totaled seven of the ten-call budget. No failed-job log calls, reruns or dispatches were needed. Complete actual observations are in ci-receipt.json and ci-watch.log. Product push and exact-SHA CI custody are independent from evidence transfer. Evidence is published only to evidence/gr-base-flake-backoff-1 and never changes product acceptance or landing status.

CLAIM: none.
Clause changes: none; all status counts unchanged.

## Terminal result

Product custody: READY on cloud/gr-base-flake-backoff-1 at a7ccc0cd247ce1fb2fa3ce84e22c117c29a5673b. Draft PR: https://github.com/runeditrun/base/pull/870. Verify: 43768480456, completed/success on that exact SHA. Blockers: none. No main/default-branch push or landing occurred. The fleet retains landing custody.

Evidence selection is explicit and checked for regular files and injected credential values before publication. The report-only evidence ref is refs/heads/evidence/gr-base-flake-backoff-1. Product and report refs are separate. The publication command's exact EVIDENCE ref/head receipt is returned in the terminal message. The clone and installed dependencies are removed only after product and evidence remote refs are verified; this packet remains outside that clone.
