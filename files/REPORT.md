# Foundation deploy journey contract repair

Author: Run Edit Run fleet. Date: 2026-11-15T07:56:12Z.

Repository: runeditrun/base
Branch: cloud/gr-base-public-variable-fix-1
Candidate: ab89bea760f0be8a708a056a5c6ae611b5e09abd
Tree: 8fb6f5531826668b13140691e6ebd6dd12185391
Base: eb290f0dfb493d5c696533393ef1cf047cf41d2e

## Root cause and smallest correction

The prior mail-off change a6cd96182e3474c612b9b43b9f69affcf1087cf5 intentionally moved foundation MAIL_PROVIDER and MAIL_FROM from fixed public vars into optional environment-mapped secret bindings. The real reference journey still unconditionally wrote MAIL_FROM to deploy.json vars while supplying only MAIL_API_KEY through its private env-file. ownerPlan retained the declared MAIL_FROM secret and the newly added MAIL_FROM var; validatePlan correctly rejected the duplicate with invalid-public-variable. This was a stale journey input, not a defect in the validator. MAIL_PROVIDER=none was investigated and is not the failing producer.

The journey now locates its declared MAIL_FROM mapping and supplies the synthetic production sender through that environment name. Seeds that declare a public sender retain their existing vars input. The identical public deploy command, D1 plan check, no-account dry-run guarantee and complete reference lifecycle assertions remain. The existing small public deploy flow now checks that the mapped sender stays a secret binding, is absent from public vars, and a duplicate still fails.

Changed paths: cli/reference-journey.test.mjs and cli/deploy-mail-binding.test.mjs. No application mocks, runtime changes, validator relaxations, fallback, retry, auth changes, removed assertions or narrowed journeys. No auth/security policy gate is introduced by this test-input correction. No release preparation/version commit was absorbed; current main was eb290f0dfb493d5c696533393ef1cf047cf41d2e.

## Plan and execution

The full plan is PLAN.md. Launcher rules and repository AGENTS.md/README.md were read, together with the inline RULES.md and only relevant deploy/foundation implementations. Base has no root DIRECTION.md, CONTRACT.md or ACCEPTANCE.md. No missing clause ruling was inferred. The checkout began shallow/blobless as requested, then fetched full main history for the supported publication scan. Fleet identity and hooks remained active. Dependency setup used frozen pnpm 10.12.4; official Node 22.20.0 was acquired after the VM's newer Node triggered the exact-version requirement. No private provider credentials were used.

Before publishing, current main was fetched and the clean committed candidate rebased (already up to date). An initial rebase before committing correctly refused unstaged changes; it made no changes. All product work is in one real commit without a skip marker. No published history was rewritten.

## Actual local proof and counts

public-door-probe.mjs composes a real foundation from unchanged pre-fix main, frozen-installs dependencies and invokes the real public CLI/build door without provider credentials. public-door-receipt.json and public-door-probe.log contain the actual outcomes, not claimed deploy success:

- Before, the unchanged journey's duplicate MAIL_FROM public input: exit 1, command_failed / invalid-public-variable, resources created: none.
- After, the same dry-run command with the declared sender input: exit 0, ok=true, dryRun=true, deployed=false, providerChecked=false, real D1 DB plan; MAIL_FROM stays in secrets and not vars.
- Explicit MAIL_PROVIDER=none: exit 0, dry-run only; MAIL_PROVIDER stays in secrets and no new public binding is invented.
- Enabled resend without a mail credential: exit 4, Production sign-in is not configured, before build/upload.
- Explicit none plus a mail credential: exit 4, contradictory outbound-email inputs refused.
- A numeric public variable: exit 1, invalid-public-variable remains enforced.

The probe compares input preparation because only the journey input changes. It did not rerun the failed release qualification SHA. The focused executable public flow asserts the same input rule on the exact candidate.

`node --test --test-concurrency=1 cli/deploy-mail-binding.test.mjs cli/production-auth.test.mjs`: PASS, 10 tests, 0 failures, 0 skipped; actual output in targeted-tests.log.
`pnpm --dir default-seed run typecheck`: PASS; actual output in typecheck.log.
`git diff --check`: PASS. Candidate checkout clean.

Affected-file test registrations before/after: 14/14 (reference lifecycle: 2 kinds x 4 registrations = 8; mail-binding: 4 parents + 2 provider subtests = 6). No permanent registrations added or removed. Local selected tests: 10/10 pass. Failing public door count: 1 before, 0 after; six actual probe cases recorded. No source-root exported runtime files changed, so exporter/inventory/source-lock regeneration is unnecessary; there is no root sources.lock.json. CONTRACT statuses, gaps, evidence and generated acceptance views are untouched. Clause status changes: none; no DONE/PARTIAL claim is made.

## Publication, CI and custody

Publication scan, push, PR and exact-head CI outcomes are recorded in the final section below and their actual receipts. Product refs and report evidence refs are separate. No main push, landing, deployment, account mutation, tag or release is authorized or performed.

Product push: PASS on first attempt through cloud-push.py; exact named branch only, receipt product-push.log. All candidate author/committer names and addresses are fleet identity, with no trailers or side parents.

PR: https://github.com/runeditrun/base/pull/860 (head ab89bea760f0be8a708a056a5c6ae611b5e09abd, base main). Ordinary Verify is requested by the PR. Initial exact-SHA discovery returned no runs immediately after PR creation; one workflow dispatch with journeys=true was accepted. No failed-SHA retry was made. The task's REST observer records each core call and enforces 300-second minimum discovery/poll spacing; actual receipts are separate JSON files.

The first full-history, no-public-base scan completed, status FAIL, with 166 historical SEC-3 findings, all in blobs already reachable from origin/main. It reported no current working-tree findings and no changed-file findings. publication-history-summary.json verifies that inherited ancestry by opaque blob IDs without exposing any values. Those historical bytes are outside this repair's scope and are not rewritten. The supported public-main comparison scan follows; its original result is retained separately rather than replacing the first receipt.

Supported publication scan with --public-base https://github.com/runeditrun/base.git#main: PASS, complete=true on exact candidate ab89bea760f0be8a708a056a5c6ae611b5e09abd / tree 8fb6f5531826668b13140691e6ebd6dd12185391. Zero new findings; 166 inherited findings are classified preExisting. Full history remains scanned. Actual receipt: publication-public-main.json. No publication policy or review file was altered.

Exact candidate runs discovered after the pacing interval: ordinary PR Verify 43692435308 and explicit workflow_dispatch Verify 43692435119 (journeys=true), both head ab89bea760f0be8a708a056a5c6ae611b5e09abd and in_progress at discovery. Their final status receipts follow.

At approximately ten minutes, ordinary and journeys Verify were both still in_progress on the exact head. Those receipts are ci-ordinary-0810.json and ci-journeys-0810.json. Four of ten observer/PR/dispatch core calls remained, so the next observation was deliberately delayed to preserve diagnostic budget. This wait does not constitute qualification.

Cleanup before terminal evidence publication: disposable composed probe checkouts were removed by fixture after-hooks and all probe/check/scan subreapers exited successfully; no owned server/browser was left alive. Root and reference node_modules were removed, and the product worktree remained clean. cleanup-receipt.json records the actual checks. The clean product clone is retained solely until evidence publication succeeds, then removed before the final message.

At approximately twenty minutes, ordinary Verify 43692435308 and journeys Verify 43692435119 were both still in_progress on the exact head (ci-ordinary-0820.json, ci-journeys-0820.json). Two of ten core calls remained. The final paced status calls are reserved for the next interval; no green run or journey qualification is inferred from elapsed time.

## Terminal result

Author: Run Edit Run fleet. Terminal observation date: 2026-11-15T08:25:26Z.

Branch cloud/gr-base-public-variable-fix-1, head ab89bea760f0be8a708a056a5c6ae611b5e09abd, tree 8fb6f5531826668b13140691e6ebd6dd12185391, PR https://github.com/runeditrun/base/pull/860.

Ordinary Verify 43692435308: in_progress / None; exact head ab89bea760f0be8a708a056a5c6ae611b5e09abd.
Explicit journeys=true Verify 43692435119: completed / success; exact head ab89bea760f0be8a708a056a5c6ae611b5e09abd.

Product custody: PUSHED. Qualification: NOT QUALIFIED; exact-head required CI has not both completed successfully. 10/10 task core calls used. No rerun or second dispatch, no result from another SHA, and no main push, merge, release or deployment. Both original and public-main comparison publication receipts are retained; the exact candidate comparison is COMPLETE/PASS with zero new findings. No clause status changes.

No known product blocker remains from local proof. Required CI is still running at the final budgeted observations, so this is a pushed correction awaiting qualification, not READY and not accepted or landed. The fleet must observe both named runs on this exact SHA before landing.

Full plan: PLAN.md. Actual public-door receipts, targeted test/typecheck output, exporter decision, publication scans, push custody, PR, CI observations, call ledger and cleanup receipts are selected explicitly for report-only evidence transfer. Evidence publication is separate from product qualification. The product clone is removed after successful evidence publication, confirmed in the final task message.
