# Browser advice follows checkout requirements

Signed: Run Edit Run fleet, 2026-11-16.

Repository: runeditrun/base. Product branch: cloud/gr-base-browser-advice-1.
Candidate: 3f30348f6ffbcfe4906048550ea28b6e79f82725.
Read/current main at preparation: bbab5d84b72e333ff1e9a6f234c0512e5721b1d9.

## Plan and implementation

The complete plan is in PLAN.md. Reproduce the browser prerequisite through public doctor entrypoints, fix the required executable selection and advice together, prove it with synthetic registries, refresh the maintained export last, run touched checks and typecheck, scan the full history, publish the product branch and draft PR, then observe native exact-head Verify. Return this report and actual receipts on the separate evidence branch.

The reproduction uses a synthetic checkout whose Playwright registry resolves full Chromium and its headless shell, and executable files that must never be launched. Both bin/rer.mjs and global/rer.mjs reproduce the baseline. The initial doctor reports an unrelated nonzero aggregate status because the minimal checkout intentionally lacks local setup; assertions inspect the actual browser section independently.

Before: with neither executable, doctor says "Playwright browsers not downloaded yet: chromium, chromium-headless-shell; rer verify downloads them the first time it runs." With only the shell it says "Playwright browsers not downloaded yet: chromium; rer verify downloads them the first time it runs." With both it has no browser download note. Complete actual outputs are in before-browser.jsonl.

After: the headless default needs only the registry's chromium-headless-shell. Its presence produces no missing-browser note, whether full Chromium is absent or present. When the shell is missing, advice names chromium-headless-shell, explains headless verification, gives exactly one browser-only command derived from the resolved Playwright CLI, and states that rer install installs dependencies without browsers. The synthetic command is `pnpm exec node node_modules/playwright-core/cli.js install chromium-headless-shell`.

A checkout that also needs headed Chromium declares `commandAdapter.browser = { headless: false }`. Doctor, describe, lifecycle verification and the installed launcher's prerequisite path use that declaration. Headed use adds full Chromium to the headless shell used by verification. With a working shell and missing full Chromium, the single command instead ends in `install chromium`. The selected Playwright CLI owns all revision/platform decisions; no revision is hardcoded. The installed package-script runner also recognizes explicit --headed/--debug in the selected Playwright script and forwarded arguments.

The new describe browser section reports the same requirement as doctor. Missing browser downloads remain a normal deferred prerequisite, preserving browser.ok=true when Playwright itself is inspectable. Missing Playwright still points to dependency repair with rer install.

The existing first-use installer did download more than headless verification needs. It now selects the headless-shell target for headless checkouts, and Chromium for headed use or legacy pins without a separate shell. It retains dependency environment, browser-cache environment override, cancellation, captured command execution and refusal if installation finishes without the required executable. The installed-launcher preflight now checks browser presence rather than the inspection-success flag, which previously admitted a missing executable without provisioning it. Inspections never launch a browser or run the installer.

The documented `node scripts/export-cli.mjs default-seed` refreshed maintained CLI sources, their inventory and paired command documentation after source edits. No CONTRACT status, Gap, Evidence or generated acceptance view was edited. No UI screens changed and no screenshot proof applies. Source inspection and synthetic fixtures need no owner/provider accounts.

## Validation and counts

- Focused browser test registrations: 1 before, 1 after. The existing test is replaced with the one focused synthetic public-door journey; no increase.
- Default required executable count: 2 before, 1 after on current Playwright pins.
- Missing-browser advice with shell-only headless use: 1 warning before, 0 after; neither-present use remains actionable; both-present use remains silent. Headed-with-shell-only use correctly warns about the one missing Chromium executable.
- Touched regression group: 11 tests passed, 0 failed, 0 skipped in touched-tests-final.log (browser runtime, doctor diagnostics/custody, describe effects and installed run/queue/list).
- Maintained portable CLI source inventory check: 1 passed, 0 failed in copy-check.log.
- Reference typecheck: passed. The supplied toolchain selects Node v24.19.0 from the unpinned authoring root; pnpm reports the reference's Node 22.20.0 engine warning, and tsc succeeds. CI uses the repository's Node pin.
- The pinned reference Playwright CLI accepted both browser-only targets under install --dry-run. Its actual resolution is in pinned-cli-dry-run.log. The headless target includes Playwright's auxiliary FFmpeg dependency but does not install full Chromium. No browser was downloaded or launched by these checks.
- An initial broader test invocation omitted cloud_run and the two doctor custody cases timed out. Running them under the required child subreaper passes both; the final entire touched group under cloud_run also passes. The original observation and successful recheck are retained in touched-tests.log and custody-recheck.log.
- Candidate identity: one new commit, fleet author and committer, no coauthor trailer. Hook active, no bypass. Full history clone is not shallow. Reconciliation with origin/main required no replay changes.
- Clause status changes: none. CLAIM: none. Acceptance/status counts unchanged.

Publication scan: PASS, complete=true, zero new findings on the exact candidate tree. Its selected/public-base history contains 1,652 commits, 1,631 trees, 10,869 blobs, 1,652 commit messages and 116 tag messages. The full clone has 2,797 commits across local refs. Full actual report: publication-scan.json. Product branch push succeeded on its first guarded attempt. Draft PR: https://github.com/runeditrun/base/pull/874. Native pull_request Verify run 43840095497 completed/failure on the exact product SHA. The separate Release rer dry-run build (43840087819, job 133206290788) completed/success and its publish job was skipped; no release operation was manually invoked. Final exact-head CI details follow and are recorded in receipt.json. No full local verify was run; native pull_request Verify is the full wall. Product publication and evidence return are separate from landing.

## Terminal CI result and blocker

Product remains pushed at 3f30348f6ffbcfe4906048550ea28b6e79f82725 on cloud/gr-base-browser-advice-1, in draft PR https://github.com/runeditrun/base/pull/874. It is not READY.

Verify: https://github.com/runeditrun/base/actions/runs/43840095497 — completed/failure, exact head confirmed at each observation. Twenty-two of 23 jobs passed. The sole failed job is `Verify (cli 2/5)`, job 133206425787; its step 13, `Run full-verify stages assigned to this job`, failed. The final check-run output has two annotations, but title, summary and text are null. No claim is made about the failing assertion or its cause.

Required archive command, invoked exactly once:

```sh
gh run view 43840095497 --repo runeditrun/base --job 133206425787 --log-failed
```

Observed result: exit 0, stdout 0 bytes, stderr 0 bytes. HTTP status was not supplied by gh. Both actual empty files are retained. There is no transport-error body to quote and no failed assertion was exposed. No direct job-log blob request, archive retry, rerun or workflow dispatch was made.

All ten observer/PR GitHub calls were used: PR creation, exact-SHA discovery, Verify/Release observations, failed-job listing, the one archive command and the final check-run diagnostic. The two annotations could not be fetched within that budget. The product is blocked on diagnosing and resolving the red exact-SHA Verify job; this is not treated as an allowed generated-contract-view failure. The independent fleet/lane can retrieve job 133206425787's annotations or a usable log and resume diagnosis on this exact pushed commit.

To exclude the local Node-version difference as the cause of the touched behavior, the browser prerequisite test and both describe tests were also run under CI's exact Node 22.20.0 pin: 3 passed, 0 failed, 0 skipped. Actual output: ci-pin-touched-tests.log. The maintained hook was reinstalled after runtime setup. Product source, branch and index remain unchanged.

Release rer check runs on this exact head: build completed/success; publish completed/skipped, as required for a branch dry run. Actual check output: ci-check-runs.json. No npm publication, deployment or main push was performed.

Clause changes and claims remain none. Before/after counts remain: focused registrations 1 -> 1; default required executables 2 -> 1; shell-only missing-browser notices 1 -> 0. Complete relevant local and CI reports/receipts are explicitly selected for the separate evidence ref. A successful evidence transfer does not promote this red product candidate to READY or authorize landing.
