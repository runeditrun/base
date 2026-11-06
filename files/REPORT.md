# Done: bounded progress-candidate timeout diagnosis

Tag: gr-publish-progress-reference-triage-1. Repository: runeditrun/base. Role: triage.

Result: UNKNOWN — original timeout did not reproduce in either isolated run. This diagnosis makes no FIX, READY, acceptance or landing verdict. The existing journeys=true qualification remains failed.

| Observation | Exact head | Result | Command wall seconds | Named parent milliseconds |
| --- | --- | --- | ---: | ---: |
| Candidate, once | 5d67855b3a32d51722ef57fa12c1288317803c57 | exit 0; 11 pass / 0 fail / 0 cancelled | 170.938345 | 170072.645778 |
| Intake baseline, once | 601a56e0a5e8e21507003b902949e12723036148 | exit 0; 11 pass / 0 fail / 0 cancelled | 155.296017 | 154481.137885 |

Fresh origin/main observed during the clone is separately recorded as 601a56e0a5e8e21507003b902949e12723036148, equal to the intake baseline. The comparison was never substituted with a moving main. Candidate qualification branch is cloud/gr-publish-scan-progress-land-3. The local triage branch cloud/gr-publish-progress-reference-triage-1 was created from origin/main at that baseline and receives no product commit or push. No PR was opened.

## Plan and actual scope

The complete written plan is PLAN.md. Read the supplied briefs/RULES.md and lanes/gr/STACK-GATES.md inline, the launcher's AGENTS.md, repository AGENTS.md and maintained reference acceptance. Read the actual immutable workflow, bootstrap, reference sharding, verification plan and emitted-runtime helper; WORKFLOW.md records the command chain and deviations from Actions. Cloned only the declared repository, fetched the exact candidate, installed exact Node 22.20.0/pnpm 10.12.4 plus frozen workspace dependencies and probed locked workerd 1.20260907.1. No runner prerequisite failed.

Built the reference application from each head using `pnpm --dir default-seed run build`, then ran only the failed public-door registration once on each head in the same checkout and dedicated Debian 13 x86_64 runner. Both build commands succeeded: candidate 6.044845s; baseline 5.595910s. The baseline build started from removed owned dist output, with the identical frozen dependencies retained. The test helper creates fresh disposable D1/R2 state for each invocation. It requires no browser or live provider.

From default-seed, both case commands were exactly:

```sh
env TZ=UTC RER_VERIFY_WORKERS=1 WRANGLER_SEND_METRICS=false node --test --test-concurrency=1 '--test-name-pattern=recorded names in proposal or audit free text erase with word boundaries and preserve peers' tests/e2e/agent-person-erasure.test.mjs
```

Commands used the supplied cloud_run child-subreaper wrapper, the exact Node binary recorded in runner.json, real HOME and identical loopback proxy exclusions. The original 180000ms timeout and every selected assertion/subcase stayed intact. Separate stdout, stderr, timestamps, exit codes, child PIDs, output byte counts and SHA-256 hashes accompany each actual build/test receipt. gr-capture.py and rer-reap.py record the wrappers. runner.json contains explicitly selected non-secret runtime facts, not an environment dump.

This VM is Debian rather than the workflow's Ubuntu 24.04 init container; Node comes from the pinned npm package rather than the bootstrap tarball. Only this case's prerequisites and command ran, without the rest of the reference shard, browser suites, mail workspace, publication utilities, sibling matrix activity or Actions cache history. The VM's PID 1 is tail; the command-scoped subreaper handles owned descendants. These differences are disclosed limitations of the bounded isolated comparison. No other environment or retry was attempted.

## Exact source and build comparison

candidate-v-baseline.diff is the complete exact-tree diff (25 files, 693 insertions, 34 deletions); its stat is also retained. The candidate changes publication-check progress reporting, corresponding tests/docs, mirrored publisher files and the mirrored inventory. case-and-source.diff is an actual zero-byte Git diff for the named test, its fixtures, reference application source/migrations, erasure/agent-door/portability modules, lockfile/dependency manifests and workflow/test command/setup paths. source-objects.json records identical Git objects for the relevant existing sources and explicitly identifies absent paths. The named test SHA-256 is d282732afea63ad878185d56a174e7fefef2a0e83df55bcdc12da66eaef0c1a5 on both heads.

There are 56 candidate and 56 baseline build files: 55 of 56 have identical hashes, including all emitted server Worker files. Only the generated client/reference/index.html differs; no source cause is inferred from that generated file. Both build file hash maps and build-comparison.json are retained. The publisher progress code is not invoked by the selected public-door case.

## Actual behavior and counts

Each isolated run contains one selected parent and ten nested cases: 11 total tests for candidate and 11 for baseline. Neither run adds, deletes, skips, weakens or edits a registration. Both complete the name-erasure, peer-preservation, replay fences, old-archive rejection and final clean export/restore checks. In every name case, personal proposal/audit payloads fall 2 to 0 while the peer remains byte-identical. Approval/call/audit/usage row counts stay unchanged (first case 3/4/4/1; final case 30/40/40/10). Final restore retains 20 non-personal proposal and audit stubs and rejects old archives with erasure_epoch. Full PROBE lines are in the raw TAP logs and diagnosis.receipt.json.

The prior failed CI file invocation's 13 pass / 0 fail / 1 cancelled includes other registrations; the isolated 11 pass / 0 fail / 0 cancelled results have a narrower scope and are not a whole-suite before/after improvement. Clause status changes: none. Contract, lockfile, source and test changes: none. Product commits/pushes: zero. No publication scan, release, HH third scan, GitHub dispatch/rerun or landing was performed.

## Existing CI and disposition

Two completed-run REST reads independently confirm the exact candidate SHA: ordinary Verify 42216473958 is completed/success; explicit journeys=true Verify 42226188314 is completed/failure. Their exact JSON receipts and URLs are in ci-runs.receipt.json. Dispatch input values are attributed to the brief because the run metadata does not expose them. The brief's already-read log identifies failed job 127920266857, reference 2/2, agent-person-erasure.test.mjs:196, parent timeout at 180269ms after all ten nested cases passed. No log archive was downloaded again. GitHub core API calls: 2 of the ten-call budget; no polling or workflow mutation.

Proposed disposition to GR: retain UNKNOWN for the original timeout and report non-reproduction on the bounded same-runner comparison. No candidate-only source regression or minimal correction is established by this evidence. The candidate parent runs near its existing 180000ms bound, but timing proximity and unchanged source do not prove an infrastructure cause. Do not relax the timeout/assertions or treat this successful local case as replacement qualification: the original exact-SHA explicit journeys run remains red under STACK-GATES. A future timing investigation would need a separate scoped brief; this run does not authorize it or issue a FIX verdict. If FV takes timing follow-up, send these measured receipts as observations rather than an infrastructure finding.

No blocker prevented the authorized two-run diagnosis. Final terminal relay names the unchanged clause status, candidate SHA, both existing CI run IDs and the actual result. The selected reports and receipts publish only through evidence/gr-publish-progress-reference-triage-1. The local triage branch/main and product history remain unchanged. Once report transport completes, delete the owned checkout/node_modules and scratch, retaining this packet outside the clone; the final message records cleanup.
