# Container executable archive policy

Task: gr-base-container-policy-module-1. Repository: runeditrun/base.
Initial main: e82790b601c62e077a1a09380fc787531d9cded5.

## Read-first findings (recorded before product changes)

`cli/container-transfer.mjs` creates an isolated transfer container from the candidate image, mounts the installation's existing named data volume at `/data`, copies only transfer configuration and import archive bytes into its private directories, and invokes `modules/container/transfer.mjs` under the installation flock. Node-engine transfers open `D1('/data/<binding>.sqlite')` and `Objects(platform, '/data/objects', binding)`. Workerd transfers use `workerEngine` and its real Miniflare D1/R2 adapters on the same persistent data directory. No provider credentials are required.

The shared portability catalogue validates the declared policy; export applies row projection/redaction and import applies normalization and staged validation before publication. Both engines already call the same createPortability/exportArchive/importArchive modules and use the native archive format.

The native worker calls loadPolicy before opening bindings for preflight. During transfer it calls loadPolicy again with `{ db: proxy.env[binding], buckets: boundBuckets }`. loadPolicy confines the seed configuration entry with policyModuleURL, validates module.default and the optional createPolicy factory result, and retains executable closures inside the child process.

Read public Crank source through GitHub API only: `src/crank/archive-policy.mjs` has local imported functions (fenceRow, importRow, importSafety, validateRestore), a default policy with include/exclude/secret-column/configuration declarations, and an additional restoreArchive export. This requires preserving module imports and closures, rather than serializing a policy object. No other repository was cloned or changed.

## Plan

1. Preserve current-main failure evidence using a public container portability fixture and adapter-edge fake.
2. Package only the seed-configured policy module and its static module dependencies as executable JavaScript without evaluating it in the CLI. Resolve the entry with policyModuleURL; never derive code from the archive. Execute it in the existing isolated transfer process with the actual container D1/bucket bindings.
3. Validate the default policy and factory signature before opening data or applying migrations; validate the bound factory result when the real bindings are available, matching native timing. Keep other policy refusals and the shared archive format.
4. Exercise container/native round trips and cross restores; invalid default, escaping entry, ambiguous declaration, executable inline policy, and factory contract failures. Verify touched suites and typechecks. Update the changelog and regenerate the delivered CLI only with the repository exporter if required.
5. One product commit, inspect all candidate identities/messages, guarded branch push, one exact-head Verify dispatch, full-history publication scan, and separate evidence publication. Open a PR under Base landing rules. Never write main or lane inbox files.

## Additional source confirmation

Public Crank `scripts/installer/local.mjs:24` declares `localPortability({ database: 'foundation', policyModule: 'src/crank/archive-policy.mjs', ... })`. This declaration was confirmed through the contents API after implementation began; the module itself and its imported-hook shape were read before product changes. No Crank checkout or write was made.

## Implemented design and safety evidence

- The only source entry is the adapter's seed configuration. `cli/portability.mjs:51` and `cli/container-transfer.mjs:22` use the unchanged `policyModuleURL`; the compiler child checks it again. Escaping paths, escaping symlinks and non-file URLs retain that resolver's refusal. Nothing in archive metadata supplies code or the module path.
- `cli/container-policy-worker.mjs:12` compiles the module/import graph using the installation's existing Wrangler esbuild dependency. It does not import the policy, evaluate seed configuration, run bundler plugins, stringify callbacks, or add a dependency. The private bundle is copied into the existing transfer container; its temporary host directory is removed after every attempt.
- The Docker entry point, image and named-volume mount remain the existing transfer boundary. Only the private policy copy is added. There is no additional filesystem mount, network endpoint, provider permission or CLI flag. The compiler is also a child process. The fixture throws if the policy is evaluated in the public CLI process.
- `modules/container/transfer.mjs:22` calls unchanged `loadPolicy` before opening data or running migrations. This validates `module.default` and the optional factory's type. After migrations, line 49 calls the same loader with `{db,buckets}`, matching native's default-preflight/bound-factory timing (`cli/portability-worker.mjs:41`, `:56`). For acknowledged schema recovery, the bound policy is available for the existing emptiness preflight too. Both the default and returned policy retain catalogue validation.
- Node bindings are the existing SQLite-worker D1 and persistent Objects adapter; workerd bindings are the existing workerEngine D1/R2 adapters, initially opened without automatic migrations. Tests make the factory actually query the database and list its bucket, and put the secret-column redaction only in its returned policy. This proves the factory result is used. Cleanup closes workerd through its owner rather than touching a database proxy after Miniflare disposal.
- Shared export projection remains `modules/portability/catalogue.mjs:179`. Import normalization remains `modules/portability/import.mjs:208`, staged validation `:214`, and object publication `:221`. The format and version are unchanged. Byte compatibility means each transport reads the other's unmodified archive bytes; random installation identities and timestamps need not produce identical archives.
- The obsolete container-only refusal is removed. `ambiguous_policy`, `invalid_policy_module` and `policy_module_required` retain their existing validation and symbolic reasons. The false native-only sentence is removed. The old native-suite assertion for the removed refusal now checks a real escaping-path refusal instead; all other existing suite logic is unchanged.
- The container image's runtime includes the same policy loader via `modules/container/build.mjs:94`. The maintained CLI copy and inventory were regenerated only with `node scripts/export-cli.mjs default-seed`, after its inventory test demonstrated that regeneration was required. `global/CHANGELOG.md` has one Unreleased fix line.

## Test scope and before/after observations

Current-main baseline: the two selected public-door tests both failed, with the positive export failing specifically with `container_policy_module_unsupported`; the escaping-path expectation was likewise masked by that guard. Complete actual output is in `baseline-tests.txt`.

Final coverage expands to three cases: a Node round trip/cross-restore, the same workerd round trip/cross-restore, and a shared refusal case. Each uses the exported public `rer export/import --platform container` door. Docker process and file-copy operations alone are faked; the transfer code, compiler child, module loader, SQLite D1/object or workerd D1/R2 adapters, native Wrangler worker and shared archive code are real.

For each engine, source `computed_entries` contains one row (`quantity=3`, a private label), and its bucket contains one object with `retained bytes`. Export applies the policy: quantity becomes 0 and the secret label is absent. Empty destinations go from 0 to 1 row and 0 to 1 object; restored data is inactive and the label is null. The container receipt retains the exported content hash. Container bytes restore natively; native re-export restores both natively and back into a fresh container, with the same row and object bytes. An integrity-valid archive whose row violates staged validation is refused with `staged_validation`; its destination remains at 0 rows and 0 objects.

Both public export and import refuse escaping paths, escaping symlinks, simultaneous policy/policyModule, executable inline policy and an invalid default before a destination SQLite file exists. An invalid factory type also refuses during default preflight. An invalid bound factory result is rejected after the ordinary migrations, before any transfer; its product table remains empty.

No root CONTRACT.md exists in Base, so no source clause judgments, ACCEPTANCE.md, docs/CLAIMS.md or source lock were changed. The required functional status changes from blanket container-policyModule refusal to the verified container path; this report does not promote a seed acceptance clause. No release, tag, npm publication, seed-policy edit or main push was performed.

## Product custody

One product commit on e82790b601c62e077a1a09380fc787531d9cded5: ff4626ffbc43b29846644f955fd3926af93fb571, branch cloud/gr-base-container-policy-module-1. The guarded first push succeeded on attempt 1. A fresh ls-remote matched the exact local head. Author and committer are Run Edit Run fleet, trailers are absent, and the worktree is clean. See product-receipt.json. Product publication and evidence transfer are separate.

### Every changed product file

- `cli/container-policy-worker.mjs`
- `cli/container-policy.test.mjs`
- `cli/container-transfer.mjs`
- `cli/fixtures/container-portability-docker.mjs`
- `cli/portability-policy.test.mjs`
- `cli/portability.mjs`
- `default-seed/scripts/base-cli/cli/container-policy-worker.mjs`
- `default-seed/scripts/base-cli/cli/container-transfer.mjs`
- `default-seed/scripts/base-cli/cli/portability.mjs`
- `default-seed/scripts/base-cli/inventory.json`
- `default-seed/scripts/base-cli/modules/container/build.mjs`
- `default-seed/scripts/base-cli/modules/container/transfer.mjs`
- `default-seed/scripts/base-cli/modules/portability/README.md`
- `global/CHANGELOG.md`
- `modules/container/build.mjs`
- `modules/container/transfer.mjs`
- `modules/portability/README.md`

## Completed local checks and publication scan

- Exact product head: `node --test cli/container-policy.test.mjs`: **3 passed, 0 failed** (Node, workerd, both public-verb preflight refusal vectors). `container-policy.tap` and `container-policy-receipt.json` retain the complete final output and exact-head receipt.
- Existing shared portability and container suites: **243 tests, 240 passed, 3 skipped, 0 failed**. Command: `node --test --test-concurrency=2 modules/portability/tests/*.test.mjs modules/container/tests/*.test.mjs`. Full actual output: `existing-modules.tap`.
- `pnpm typecheck:modules`: PASS, including JavaScript syntax/unused/fallthrough checks over 499 module files. `typecheck.txt`.
- Strict portability public types command from verify:portability: PASS. `portability-types.txt`.
- Maintained CLI copy/inventory test: PASS after the repository exporter. `cli-copy-check.tap`.
- Full-history publication scan: **COMPLETE PASS**, zero findings, Gitleaks 8.30.1. The clone was non-shallow and all promised objects were materialized (11,673 initially missing; 0 before scanning). The full actual redacted report is `publication-scan.json`; its exact command, size and SHA-256 are in `publication-scan-receipt.json`. The fleet-only `.tools/publish-check.sh` was not shipped, so the equivalent maintained Base entry point documented in scripts/publish-check-README.md was used with all requested repository/ref/public-base arguments.

Baseline's 0/2 selected tests pass becomes 3/3 in the expanded final suite. The three additional broad-suite skips are existing intentional cases; no test was disabled to obtain a pass.

## Review and CI custody

PR: https://github.com/runeditrun/base/pull/840 (open, target main, exact product head; pr-receipt.json). No merge or landing was attempted. Exactly one manual Verify was dispatched, run 42552700415: https://github.com/runeditrun/base/actions/runs/42552700415. The normal pull-request workflow is managed by the repository. One watcher discovers and polls the manual run with REST; its persisted observations assert the exact product SHA and are spaced at least 300 seconds apart. CI completion is recorded in the final receipt below, independently of evidence publication.

Existing native/hosted CLI portability regressions also completed: `node --test --test-concurrency=2 cli/*portability*.test.mjs`, **18 tests passed, 0 failed**, including nested schema cases (9 top-level cases). Complete actual output: `existing-cli-portability.tap`. No local check remains pending.

## Terminal result

**PUSHED**, branch `cloud/gr-base-container-policy-module-1`, head `ff4626ffbc43b29846644f955fd3926af93fb571`, PR #840. Product work is committed and remotely preserved; no work remains unpushed.

Verify run **42552700415** was last observed at **2026-11-09T03:08:57.599611+00:00** with status **in_progress**, conclusion **None**, and the exact head above. The ten direct GitHub calls are recorded in api-call-ledger.json (four required public-reference reads, one manual dispatch, one run discovery, three status polls, one PR creation). With that direct-call budget exhausted while Verify is still running, the cloud protocol requires a **PUSHED** handoff. **READY is not claimed.** This is pending CI custody, not a missing implementation or a failed local check. The normal PR checks and the lane's independent exact-head verification remain authoritative before landing.

Final local summary: 3 new passes; 258 existing module/CLI passes and 3 existing skips; 1 inventory test pass; module and portability public typechecks pass. Baseline selected coverage was 0/2 and the expanded final suite is 3/3. No CONTRACT clause judgments changed. Complete publication scan PASS remains bound to this exact product head. A separate Gitleaks scan of the report packet found no leaks (packet-secrets.json and packet-secrets.txt).

The final receipt is terminal-receipt.json. Evidence is published only as a separate report tree at refs/heads/evidence/gr-base-container-policy-module-1; that transfer does not signal acceptance or landing. There is no product blocker beyond awaiting the required CI result, and no published history was rewritten.
