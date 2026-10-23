# Adopt the seed Verify workflow

New foundation compositions and standalone reference exports receive
`.github/workflows/verify.yml` and `.github/workflows/verify-nightly.yml` from
Base's matching `export/` templates. They also receive the seed's
`verification.json`, `scripts/verify-ci.mjs` and `scripts/verify-app.mjs`.
Existing editions own their workflows: copy or merge these files, preserving
their product-specific checks and supported Node and package-manager versions.

The two workflows use the same declared shards:

| Workflow | Triggers | Coverage |
| --- | --- | --- |
| Verify | Pushes to every branch, pull requests and manual dispatch | `push` shards |
| Nightly journeys | Nightly schedule, `v*` release-tag pushes and manual dispatch | Both `push` and `nightly` shards |

Release tags use Nightly journeys' full coverage. The nightly workflow calls Verify with the full tier. Verify plans its matrix
from `verification.json`, then runs the shards in parallel on Ubuntu 24.04.
Push shards have a 12-minute timeout; the nightly workflow allows longer for the
full installation journeys. The final `verify` aggregate remains the stable
required check as shard names change. It succeeds only when planning and every
selected shard succeed, or when a successful plan explicitly authorizes reusing
exact-SHA branch verification and the shards are skipped. A failed or cancelled
shard, or an unauthorized skip, cannot produce a green aggregate.

Shard jobs restore the pnpm dependency store and, for browser shards, the
Chromium cache. They install frozen dependencies and run the seed's `deps`
script to prepare its declared RER tools. Browser shards install Chromium and
its system dependencies; other shards do not need a browser installation.
Caches reduce setup time without replacing the frozen install or verification.
These package scripts work with both contained and packaged RER.

The template's application Node version remains 22.20.0 and pnpm remains
10.12.4. Preserve the seed's exact package pins and lockfile. The pinned checkout
and setup-node v7 actions run their own code on Node 24; action runtime upgrades
do not change application engines.

## Declare and run shards

`verification.json` has two arrays, `push` and `nightly`. Each entry declares:

- `name`: a unique shard name across both arrays.
- `browser`: a boolean saying whether the job needs Chromium.
- `hosted`: a boolean selecting the RER hosted-output verification path.
- `commands`: a nonempty array of shell commands, run in order from the seed
  checkout root. A failure stops the shard and fails the job.

For example, this fragment describes a typecheck shard using the reference
seed's existing package scripts:

```json
{
  "name": "typecheck",
  "browser": false,
  "hosted": false,
  "commands": ["pnpm typecheck", "pnpm test:typecheck"]
}
```

Inspect the actual checkout's CI selections with:

```sh
node scripts/verify-ci.mjs --matrix push
node scripts/verify-ci.mjs --matrix all
```

CI runs `node scripts/verify-ci.mjs NAME`, where `NAME` is an entry's exact
declared name. The helper sets `SEED_VERIFY_SHARD` and runs `pnpm verify` for
`hosted: true`, or `pnpm verify:app` for `hosted: false`. The hosted path retains
RER's hosted-output and hydration checks after the selected commands build the production Worker.
The `verify:app` package script must invoke `node scripts/verify-app.mjs`; that
runner reads `SEED_VERIFY_SHARD` and executes the selected entry's commands.
Missing, unknown or duplicate shard declarations fail explicitly. There is no
catch-all successful skip for an unrecognised selection.

With no `SEED_VERIFY_SHARD`, `verify:app` executes every command in both arrays.
The normal local `rer verify` therefore keeps full verification, including the
nightly journeys. Stop managed dev and preview servers first, as described in
`RUN-LOCALLY.md`. Moving work to `nightly` changes push CI scheduling; it does
not remove it from full local or release verification.

## Keep coverage while splitting work

The reference seed's push shards cover typechecking, local setup, the emitted
Worker and browser checks, and the remaining local-journey files. Split browser
journeys by test file so each job has a bounded, understandable unit of work.
The reference seed explicitly places these complete slow journey files in
`nightly`:

- `tests/local-journey/installer.test.mjs`
- `tests/local-journey/installer-browser.test.mjs`
- `tests/local-journey/journey.test.mjs` (the README fresh-copy journey)

An edition declares its own real commands and paths in the manifest. When
moving a slow installer or README journey, move the whole file to the nightly
list and retain its coverage. Account for every existing verification command
when adopting the split. Do not drop tests, add retries, or silently skip work
to fit the push timeout.

## Preserve edition source locks

Edition-owned seeds retain `edition.json`, `sources.lock.json`,
`.edition/sources/` and their pinned `scripts/edition-authoring/` tools. The
workflow runs `node scripts/edition-authoring/cli.mjs check` before installing
dependencies whenever either edition manifest or source lock is present. A
missing counterpart or tool fails the job. Intentional source or workflow edits
require staging new files, inspecting `changes`, and running `lock` locally;
commit the resulting lock and retained snapshots. CI never rewrites the lock.

Technical foundation/reference exports have composition or reference provenance
instead of an edition-owned source lock, so this authoring check becomes active
when they adopt the edition-owned protocol. Read Base's
`edition-authoring/README.md` for that adoption; the workflow does not convert an
existing product or create a source recipe.

The action pins were checked against the official
[checkout v7.0.1 release](https://github.com/actions/checkout/releases/tag/v7.0.1)
and [setup-node v7.1.0 release](https://github.com/actions/setup-node/releases/tag/v7.1.0).
Their pinned `action.yml` files declare `runs.using: node24`.

## Cancel superseded runs and reuse branch verification

Adopt this with the next rer patch after 0.2.79 (target **0.2.80**, assigned by
the Base release owner); no seed needs to wait for another seed. Preserve the
seed's checks, triggers, pins, matrices and stable required-check names. Heavy
seeds **cradle, dial, nook, pencil, slate and coaster** adopt first.

Replace each existing concurrency block with this entire block, or insert it
before `jobs` if absent:

```yaml
concurrency:
  group: seed-verify-${{ github.workflow }}-${{ github.ref == 'refs/heads/main' && github.run_id || github.event.pull_request.number || github.ref }}
  cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}
```

| Existing variant | Adoption |
| --- | --- |
| No concurrency block (31 seeds in the census) | Insert the block above. |
| Pencil's group includes the SHA | Replace the whole block; remove the SHA so newer commits share their branch's group. |
| HappyToHelp's never-cancel block | Replace the whole block; non-main runs now cancel superseded work. |

Main gets a unique run ID: even a pending main run cannot be replaced. The
conditional cancellation alone would not protect pending runs with a shared
key. Base's own workflow retains its equivalent `verify-` group.

Copy `export/verify-ci.mjs` from the accepted Base release to the seed's
`scripts/verify-ci.mjs`. It runs `--main-skip` without reading a shard manifest,
so it also works in seeds with custom shard commands. Keep `verify-app.mjs`
when the seed uses the template's matrix/shard command modes.

### Seeds with a plan job

Apply this diff to the current template; use the seed's existing matrix step ID
if it differs. Keep existing job permissions and add `actions: read` only here.

```diff
 jobs:
   plan:
+    permissions:
+      contents: read
+      actions: read
     outputs:
       matrix: ${{ steps.plan.outputs.matrix }}
+      skip: ${{ steps.duplicate.outputs.skip }}
     steps:
       # Existing checkout stays here.
+      - name: Reuse successful branch verification on main
+        id: duplicate
+        if: ${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}
+        env:
+          GITHUB_TOKEN: ${{ github.token }}
+        run: node scripts/verify-ci.mjs --main-skip
       # Existing matrix/planning steps stay here.
   shards:
     needs: plan
+    if: ${{ needs.plan.outputs.skip != 'true' }}
   verify:
     needs: [plan, shards]
     if: ${{ always() }}
     steps:
       - name: Require every shard
         env:
           PLAN: ${{ needs.plan.result }}
           SHARDS: ${{ needs.shards.result }}
+          SKIP: ${{ needs.plan.outputs.skip }}
-        run: test "$PLAN" = success && test "$SHARDS" = success
+        run: |
+          test "$PLAN" = success && {
+            test "$SHARDS" = success || { test "$SKIP" = true && test "$SHARDS" = skipped; }
+          }
```

Apply the shard condition to **every** verification job, including separately
named browser/OS jobs. Retain any existing condition with `&&`. For several
shard jobs, keep them all in the final aggregate's `needs`, and apply the same
success-or-authorized-skipped rule to each result individually.

### Six heavy seeds without a plan job

Add the following main-only gate. The checkout pin below is the seed template's
current pin; retain the seed's supported checkout pin if it differs.

```yaml
  main-verify:
    if: ${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}
    runs-on: ubuntu-24.04
    timeout-minutes: 1
    permissions:
      contents: read
      actions: read
    outputs:
      skip: ${{ steps.duplicate.outputs.skip }}
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
        with:
          persist-credentials: false
      - id: duplicate
        env:
          GITHUB_TOKEN: ${{ github.token }}
        run: node scripts/verify-ci.mjs --main-skip
```

For **each existing verification job** (here `shards`), apply:

```diff
   shards:
+    needs: main-verify
+    if: ${{ !cancelled() && (needs.main-verify.result == 'skipped' || needs.main-verify.result == 'success') && needs.main-verify.outputs.skip != 'true' }}
```

Append `main-verify` to existing `needs` arrays rather than replacing dependencies.
If there are other dependencies/conditions, also preserve their success checks:
`!cancelled()` bypasses GitHub's implicit `success()`. The explicit `skipped`
case above lets branch/PR/dispatch/schedule jobs run when their main-only gate
is skipped. A plain `needs.main-verify.outputs.skip != 'true'` would propagate
that gate's skipped state and incorrectly skip branch verification.

If the seed has a final required aggregate, preserve its name and use this
body (replace `shards` by each real job ID, listing every one in `needs`):

```yaml
  verify:
    needs: [main-verify, shards]
    if: ${{ always() }}
    runs-on: ubuntu-24.04
    timeout-minutes: 1
    steps:
      - name: Require every shard or the authorized main skip
        env:
          GATE: ${{ needs.main-verify.result }}
          SKIP: ${{ needs.main-verify.outputs.skip }}
          SHARDS: ${{ needs.shards.result }}
        run: |
          { test "$GATE" = success || test "$GATE" = skipped; } && {
            test "$SHARDS" = success || {
              test "$GATE" = success && test "$SKIP" = true && test "$SHARDS" = skipped
            }
          }
```

For several shard jobs, repeat the inner success-or-authorized-skipped check
for each result with `&&`. Do not accept `failure` or `cancelled`, and do not
accept a skipped shard solely because the gate was skipped on another event.
Seeds whose shard checks are themselves required retain those names; GitHub
reports conditional skips as successful checks.

### Lookup, required checks and adoption checks

Only a main **push** performs the lookup. It obtains the current run's numeric
workflow/repository identity and lists that workflow's runs for `GITHUB_SHA`,
100 per page (up to GitHub's 1,000-result filtered-search limit). A completed,
successful `push`, `pull_request` or `workflow_dispatch` on another branch in
the same repository authorizes the skip. The workflow ID, name, repository ID,
repository name, head repository and SHA must all match. A successful main run
alone never qualifies. PR evidence matches the API's exact `head_sha`; no base
or synthetic merge SHA is substituted.

An API failure, 403/429/500, timeout, malformed response, incomplete pagination,
or changing result count returns `skip=false`; verification runs normally.
No API request occurs for a non-main push, PR, dispatch or schedule. A missing
or empty `skip` output also runs shards normally. The API permission is scoped
to the plan/gate job; checkout still needs `contents: read`.

Dry reasoning of the template's aggregate: job-level shard `if` is evaluated
before matrix expansion. A successful plan with `skip=true` skips the matrix;
the final `always()` job still runs because it directly needs both plan and
shards. It accepts `PLAN=success, SKIP=true, SHARDS=skipped`, or an ordinary
successful plan and successful shards. A failed/cancelled/skipped plan fails;
a failed/cancelled shard fails even with `SKIP=true`; a skipped shard with an
empty/false skip fails. If the lookup fails, the plan succeeds with `skip=false`
and the original matrix runs. Non-main events omit the lookup step, leaving
an empty skip output and normal verification. Base's separate macOS job also
depends on the plan and uses the shard condition.

A short-circuited main run has a successful plan/gate, grey **skipped** shard
jobs (GitHub's message is “This check was skipped”), and a green successful
final `verify` check/workflow. GitHub treats conditionally skipped jobs as
successful for required checks. The lane count rule accepts the exact-SHA green
branch Verify plus Run site on main where present; the duplicate main run is
not the source of new test evidence.

After adoption, make two quick pushes to one candidate branch: the first
Verify is cancelled and the second runs. Fast-forward its already green SHA to
main: after runner admission, only the light plan/gate and aggregate execute,
with shards skipped; execution finishes in seconds (queue time remains).
An unverified main SHA must run every shard. Confirm a manual dispatch and a
branch push still run their normal shards. Keep normal required-check rules.

For release adoption, update the installed CLI with `rer update --version
0.2.80` once that release exists; package-mode seeds update their exact pin with
`pnpm add -D -E @runeditrun/rer@0.2.80`. This checkout has **no bare `rer refresh`
command**, and an npm update alone does not copy seed-owned workflow files.
For files already tracked in `base-copies.json`, the supported source refresh is:

```sh
node scripts/edition-authoring/cli.mjs refresh-base <release-commit> --base <base-checkout>
```

Copy/merge the workflow and helper above in that same adoption commit; preserve
product adaptations and update its existing copy/source-lock records. New
foundation compositions and standalone reference exports automatically take
`export/verify.yml` and the maintained helper copies. The Base release owner
ships these source templates with the next rer release; this change does not
bump, publish or release rer.

Official semantics: [workflow runs API](https://docs.github.com/en/rest/actions/workflow-runs#list-workflow-runs-for-a-workflow),
[concurrency and pending replacement](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency),
[skipped required jobs](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-jobs-with-conditions),
and [job dependency conditions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idneeds).
