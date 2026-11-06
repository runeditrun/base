# gr-base-erasure-overmatch-fix-5

B-1 is fixed and builder-verified. The final product head passed exact-SHA Verify. Independent gate acceptance, the fleet publication scan and landing remain separate.

Repository: runeditrun/base
Branch: cloud/gr-base-erasure-overmatch-fix-5
Head: 5961885da3859c758b648f7ff0717e3afd0b7298
PR: https://github.com/runeditrun/base/pull/833
Verify: https://github.com/runeditrun/base/actions/runs/42302783755
Result: completed/success on the exact final head.

## Plan and scope

1. Start from main and carry forward the unlanded fix-4 changes from 30f624e457d5e2dba7dbf6076529d05220a5cee9. Main did not contain that commit.
2. Extend the existing public People-door regression with third-person pending proposals mentioning the erased person's email and long native ID followed by a sentence period. Cover whitespace and punctuation continuation and retain prefix/suffix peers.
3. Reproduce the regression at the exact Base-SHA with unchanged matcher files, then repair one boundary definition per map.
4. Run the full module erasure file, the complete emitted-Worker erasure file, both typechecks and the real reference build. Preserve all assertions and verify Penny parity.
5. Publish only the named product branch with fleet identity and hooks. Open the required PR and require exact-SHA Verify.
6. Resolve the publication fixture failure without changing runtime values, scanner rules or assertions; preserve published history. Publish complete non-secret reports separately through the evidence ref.

The original plan is retained in PLAN.md. Execution produced two product commits because the first had already been published when CI identified the fixture publication issue. No published history was rewritten.

## Product changes

The seed and Penny each have one boundary helper, used on both sides of every literal hit. A period is a separator when its outward neighbor is absent or outside the selector's identifier class. A period followed by an identifier character continues the value. Prefix/suffix peers remain isolated.

The fix retains decoded JSON-string matching, short-ID safeguards, URI path support for long IDs, literal metacharacters and recorded-name Unicode/colon behavior. No setting, migration, field exception, URI exception, new link or contract judgment changed. C-1 and C-2 remain separate follow-ups.

Only five product files changed: the seed map, Penny map, module erasure regression and its two existing fix-4 public-route runtime helpers. All reports and receipts are outside the product tree.

## Before and after

The baseline worktree was at exact SHA 30f624e457d5e2dba7dbf6076529d05220a5cee9. Both matcher files were byte-identical to that SHA (baseline-receipt.json). The expanded public-door regression failed on all four sentence-period proposals and its archive assertion.

Required forms:
- Introduce Gail to ed@acme.test.
- Merge the duplicate record <Ed's native ULID>.

Additional forms cover a period before whitespace, a period before closing punctuation, and a preceding sentence plus space.

Before: 4 pending Gail proposals retained personal text, and the archive retained Ed's native ID.
After: 4/4 held approvals with subject_erased and empty summaries; approve returns 409; claims are re-keyed; audits are tombstoned; one replay alias per decision remains; replay returns subject_erased. Personal proposal mentions in saved inputs and the archive: 4 -> 0.
Fred and the exact runtime ed@x.org.uk suffix peer: approval, claim, audit and usage row differences = 0 across native erasure. Fred's completed replay retains its result and the untouched pending approval still executes.

Map parity: 17 cases x 2 maps = 34 passing selections. Cases cover sentence periods, both sides, email and ID prefix/suffix peers, long IDs in URIs, source-12, source[*]? and source 1. No assertion was weakened or deleted.

## Validation

- Full module erasure file: 18/18 pass; repeated after fixture correction, 18/18 pass.
- Complete emitted-Worker person-erasure file: 12/12 pass, including all ten name cases, old-archive rejection and final clean restore; 172.65 seconds.
- Module typecheck: pass, including 498 JavaScript files checked for syntax, unused declarations and switch fallthrough.
- Default-seed typecheck: pass.
- Required non-interactive fleet-owner setup: pass. Its private installation output is excluded from this packet.
- Real default-seed build: pass.
- Relocated module publication check after fixture correction: 29/29 pass, zero findings, no waivers; Gitleaks 8.30.1 checksum verified.
- Final exact-SHA Verify run 42302783755: completed/success.

Local shell checks used Node v24.19.0 and pnpm 10.12.4 as selected by the supplied cloud toolchain; the maintained runner selects its project runtime for setup/build, and CI uses pinned Node 22.20.0. Runtime map blobs were identical between the full local build/e2e checks and the final fixture-only commit, as recorded in local-receipt.json.

## CI failure and correction

Initial run 42297595918 on c3f4fc8659b659b8babe245f333bcef0a071871a completed failure: 22/23 jobs succeeded, including all six module shards and both reference shards. Only Verify (foundation), job 128166873338, failed. Its relocated modules/agent-door copy publication assertion reported hygiene.email on literal non-reserved synthetic suffix addresses in the regression source.

The required archive command succeeded once:
gh run view 42297595918 --repo runeditrun/base --job 128166873338 --log-failed

Following the publication scanner tests' fixture pattern, the regression now constructs the exact same runtime addresses. No assertion, tested value, runtime matcher, scanner rule or publication waiver changed. The repeated erasure and native relocated-copy checks passed before the correction was pushed. The complete actual failed-job log and all query receipts are included.

One initial discovery used a mistyped SHA and returned an empty list; it was ignored. The actual GitHub budget includes that call: ten calls total. Subsequent watchers read the SHA from Git. Discovery and polling were separated by at least 301 seconds; the final remaining call was delayed to obtain the new head's completed result.

## Commit and publication custody

Initial commit: c3f4fc8659b659b8babe245f333bcef0a071871a
Fixture correction: 5961885da3859c758b648f7ff0717e3afd0b7298

Both guarded product pushes succeeded on their first attempts. The final audit inspected all candidate commits, including side parents: both author and committer are Run Edit Run fleet <fleet@runeditrun.com>, with no co-author trailers. Main remained an ancestor after the final fetch; no merge was needed. The worktree is clean. Published history is preserved.

No main push, release, deployment or inbox write was performed. Evidence publication uses only the separate evidence branch. It does not assert landing or independent gate acceptance.

## Clause status and blockers

B-1: MET by builder evidence and exact-SHA Verify; independent required gate pending.
Prior gate-MET judgments remain unchanged. No CONTRACT.md, ACCEPTANCE.md, docs/CLAIMS.md or generated contract counts changed.
Builder blockers: none.

## Final custody

READY branch=cloud/gr-base-erasure-overmatch-fix-5 head=5961885da3859c758b648f7ff0717e3afd0b7298

Verify run 42302783755: completed/success on exact head 5961885da3859c758b648f7ff0717e3afd0b7298.

B-1 is MET by builder evidence; the independent required gate has not been run by this cloud. There are no builder blockers. Product publication and report-only evidence publication are separate from gate acceptance and landing.

Full plan: PLAN.md. Actual local receipts: local-receipt.json, baseline-receipt.json, identity-receipt-final.json, scope-receipt.json. Actual CI receipts: ci-receipt.json, github-budget.json and github-call-*.log. Product push receipts: product-push.log and product-push-final.log. Selected public packet integrity review: packet-review-receipt.json.
