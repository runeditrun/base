# fv-base-asset-retry-1-pc1

Repository: runeditrun/base (treated as public).
Product branch: cloud/fv-base-asset-retry-1-pc1.
Saved head: fd6d971af46b3aa88a8f6eb649153002a605e5a4.
Candidate: 055cf2c085cf720371a050be5999d85d95a3b39f.
PR: https://github.com/runeditrun/base/pull/837.

## Plan and scope

1. Initialize fleet Git credentials and commit hooks, clone only the declared product repository, and check out the existing continuation branch.
2. Preserve the saved product commit and investigate the cited Verify failure using the REST jobs API and the prescribed failed-job archive command.
3. Review both installers against main. Preserve the pinned versions, URLs, checksums, checksum verification, installation behavior, and workflow files. Merge current main rather than rewriting the published save.
4. Validate Bash syntax and actionlint on callers. Run the existing workflow-planning tests. Run both unmodified production installers against a local TLS HTTP server that supplies 503 twice then the real pinned archive. Check full-budget persistent-504 failures without adding a product override.
5. Audit all candidate identities and messages, push the named product branch through cloud-push.py, open a PR against main, and inspect exact-SHA Verify under the ten-call budget.
6. Preserve actual non-secret results outside the product repository. Publish only explicitly selected packet files to the separate evidence ref.

## Product changes and provenance

The starting commit already implemented the requested behavior in both scripts:

- curl --retry 120 --retry-all-errors --retry-delay 5 --retry-max-time 600 --max-time 60.
- The final failure line names the archive, last HTTP status, and curl exit code.
- actionlint stays at 1.7.7; Gitleaks stays at 8.30.1.
- The release URLs, all platform hashes, and checksum-checking statements are unchanged.
- No mirror, dependency, workflow, cache-key, job-shape, or product test change.

The only new product-history commit in this continuation is a non-rewriting merge of origin/main, 055cf2c085cf720371a050be5999d85d95a3b39f. It retains the saved commit and incorporates the upstream 0.2.102 release bookkeeping already on main. No independent release or version bump was made here. The product checkout is clean. Both candidate commits have the fleet author and committer, with no trailers. Product push succeeded on its first attempt. No main or default-branch push was performed.

Relative to current main: 2 installer files changed, 18 insertions, 4 deletions. Relative to the saved installer implementation: 0 installer changes. Workflow changes: 0. New permanent tests: 0.

## Before/after behavior and counts

Before the original saved change, actionlint had no retry flags and Gitleaks had 5 retries at 5-second intervals with retry-all-errors but no total retry deadline. Both now permit 120 retries with retry-all-errors and a 600-second retry-start budget, plus a 60-second per-attempt timeout. An attempt started near the deadline can extend wall time beyond 600 seconds by up to its per-attempt timeout. There are 2 new final download-error messages.

Both installers recovered from exactly 2 local 503s and succeeded on request 3 in approximately 10 seconds, including the original SHA-256 verification and real binary installation. No pin or verification was substituted.

## Validation

- bash -n: both installers and their bootstrap caller pass.
- actionlint 1.7.7: all repository workflows pass, including verify.yml and rer-release.yml.
- Existing cli/verify-ci.test.mjs: 4 passed, 0 failed.
- git diff --check: passes.
- Both real remote release downloads installed successfully with their original pinned hashes.
- Machine comparison confirms version, URL, every platform checksum and checksum-verification statements match current main.
- Local fault-injection proof uses a temporary curl wrapper only to route the unchanged github.com URL to a local TLS listener and trust its temporary certificate. Retry parameters, output and exit behavior are production curl. Real pinned archives are served after the injected failures. Harness and temporary TLS keys remain outside the product/evidence trees.
- The initial TLS harness omitted Content-Length, causing curl 56 after responses. That harness was stopped and corrected; only the corrected harness supplies the successful proof. This was a harness defect, not a product failure.

## Earlier Verify investigation

The cited Verify run 42476381817 had a later cancelled attempt 2, so its latest jobs listing contained no failed jobs. Attempt-1 jobs identified failed job 128718618745, Verify (cli 5/5). The supplied continuation also names cli 1/5 and cli 2/5; those were not returned as failures in the available attempt-1 jobs response.

Both prescribed archive attempts returned exit 0 with empty stdout and stderr:
gh run view 42476381817 --repo runeditrun/base --job 128718618745 --log-failed
gh run view 42476381817 --repo runeditrun/base --attempt 1 --job 128718618745 --log-failed

No assertion or transport error was available from those commands, so no product fix was inferred from missing logs. The saved implementation was preserved and reverified after merging current main.

## CI and publication

The candidate PR triggered Verify run 42489627168 on exact head 055cf2c085cf720371a050be5999d85d95a3b39f. Discovery also returned Release rer run 42489597476. Discovery showed both in progress; a final exact-SHA receipt is recorded separately after local proofs complete. CI reads are limited to the ten-call budget. No claim is made from another SHA.

A local publication scan was requested in addition to the independent Mac publication gate. Its initial --public-base origin/main argument was rejected because the scanner requires a URL#branch. It was rerun with https://github.com/runeditrun/base.git#main. The actual final report is included separately; no local result substitutes for the fleet's independent publication scan.

## Clauses and acceptance

No contract clauses, statuses, generated views, or claims were changed. Before/after clause-change count: 0/0. This repository has no root CONTRACT.md for these installer changes. No acceptance or landing is claimed by evidence publication.

## Custody

All actual report files are under /home/agent/rer-consolidation/work/fv-base-asset-retry-1-pc1/packet. Explicitly selected files are published only to refs/heads/evidence/fv-base-asset-retry-1-pc1. The evidence tree is separate from the product checkout and branch and contains no credentials, environment dumps, symlinks, TLS keys, or held-out material.

Local publication scan details: the first valid scan reached its default 300-second deadline, returned exit 2 and INCOMPLETE/scan.deadline-exceeded. Its receipt is publication-scan-300s.json. A second scan uses the supported --timeout-seconds 1200 option to allow full-history analysis. Only its actual final result can establish a local pass.

Corrected local fault-injection result: actionlint's always-504 path completed after 601.07 seconds and 121 total requests (initial attempt plus 120 retries), exit 22. Its final line was exactly:
Download failed for actionlint_1.7.7_linux_amd64.tar.gz (last HTTP status: 504; curl exit: 22)
Both recovery cases passed with exit 0 after exactly three requests: actionlint in 10.10 seconds and Gitleaks in 10.28 seconds. The separate Gitleaks always-504 production-budget proof follows, without changing any budget parameter.

The longer local publication scan passed with complete=true, exit 0: 1,525 commits, 1,505 trees, 10,290 blobs, 1,525 commit messages and 99 tag messages. The full actual receipt is publication-scan.json. The independent fleet publication gate remains required.

Gitleaks persistent-504 proof: 601.11 seconds, 121 requests, exit 22. Final diagnostic: Download failed for gitleaks_8.30.1_linux_x64.tar.gz (last HTTP status: 504; curl exit: 22)

Final exact-SHA Verify receipt: {"conclusion":null,"head_sha":"055cf2c085cf720371a050be5999d85d95a3b39f","html_url":"https://github.com/runeditrun/base/actions/runs/42489627168","status":"in_progress"}. All 10 GitHub calls used.

## Terminal results and pending work

All touched local checks pass. Persistent failures are bounded for both tools: actionlint 601.07 seconds / 121 requests / exit 22; Gitleaks 601.11 seconds / 121 requests / exit 22. Both final lines name the correct pinned archive and last HTTP status 504. Both 503,503,200 recovery cases succeeded with checksum verification on request 3. Existing workflow-planning tests: 4 passed, 0 failed. Publication scan: PASS, complete=true, 0 new findings, 0 warnings. Contract clause changes: 0. Product changes relative to main: 2 files, +18/-4. Additional installer changes in this continuation: 0.

Verify 42489627168 remained in_progress with null conclusion at the final exact-SHA REST check. The full ten-call GitHub budget is exhausted; no further API polls were made. Product custody is PUSHED, with CI pending. There is no observed red check for this candidate and no product push blocker. The fleet should observe this exact run/head before granting READY and landing PR 837. The earlier red/cancelled run is preserved as historical evidence, not used to judge this candidate. Release rer 42489597476 was also in_progress at discovery; no later result is claimed.

Terminal product provenance:
PUSHED branch=cloud/fv-base-asset-retry-1-pc1 head=055cf2c085cf720371a050be5999d85d95a3b39f

No local test servers, curl retries, or started browser/server processes remain. The product checkout is clean. Evidence publication is separate report custody and does not establish CI success, acceptance, READY, or landing.
