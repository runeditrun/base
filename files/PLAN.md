# gr-base-flake-backoff-1 plan

Signed: Run Edit Run fleet, 2026-11-15.

1. Configure fleet Git credentials, identity and commit hooks; clone full-history runeditrun/base and work only on cloud/gr-base-flake-backoff-1.
2. Inspect listingEdge and the production settling-list delay. Run one diagnostic of 2,000 real 5 ms timers, recording both Date.now() and performance.now(), without load generation or CI loops.
3. Correct the test infrastructure according to the observed cause. Keep the 20000 ms production configuration, real timer, no retries, no new permanent tests and no contract status edits. If the initial hypothesis differs from the code, record that explicitly.
4. Run the touched deploy-pagination test file once, including the real wait, and the reference typecheck. Confirm the test file is excluded from the maintained CLI inventory.
5. Fetch main and rebase any unpublished commit before publication; inspect every candidate commit's authors, committers, trailers and complete messages. Run a COMPLETE full-history publication scan on the candidate with zero blocking findings.
6. Commit only the test infrastructure change and push with cloud-push.py. Open a draft PR to main for native pull_request Verify. Observe exact-SHA Verify through REST with one watcher and no more than one call per run per 300 seconds, within the ten-call GitHub budget.
7. Retain complete non-secret plan, diagnostics, check receipts, publication scan and CI/product custody report in this packet. Publish explicitly selected evidence files only to evidence/gr-base-flake-backoff-1. Report terminal provenance, clause/count changes and the gr inbox relay line.

Initial finding: main bd23185acf2d54b57edee962cd9267e2b83c252b already records performance.now() in listingEdge; production awaits node:timers/promises.setTimeout(20000). There is no exported backoff constant. A monotonic clock replacement alone is a no-op and cannot fix this failure. The diagnostic therefore measures monotonic and wall clocks side by side.

Execution result: all seven plan steps completed. The observed-clock default was the precision-aware assertion with a native, real-timer configuration observation; production remained unchanged. Local touched checks, both typechecks and COMPLETE full-history publication scan passed. The one product commit was pushed once and draft PR 870 obtained successful exact-SHA Verify 43768480456. No claims, clause changes or blockers. Final evidence transfer and clone cleanup follow the recorded custody checks.
