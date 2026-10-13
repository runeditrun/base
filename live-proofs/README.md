# Dispatch-only proofs and stage deployment

These two workflows are the Base reference for T-002b and T-025. Only dispatch
from `main`, after these files have landed on the default branch. Supply the
complete lowercase 40-character commit SHA; a branch, abbreviated SHA, Git
expression, option or shell expression is rejected. The named proof currently
registered is `secrets-present`.

`validate` has no GitHub Environment. It checks the dispatch envelope before
checkout, checks out the immutable **workflow** SHA, and runs that controller's
validator. It never executes or imports target source. Fresh main and `v*` tag
refs must agree before/after fetch, the controller must remain reachable from
main, and the target must be a commit reachable from main or a release tag.
Allowed tags have names matching `v[A-Za-z0-9][A-Za-z0-9._-]*`. Ref deletions,
retags, force pushes during that snapshot, unrelated commits and non-commit
objects fail closed. This establishes authorization at validation time; later
ref movement cannot change the immutable source checked out for execution.

Only the dependent execution and receipt jobs attach to `live-proof` or `stage`.
The owner must configure deployment branch policies for main and release tags,
and enter Environment secrets (Q-0-0007):

- `CF_THROWAWAY_API_TOKEN`
- `CF_THROWAWAY_ACCOUNT_ID`
- `EVIDENCE_REPOSITORY` (private destination URL, stored as an environment secret for log masking)
- `EVIDENCE_WRITE_TOKEN` (contents write limited to the configured private evidence repository)

The proof process receives only the first two credentials. `secrets-present`
prints only present required provider secret names and fails if either is empty.
The independent writer checks its evidence credential by performing the actual
push; the proof never receives it. No production Environment is used.

The controller and target checkouts disable credential persistence; every action
is pinned to its full commit. Proof output is discarded so it cannot become logs,
workflow commands or evidence. The trusted harness emits the required names and
fixed status values only. Provider commands run as argv arrays with a minimal
environment, no implicit shell, and no evidence token. Receipt persistence runs
on a separate fresh runner, checking out only the controller, with the evidence
token and no provider credentials. No broad artifacts are uploaded.

## Receipts and failure semantics

The writer reconstructs a small exact JSON schema from bounded statuses and run
metadata, never a proof-uploaded payload, command, URL or destination. It writes
`3-foundation/T-002b/runeditrun--base/<workflow>/<run-id>-<attempt>.json` in the
private repository configured by the trusted workflow environment secret `EVIDENCE_REPOSITORY` (an HTTPS GitHub URL ending in `.git`; missing or malformed values fail closed). Receipts include requested and
executed SHA (null if checkout did not complete), controller SHA, harness argv,
actually invoked provider/proof argv, UTC times, run/attempt, job result and a
fixed failure status. They contain no stdout, exception strings or secret values.

A bare Git transport creates an append-only tree/commit with no checkout, filters
or hooks. Existing receipts and parent files/symlinks cannot be overwritten.
Non-fast-forward races refetch and append to the latest tree, at most five times;
an unchanged remote after failed push fails immediately. Any persistence failure
fails the workflow. There is no artifact-only fallback. Failed/missing-secret,
blocked-stage, deploy-failed, health-failed and execution-job failures are persisted
by `always()` once validation passed. A cancelled/terminated GitHub runner or
unavailable store cannot guarantee persistence; that is an explicitly failed run,
never successful proof evidence. **Validation rejections do not unlock an
Environment, so they remain failed Actions runs without a store receipt.** Giving
an evidence token to a rejected source would break the pre-secret validation gate.

## Stage adapter: blocked until the real target exists

Base root has no OPERATIONS descriptor or deploy script. The inspected
`default-seed/package.json` has build/dev/preview/typecheck/verify only, and
`default-seed/wrangler.jsonc` specifies `database_id: local-reference-only`.
Its README verifies disposable local workerd. The separate foundation template's
`pnpm run deploy` publishes a binding-free generated Worker; it is not a Base
stage target. Therefore `stage-adapter.mjs` deliberately returns
`stage-target-unconfigured`, a failed durable receipt, without deployment or a
claimed health check.

T-057/default-seed must supply the actual stage resources/configuration, deployment
entrypoint and remote health gate, and document them in the target's operations.
Then replace the reviewed descriptor with `blocked: null`, a checkout-relative
`cwd`, and nonempty `deploy` and `health` argv arrays. The executor already runs
deploy first, fails on nonzero/timeout, then runs the real health command and fails
on nonzero/timeout. No command or health URL may come from workflow inputs.
Commands receive the Q-0-0007 names above; a real adapter must explicitly map them
to its provider API rather than using ambient Mac credentials. Dependency install
and build must be part of the reviewed real command path. Do not point at the
local verifier or template dry-run and call that stage deployment.

## Local verification and adaptation contract

Run `node --test live-proofs/tests/*.test.mjs` (Node 22+, Git; no dependencies,
provider calls or real secrets). Tests create all remote repositories and fixture
commands under their temporary directories inside this checkout, and remove them.
Separate reusable entrypoints are `validateSource()` (Git-only source validation),
`execute()` (proof/deploy/health), `makeReceipt()` (strict receipt construction),
and `persistToGit()` (Git transport). The last accepts a test remote only as a
programmatic argument; the production CLI exposes no remote/path/payload override.
Production CLIs are `validate-source.mjs`, `run.mjs`, and `persist.mjs`; workflow
environment variables document their exact inputs.

For each adopting repository, change policy repository/integration ref, workflow
envelope literals, required provider names and explicitly passed environment
variables together; keep the fixed evidence remote and task subtree. Add only
reviewed registry entries with immutable argv and real checks. Have the repository
owner specify stage commands and merge to its default branch. Platform uses main;
P1 owns its commands and merge, including fixed `stage`/`stage-train` target
choices and its upload → migrations gate → activate → Workflow registration and
readback helper. Do not substitute generic `pnpm deploy`; reserve named T-007
authenticated-session proofs for its reviewed registry. Site needs its own stage
Worker and real commands.
HappyToHelp waits for T-020 and Q-0-0009's default `release/0.2.x`; change the exact
integration ref everywhere. Lamp waits for P5's safe-trigger rule before any PR.
T-025 copies the reviewed reference, adapting these explicit seams. Review every
workflow/registry change for exfiltration before merge. Owner Environment setup,
secret entry, actual GitHub dispatch and passing remote receipt remain separate
acceptance inputs; these local tests make none of those live claims.
