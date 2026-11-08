# Preview planner channel fix

Tag: gr-base-preview-plan-channel-1
Repository: runeditrun/base
Branch: cloud/gr-base-preview-plan-channel-1
Head: ba5686bf8091b1425b01302b100908a89d3c3eda
Base main: 055cf2c085cf720371a050be5999d85d95a3b39f
PR: https://github.com/runeditrun/base/pull/838

The planner's private serialized Worker options now travel only over a dedicated fd-3 pipe. Its stdout goes to the resident runtime's stderr, so Wrangler banners remain visible without entering the JSON parser. The planner ends its fd-3 stream and awaits completion before exit. The runtime reads `planner.stdio[3]` and uses `Resolving the Worker configuration failed.` for non-zero exits or empty/invalid JSON results. The `stopping` check and `planner.kill('SIGTERM')` behavior are unchanged. No plan file, argument, output marker or environment knob was introduced.

## Changed files

1. `onboarding/production-plan.mjs`: stream the serialized result to fd 3 and finish it before exit.
2. `onboarding/production-runtime.mjs`: spawn with `['ignore', 2, 'inherit', 'pipe']`, read only fd 3, and normalize malformed/empty output failures.
3. `onboarding/preview-plan.test.mjs`: four cases through the public `previewTarget`, retaining the real planner, options conversion, Miniflare listener and shutdown. Only Wrangler's resolver is fake.
4. `default-seed/scripts/base-onboarding/production-plan.mjs`: regenerated matching copy.
5. `default-seed/scripts/base-onboarding/production-runtime.mjs`: regenerated matching copy.
6. `default-seed/scripts/base-cli/inventory.json`: regenerated hashes for the two onboarding sources.
7. `global/CHANGELOG.md`: Unreleased fix line.

Regeneration used the repository's `node scripts/export-cli.mjs default-seed`. Source bytes, vendored bytes and inventory digests match. The exporter retained its existing version-stamp behavior; no release or package version changed. The only product commit has 98 insertions and 12 deletions across these seven files. All fleet reports remain outside the product tree.

## Results

| Check | Result | Actual file |
| --- | --- | --- |
| New tests on original main implementation | 2 pass / 2 fail; banner fails with `SyntaxError: Unexpected token 'U'` at `JSON.parse`; empty output gives raw parse error | `regression-before.log` |
| New tests with fix, Node 22.20.0 | 4 pass / 0 fail | `regression-after-node22.log` |
| Existing onboarding suite, unchanged | 221 pass / 0 fail, including new cases | `onboarding-tests-node22.log` |
| Existing preview journeys, unchanged | 3 pass / 0 fail; scheduled triggers, fixed production workerd/data/assets/owner entry/teardown, build-output declarations | `preview-existing-tests-node22.log` |
| Reference typecheck, Node 22.20.0 | PASS | `typecheck-node22.log` |
| Portable CLI source inventory / independent execution | 1 pass / 0 fail | `cli-copy-tests.log` |
| Source/copy/inventory equality | PASS | verified against generated inventory |
| Diff whitespace check | PASS | `git diff --check` |
| Candidate identities and trailers, including side parents | PASS; one fleet-authored and fleet-committed candidate, no trailers | `identity-audit.log`, `commit-messages.log` |
| Product branch push | PASS on first attempt, fleet push guard | `product-push.log` |

The banner test emits both `Using secrets defined in .dev.vars` and an ExperimentalWarning on planner stdout. The same real runtime announces its actual listener and serves the same resolved origin and private-setting outcome as the quiet control. Captured runtime stdout remains empty; both diagnostic lines reach runtime stderr; the synthetic private setting never appears in either output stream. Non-zero and empty planning never announce a listener. A separate isolated-copy fault injection also checks the malformed fd-3 case without modifying the product checkout (`check-invalid-plan.mjs`, `invalid-plan-check.log`).

Initial broader attempts exposed the VM's default Node 24, inherited umask 0077, and missing default Playwright executable. The Node-24 preview suite stopped at its install hook before preview assertions; the first onboarding attempt was terminated after environment failures. Actual logs are retained. Final validation used installed official Node 22.20.0, standard umask 0022, and system Chromium with `--no-sandbox` through an external launch adapter; no repository tests were edited to accommodate the VM. This is a runtime transport change with no application UI edits.

## Publication and CI custody

Current main was fetched before committing and remained the base SHA above. One commit was created using the required author/committer environment and active fleet hook. It was immediately pushed only to the named product branch. No published history was rewritten. The commit's `[skip ci]` marker suppresses a duplicate PR-triggered run; exactly one manual Verify was dispatched.

Verify run: https://github.com/runeditrun/base/actions/runs/42508769042
Exact head: ba5686bf8091b1425b01302b100908a89d3c3eda

The fleet shell publication wrapper was not shipped in this cloud launcher. The scan uses Base's maintained `node scripts/publish-check.mjs` entry point with the required repository, exact head, public-base and project flags and an 1800-second deadline. Final observed conclusions are recorded below. `verify-receipt.json` retains timestamped REST observations; `publication-scan.json` is the actual full scanner output. The cloud does not land main or perform a release. Evidence publication is independent of product readiness.

## Clause changes and counts

No CONTRACT clause status changed, no clause was promoted, and no generated contract view was edited. Promotions: 0 before / 0 after; changed clauses: 0. Regression counts: 2 pass / 2 fail before, 4 pass / 0 fail after. Existing onboarding: 221 pass / 0 fail. Existing preview: 3 pass / 0 fail. Product commits: 1; changed files: 7. Full procedure is in `PLAN.md`; structured actual local receipts are in `RECEIPT.json`.

## Final observed gates

Publication scan: **COMPLETE PASS** on the exact candidate. Scanned 1,526 commits, 1,506 trees, 10,295 blobs, 1,526 commit messages and 99 tag messages. Hydrated 7,050 missing blobs in one fetch; missing afterward: 0. Actual output: `publication-scan.json`.

Verify: **completed / success**, run 42508769042, exact head `ba5686bf8091b1425b01302b100908a89d3c3eda`. Observed at 2026-11-08T18:37:29.851550+00:00. Product status: **READY**. No blockers. No main push or landing occurred.
