# fv-base-asset-retry-1

Repository: runeditrun/base. Product branch: cloud/fv-base-asset-retry-1.
Candidate: fd6d971af46b3aa88a8f6eb649153002a605e5a4.
Base at checkout: 1787bcce2348921f7cf2088188fe37c7c959910c.
PR: https://github.com/runeditrun/base/pull/836.

## Plan

1. Configure fleet identity, launcher credentials and preserved repository hooks; read launcher and Base instructions. Clone only the declared write repository and create the named branch from main.
2. Give both pinned installers identical bounded curl retries and a final failure diagnostic. Preserve release URLs, versions, platform checksums, HTTPS restrictions, extraction and installation. Change no workflows, caches, dependency manifests or job shape.
3. Validate syntax and workflow callers. Run each actual installer against a local HTTP server serving 503 twice and then its real pinned archive. Also run each installer against persistent 504s with the full production budget, without adding an environment override or product mock code.
4. Commit only the two installers, inspect every candidate identity/message, push using the fleet guard and open a PR. Require exact-candidate-SHA Verify through bounded REST polling. Keep reports on the separate evidence ref and leave landing/publication gates to the fleet.

## Change and counts

Only scripts/install-actionlint.sh and scripts/install-gitleaks.sh changed: 18 added and 4 removed lines.
Actionlint retries: 0 -> 120. Gitleaks retries: 5 -> 120. Both use --retry-all-errors, --retry-delay 5, --retry-max-time 600 and --max-time 60.
The 600-second retry window bounds when retries start; curl may finish an in-flight 60-second attempt after that window, so the worst stalled-transfer envelope is about 660 seconds. Immediate HTTP failures exhaust in about 600 seconds.
The final error line includes the archive name, last HTTP status (000 when no HTTP response exists), and curl exit code; the installer preserves curl's nonzero exit code.
Version pins remain actionlint 1.7.7 and Gitleaks 8.30.1. All eight platform checksums and both upstream URL templates remain byte-identical.
Workflow/cache/job changes: 0. Dependencies added: 0. Permanent tests/product mocks: 0. Contract clause/status changes: 0; Base has no root CONTRACT.md for this scope.

## Validation

- bash -n: both touched installers and their agent-bootstrap caller passed.
- actionlint 1.7.7: all six repository workflows passed, including Verify (via agent-bootstrap) and rer-release (direct Gitleaks caller).
- git diff --check passed.
- Gitleaks 8.30.1 with the maintained publication scanner configuration scanned the one candidate commit (1111 bytes): no leaks. This is the candidate-diff secret check, not the fleet's final publication/landing scan.
- Local 503/503/200: each unmodified installer used real curl and the production retry settings, made exactly three requests, passed its real SHA-256 check, extracted and installed its pinned binary. Actionlint: exit 0, 10.116 s; Gitleaks: exit 0, 10.224 s.
- The harness intercepts curl through PATH solely to redirect the original GitHub URL and HTTPS-only protocol switches to local HTTP. All retry/timing/write-out/output options remain unchanged. Receipts preserve both original and local invocations. Harness code is evidence only.
- Full-budget persistent-504 results and terminal exact-SHA CI custody are recorded below.

## Custody and limitations

The first real commit was pushed successfully on the first guard attempt. Candidate author and committer are both Run Edit Run fleet <fleet@runeditrun.com>; there are no trailers. No main/default branch push, history rewrite or landing occurred. The PR remains for the lane. Publication scan and merge remain the fleet's responsibility. Evidence publication is independent of product readiness.

## Completed persistent-504 proof

- actionlint: 121 HTTP 504 responses; exit 22 after 600.786 seconds; no binary installed. Final diagnostic: `Download failed for actionlint_1.7.7_linux_amd64.tar.gz (last HTTP status: 504; curl exit: 22)`.
- gitleaks: 121 HTTP 504 responses; exit 22 after 600.784 seconds; no binary installed. Final diagnostic: `Download failed for gitleaks_8.30.1_linux_x64.tar.gz (last HTTP status: 504; curl exit: 22)`.

All four local server cases passed with the production retry settings. No budget override was introduced or used. Each persistent failure ended at approximately 600.8 seconds, matching the ten-minute budget with minor process/scheduling overhead.

The selected evidence packet also passed a Gitleaks secret scan (34.05 KB, zero leaks). All selected files are regular files; no credentials, environment dumps, symlinks or held-out gate material are selected.

## Terminal CI custody

Verify: https://github.com/runeditrun/base/actions/runs/42476381817. The discovery and all five status polls reported exact SHA fd6d971af46b3aa88a8f6eb649153002a605e5a4. At the final poll (2026-11-08 12:00:06 UTC), status remained in_progress and conclusion was null. Polls were at least 300 seconds apart. Nine of the ten allowed GitHub calls were used, including the PR creation/update and one discarded incorrect-SHA discovery; no success was inferred from another SHA.

Terminal product status: PUSHED, not READY. Required next gate: wait for exact-SHA Verify success, then fleet publication scan and landing through PR 836. No known code/test blocker; CI is still running. No contract clauses changed. Complete local plan/results and actual receipts are in this packet; evidence publication does not change product readiness.
