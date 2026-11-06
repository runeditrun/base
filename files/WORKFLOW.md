# Actual workflow and case selection

Read from candidate 5d67855b3a32d51722ef57fa12c1288317803c57. The checked paths are byte-identical to baseline 601a56e0a5e8e21507003b902949e12723036148. Source snapshots accompany this report.

Verify declares Ubuntu 24.04 and a digest-pinned Ubuntu 24.04 job container with `options: --init`. It installs checkout prerequisites, restores apt/pnpm/Playwright caches unless clean_bootstrap, and invokes `bash scripts/agent-bootstrap.sh`. That script selects Node 22.20.0, pnpm 10.12.4, workerd 1.20260907.1 and Playwright 1.63.0, installs frozen workspace dependencies (permitting only esbuild/workerd native installers), installs the separate mail workspace, and probes workerd/Chromium. It also installs publication/workflow-checker utilities. No publication scan was run in this task.

Job settings relevant to the failed command are `TZ=UTC`, `RER_VERIFY_WORKERS=1`, `VERIFY_GROUP=reference`, `REFERENCE_SHARD=2`. The job command is `node scripts/ci/verify.mjs "$VERIFY_GROUP"`. The root reference runner invokes `node onboarding/queued-entry.mjs verify:reference -- node scripts/verify-ci.mjs <name>` with cwd `default-seed`, sequentially selecting every push reference shard except journey-erasure. The seed runner invokes `pnpm run verify:app` with `SEED_VERIFY_SHARD=import-archive`. That plan's commands are:

```sh
pnpm run build
node --test --test-concurrency=1 tests/e2e/import-archive.test.mjs tests/e2e/agent-person-erasure.test.mjs
```

The selected test is the top-level registration at agent-person-erasure.test.mjs:196, `recorded names in proposal or audit free text erase with word boundaries and preserve peers`, with an unchanged 180000ms timeout. It has ten sequential nested cases, followed by clean export/restore assertions. Its helper creates an emitted built Worker, an HTTP loopback listener, real migrated D1/R2 stores and signed test proposals; no browser or live provider is involved. The final destination runtime and restore occur after the ten nested cases. A timeout after those cases does not identify the stalled operation by itself.

For this bounded diagnosis the workflow build command is retained, while the test command is narrowed with `--test-name-pattern=recorded names in proposal or audit free text erase with word boundaries and preserve peers`, retaining concurrency=1 and every assertion/subcase in the selected registration. No other registration or suite runs. Exactly one candidate case and one exact-baseline case are permitted.

This dedicated Debian 13 x86_64 VM is within AGENTS' documented Ubuntu/Debian Linux support. Exact Node 22.20.0 and pnpm 10.12.4 were installed from npm, frozen workspace dependencies installed successfully and locked workerd probed successfully. Only prerequisites needed for this case were installed. The VM's PID 1 is tail, so commands use the supplied PR_SET_CHILD_SUBREAPER wrapper to reap their own descendants, rather than pretending that the VM itself has the workflow container's init. Test settings and process wrapper are identical for both heads. The real HOME remains unchanged; loopback hosts are excluded from the proxy; test fixtures generate disposable local bindings without the held-key injector. The Actions container, full shard history/cache/load and Ubuntu-specific conditions were not recreated. The receipts establish the bounded isolated comparison, not reproduction of every Actions condition.

The explicit journeys input controls the additional journeys matrix group. The timed-out case is in the ordinary reference push tier, not the extra journeys group. The input alone therefore does not establish a cause. Existing successful ordinary run 42216473958 and failed journeys=true run 42226188314 both report the exact candidate SHA through REST; dispatch input values and the previously read failure transcript remain attributed to the assignment. Two API calls were used, one per completed run. No log archive download, dispatch or rerun was made.
