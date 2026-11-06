# SEC-3 non-first object-key repair

Tag: gr-publish-sec3-object-key-1. Repository: runeditrun/base.

Product branch: cloud/gr-publish-sec3-object-key-1.
Full candidate SHA: 7e78f21a12e1a14ee73d4e3e1a0c066527c9db4d.
Candidate tree: 43701bd8995a0bec997eb216f6d7eb3be020b096.
Initial and final fetched main: a15b3ad0fd51ed1d52f7aee61d4e70eb0adb95e8; tree c2498d3df00e65b32c36d5473a460b33be660d68.
Builder clone: shallow/blobless, clean at custody capture. No PR was created, as directed.
Product source save: e6dcc42b8d406084b5e9bba86ccdf92f9614021a [skip ci].
Final candidate: 7e78f21a12e1a14ee73d4e3e1a0c066527c9db4d; guarded nonforce product push succeeded on first attempt.

## Result and limits

The lexical helper tracks parentheses, braces and brackets using the existing tokenizer. A bare credential name in an object no longer inherits parameter context merely from a comma. Simple function/arrow/method quoted literal annotations and supported declarations remain excluded; credential equals-defaults remain assignments. The marker/classifier/provider/environment policies are unchanged. Both README claims now distinguish Gitleaks allowlists from SEC-3 placeholder and leading synthetic marker behavior and state the lexical parser's limits.

The before public CLI probe was complete FAIL/1 from a native finding but lacked SEC-3 at second.mjs:1. The corrected maintained and generated scanners report SEC-3 at second.mjs:1. All seven frozen positive locations and seven annotation/declaration negative controls passed after the fix. The ten-command after matrix also passed marker, history/public-base, outcome, review-rejection and non-disclosure checks. Raw value-free JSON is preserved without source literals or credential-value hashes.

One selected-tree worker comparison over tracked initial-main bytes found 0 incumbent SEC-3 occurrences and 43 candidate occurrences across 33 paths. Every newly exposed location was inspected as a generic SYNTHETIC test input; zero exact credential formats were present. The 43 original occurrences now use the existing synthetic- marker. The receipt verifies zero remaining findings at those identified lines after relabeling; this is not another whole-tree scan. There were 53 marker insertions including matching consumer expectations. All 33 fixture diffs consist only of inserting synthetic-; no test/expectation was removed. Zendesk's edge auth comparison, Z0/package non-disclosure assertions and deliberate body-removal fixture remain meaningful and passed their required consumer tests.

## Commands and POINT receipts

POINT-RECEIPTS.json contains actual argv, exits, source fullSHA/tree, output names and per-POINT references. Successful shared same-head commands are referenced once. The exporter receipt names source commit e6dcc42; all final focused commands and the after matrix name 7e78f21a12e1a14ee73d4e3e1a0c066527c9db4d. Some clean flags captured concurrent temporary test directories; terminal product custody is clean. The initial hosted-assignment receipt also observed one extra uncommitted test-only marker expectation that was discarded as unrelated; maintained scanner/test bytes were the candidate's exact committed bytes.

| POINT | Local result | Main receipts |
| --- | --- | --- |
| P1 | PASS: extended named public behavior, later-key SEC-3 and annotation/default controls | hosted-assignment; before/after-matrix; final-syntax |
| P2 | PASS: marker policy/guide, inventory/classifications, Zendesk; environment caveat on one additional consumer | zendesk; selected-tree-sec3-inventory; fixture-classifications; fixture-consumers-*; file-mode-observation |
| P3 | PASS: two declared runtime copies and inventory only; generated scanner public-door reproduction | export; export-applicability; portable-inventory; after-matrix |
| P4 | PASS: deleted/ignored/other-ref/history/public-base behavior | history-controls; after-matrix; preservation-trace |
| P5 | PASS: complete PASS/0, FAIL/1, INCOMPLETE/2, forbidden SEC-3 review and value-free output | outcome-controls; after-matrix; preservation-trace |

The five exact required focused commands passed: 12 tests total. Additional actual non-browser fixture consumers: 23 passed, 1 failed and 1 original macOS-only skip. The standalone existing native-types consumer passed. node --check passed all 37 changed maintained/generated .mjs/.mts files. No candidate test was retried; no timeout was increased.

The one additional failure is default-seed/tests/local-setup/cli.test.mjs, ordinary build excludes local credentials and restores the exact file after success and failure. Exit 1: the mode assertion expected decimal 416 (0640), observed 384 (0600). This cloud task inherits umask 0077. A separate empty-file observation requested 0640 and immediately observed 0600 before any application ran. The test already passed its exact-byte and same-inode assertions before the hardcoded mode check. The source diff only prefixes its inherited synthetic environment input and matching non-disclosure expectation. This is an environment/test assumption, not evidence of a scanner or file-restoration regression; the failure remains reported, not converted to PASS. No baseline or failed-test rerun was performed and no assertion was weakened.

Deferred consumer details are in deferred-consumers.json. The brief excludes browser, package/reference builds and unrelated suites. The optional reinvitation upgrade consumer also requires an unprovided independent baseline. The existing OS-boundary companion test self-skipped on Linux for lack of sandbox-exec. These are explicit proof limitations for later qualification, not newly disabled tests.

## Counts and clause status

Scanner registrations in scripts/publish-check/tests.py: 29 before, 29 after. The existing hosted-credential registration stays 1 before/1 after and retains incumbent controls. No JavaScript registrations were added, removed or newly skipped. Later-key reproduction SEC-3 count: 0 before, 1 after at the named line. Newly exposed selected-tree occurrences: 43; remaining at identified relabeled locations: 0. Changed product paths: 40. Clause status changes: none; no CONTRACT, generated acceptance view or summary count changed.

## Distribution and N/A

cli/export.mjs sourceRoots exports scanner runtime through the existing exporter. node scripts/export-cli.mjs default-seed regenerated exactly credential_assignments.mjs, credential_syntax.mjs and inventory.json under default-seed/scripts/base-cli. Its source-derived stamp remains e6dcc42; subsequent edits only align test expectations and generated files. Tests, cli/fixtures and the top-level publication guide remain outside the export surface. No package/reference build or downstream refresh was performed.

Neither Base root nor default-seed has sources.lock.json at the source pin, and Base root has no CONTRACT.md. Source-lock and contract-listing commands are N/A. No dependency, edition-selection, SQL/schema or migration changed; migration ledger is N/A. No scanner TypeScript project exists, so scanner module typecheck is N/A; JavaScript syntax/public behavior checks apply. The separately changed test-only native-types .mts consumer was typechecked with its actual imports and passed. pnpm locks were untouched.

## CI, acceptance and custody

Exact-SHA REST discovery returned HTTP 200, zero runs for 7e78f21a12e1a14ee73d4e3e1a0c066527c9db4d; CI run IDs: none. One GitHub call was used, within the ten-call budget. Current Verify triggers main/tags/PRs and supports manual ordinary/journeys inputs; it does not trigger ordinary cloud pushes. GR explicitly owns the one initial ordinary dispatch and its waiter. No workflow was dispatched/rerun and no PR was opened to obtain CI. There is no exact-SHA green Verify proof and therefore this handoff is PUSHED, not READY or accepted. The independent-gate hold was not read, mutated or released.

GR's next authorized action is ordinary Verify on this exact branch/SHA, journeys=false and clean_bootstrap=false, followed by the independent frozen-rubric gate. The later Mac lander owns fresh reconciliation, its own ordinary 300-second COMPLETE/fullhistory publication scan using current Base main, and exact-final ordinary plus journeys=true,clean_bootstrap=false Verify before guarded integration. This builder performed no Base product history scan. The selected-tree candidate-worker inventory is discovery evidence only, not publication PASS. Vendor and HH/BZ/W1 custody remain separate.

Complete implementation plan: IMPLEMENTATION-PLAN.md. Actual product provenance: product-receipt.json. Per-POINT receipts: POINT-RECEIPTS.json. CI discovery: ci-discovery-receipt.json. Evidence is published only through refs/heads/evidence/gr-publish-sec3-object-key-1; product checkout/head/index are not modified by that transport. No credential files, environment dumps, secret values, symlinks or independent held-out gate material are selected.

## Changed paths

- `cli/agent-door-hooks.test.mjs`
- `cli/business-connect.test.mjs`
- `cli/companion.test.mjs`
- `cli/deployment-record.test.mjs`
- `cli/fixtures/business/server.mjs`
- `cli/fixtures/business/zendesk-data.mjs`
- `cli/fixtures/companion/server.mjs`
- `cli/fixtures/dependency-deploy.mjs`
- `cli/fixtures/dependency-link.mjs`
- `cli/reference-journey.test.mjs`
- `default-seed/scripts/base-cli/inventory.json`
- `default-seed/scripts/base-cli/scripts/publish-check/credential_assignments.mjs`
- `default-seed/scripts/base-cli/scripts/publish-check/credential_syntax.mjs`
- `default-seed/tests/local-setup/cli.test.mjs`
- `default-seed/tests/local-setup/native-bindings.test.mjs`
- `global/tests/package-pin.test.mjs`
- `live-proofs/tests/linux-ci/browser.mjs`
- `modules/dependencies/tests/admission-transition.test.mjs`
- `modules/dependencies/tests/local-provider.test.mjs`
- `modules/dependencies/tests/owner-approval.test.mjs`
- `modules/dependencies/tests/runtime.mjs`
- `modules/deploy-kit/tests/asset-upload.test.mjs`
- `modules/editor/tests/compiled-native.browser.test.mjs`
- `modules/mail/tests/core/validation.test.mjs`
- `modules/mail/tests/sendgrid/conformance.mjs`
- `modules/operator-auth/tests/cancellation-runtime.mjs`
- `modules/operator-auth/tests/native-auth.test.mjs`
- `modules/operator-auth/tests/native-types.check.mts`
- `modules/operator-auth/tests/presentation.test.mjs`
- `modules/operator-auth/tests/regression-runtime.mjs`
- `modules/operator-auth/tests/reinvitation-upgrade-runtime.mjs`
- `onboarding/adapter-settings.test.mjs`
- `onboarding/private.test.mjs`
- `onboarding/redaction-shapes.test.mjs`
- `operations/mail-bindings.test.mjs`
- `operations/operations.test.mjs`
- `scripts/publish-check-README.md`
- `scripts/publish-check/credential_assignments.mjs`
- `scripts/publish-check/credential_syntax.mjs`
- `scripts/publish-check/tests.py`
