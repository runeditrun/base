# Seed foundations

To bring existing data into a seed, sign in as the owner and use its import
screen. First step: open this path on the destination app:

```text
/app/import
```

Upload a supported source export, review the plan and its differences, then
approve that exact plan to apply it. Reconcile the result against native data;
use Undo from the same history when needed. Base's reference accepts people JSON
here, not installation `.rer` archives. Editions adopt this same door
with their own supported readers and native adapters.

Run Edit Run can manage independently authored software. This Base repository,
its maintained seed stack, onboarding, launcher and exporter are optional
convenience paths, not admission requirements for management. A product may
arrive with its own source, runtime, provider targets and operating commands;
the owner and agent declare the supported effects and verify the guarantees
that apply to that product.

Run Edit Run must earn its place when an owner's agent can build and maintain
software at near-zero development cost. The base reduces the total effort of
reaching and keeping the owner's desired product: refined behaviour, useful
reuse, straightforward deployment, and updates that preserve intent.

Verification (`verify` and `verify:*`) and release source commands wait before
starting a command when the machine's 1-minute load exceeds the existing job
queue `RER_JOBS_LOAD_THRESHOLD` (or `loadThreshold` in its config file). Original
CI callers and descendants sharing a live queue membership use the same load
admission without acquiring another slot. The wait is asynchronous and
cancellable; command-store cancellation and SIGINT/SIGTERM stop the wait before
a child starts. Normal queue admission retains its operational maximum wait.
Running units finish uninterrupted, with their existing deadlines and thresholds.
`VERIFY_STAGE ... seconds` measures wall duration including command-admission waits; it is not an enforced case deadline.
Fleet supervisors must replace external SIGSTOP/SIGCONT suspension with this
cooperative admission at command boundaries. The observed signal suspension was
external to Base; this mechanism does not guarantee arbitrary signal pauses are
safe, nor does it insert load waits into server spawn or readiness probes.

The maintained path is a complete edition with tested source selections, UI,
infrastructure, commands and guarantees. It should save implementation and
adaptation time. Base and headless families supply reusable source; shared
implementations may be substantial and modules may live in an edition, family,
Base or an independent repository. Placement is a maintenance choice.

Lily, Orbit, Lamp, Ferry, Beacon and HappyToHelp own their complete source,
component graph, integration and releases in their edition repositories.
First-party authors, owner forks and community publishers use the same
[edition authoring protocol](edition-authoring/README.md). Keep each edition's
source and release ownership explicit; do not regenerate an owner's existing
product from shared authoring input.

Owners can edit any source, core schema, UI, framework or infrastructure. Hooks
and configuration are conveniences. Their agents choose how to adopt, adapt or
rewrite upstream improvements while preserving owner requirements and applied
migration history. Useful edition discoveries should flow back into shared
implementations and tests, then be verified in other editions that adopt them.

- [Author instructions](AGENTS.md)
- [TanStack Start migration recipe](TANSTACK-START-MIGRATION.md)
- [Runnable reference](default-seed/README.md)
- [Start a family from committed Base source](foundation/README.md)
- [Standalone, agent-assisted onboarding](onboarding/README.md)
- [Start setup without a prior clone or fork](launcher/README.md)
- [Edition command and prerequisite inspection](operations/README.md)
- [First-release acceptance guidance](export/FIRST-RELEASE-ACCEPTANCE.md)
- [Committed edition assembly and commands](composition/README.md)
- [Canonical edition publication](authoring/README.md)
- [Shared SendGrid transport](modules/sendgrid-email/README.md)
- [Machine-wide heavy-job queue](modules/job-queue/README.md)
- [Source boundary checker](modules/boundary-checker/README.md)

- [Portable installation data](modules/portability/README.md)
- [Local browser review harness](modules/review-harness/README.md)
- [Reusable import validation and runtime](modules/import-kit/README.md)

New family work starts with `pnpm foundation --base-repo /path/to/base --ref <commit>
--output /tmp/new-family --family <family> --edition <edition> --repository <owner/repo>`.
It creates a minimal technical foundation, with pinned source provenance, that
uses the ordinary committed edition exporter. It is a buildable starting point;
the edition's useful product purpose, interface and guarantees still need to be
implemented. Existing editions retain their own Worker wiring until a shared
implementation fits their tested behaviour.

This repository contains an optional reference runtime, shared source and document templates,
manifest/release schemas, edition-owned authoring tools and the family exporter.
The foundation command creates a family authoring tree; it does not convert an
existing edition. See [the exporter guide](composition/README.md) for its exact
committed-input workflow. The Verify workflow also runs `pnpm typecheck:modules`
with strict unused-local, unused-parameter and switch-fallthrough checks over
all reusable module TypeScript, excluding Base's tests and proof programs.
The egress Worker uses its own Worker-only type environment in that same step.
`pnpm verify` checks schemas, source
integrity, export safety, deployment helpers, foundation assembly, operation
inspection and the runtime reference. These checks do not certify every edition's
product contract or deployment.

On a shared runner, `RER_VERIFY_WORKERS=1 pnpm verify` limits this verification job to one stage at a time. The optional limit must be a positive integer; invalid values fail before any stage starts. Values above the automatically calculated concurrency are capped at that default (at most four stages). Unset it to keep automatic concurrency. This runs all the same stages and retains their load and disk guards; it does not waive CI checks or limit other jobs on the machine.

Default-seed and exported foundation typechecks in `verify` use checkout-local, gitignored `.cache/typecheck.tsbuildinfo` in each package; deleting it forces a full check, while `build` still builds the real Worker and assets.

## Run the default reference locally

Install the `rer` command once with the installer script on the RER site
(`curl -fsSL https://runeditrun.com/install.sh | sh`, which brings its own Node
when there is none), or with `npx -y @runeditrun/rer cli install` when Node 22
or later is on PATH. Activate it in the current
shell with `export PATH="$HOME/.local/bin:$PATH"`. From the Base root, one
command launches the maintained reference seed: it installs dependencies, sets
up a local owner on a free port, starts the app and prints `RER_READY` and a
sign-in link:

```sh
rer dev --cwd default-seed
```

To install it for a real owner, run the verbs yourself in the seed:

```sh
cd default-seed
rer install
rer setup
rer dev
```

`rer` runs each verb with the rer version the seed pins: its `@runeditrun/rer`
devDependency in package mode, else its vendored `scripts/rer.mjs`.

Commands that run project work select the exact Node version declared by the
project. They use an exact matching installed runtime or a checksum-verified
copy cached at `~/.rer/node/node-vVERSION-PLATFORM-ARCH/`; when needed on
supported platforms, the runner retrieves the official Node release and checks
its SHA-256 against `SHASUMS256.txt`. It does not change global Node installations. Set
`RER_NODE_AUTO=0` to disable automatic selection. If selection is disabled or
acquisition fails, the command reports a repair invocation in this form:
`npm exec --yes --package=node@VERSION -- node SCRIPT VERB --cwd PROJECT`.
Help, check, describe, doctor and stop do not select or acquire Node.

After `RER_READY`, `dev` prints `RER_SIGNED_IN EMAIL` and `RER_OPEN URL`.
Open that URL on this computer: the app opens signed in as the owner and
finishes first-run setup at `/setup`. Treat the line as a credential.
`dev --as PERSONA` starts as a persona or signed out. Legacy `dev --login`
uses the same automatic sign-in. Until first-run completion is stored durably,
app routes return the signed-in owner to `/setup`; a signed-out owner returns
there after signing in. Once setup is complete, `/setup` opens the app or settings.

In dev and demo, invited people choose **Sign in as <name>** in operator access
or at `/signin` to open `/app` with their assigned role. A fresh local browser
profile opens `RER_OPEN` first for the checkout's key cookie. Mail is silently
suppressed. `rer dev --as person@example.com` also opens an invited or active
person's account through the same one-click path.

The saved local port is used; a first setup saves the first free port from 8787. Explicit ports must be decimal
integers from 1 to 65535 and free; only `127.0.0.1`, `localhost` and `::1` are
allowed. Startup reports a conflict instead of drifting to another port. Dev
applies the selected host and port to the listener and runtime bindings;
readiness is bounded and failure stops the owned processes. A setup rerun for
the saved owner and origin keeps existing data and exact private settings. If non-interactive setup exits 3, its error names the missing
manifest fields; a private mode-0600 `--answers` file is a JSON object keyed by
those names, for example `{"OWNER_EMAIL":"owner@example.com"}`. Keep secrets
in their declared private inputs, not command arguments. Follow the recovery
instruction for an identity conflict, and export data before a confirmed reset
if it should be restored.

The public runner also exposes these operations:

| Operation | Command |
| --- | --- |
| Verify | `rer verify` |
| Reset local state | `rer reset --yes --non-interactive` |
| Back up this installation | `rer export --output exports/installation.rer` |
| Restore this installation into an empty destination | `rer import --input exports/installation.rer --yes --non-interactive` |
| Validate a deploy and target secrets | `rer deploy --dry-run` |
| Inspect supported commands and effects | `rer describe` |

Review the inventory before `rer reset --yes`. The archive commands above are
how to back up and restore this installation, separate from bringing records
in through the reviewed import door. Preserve a backup before a reset if domain
data should be restored; archive restore requires an empty destination and has
no door plan or Undo. An application dry run reads target secret bindings with
Cloudflare credentials and makes no provider writes. See
[run it on your computer](export/RUN-LOCALLY.md) for transfer and recovery
steps, bounded local ports, queued-work progress and the runnable queue-status
command. Bounded waits immediately explain the reason and numeric one-based
queue position and refresh about every 15 seconds; after entering
`default-seed`, inspect the live queue with
`node scripts/base-cli/modules/job-queue/cli.mjs status`.

## Shared setup and authoring

Every first-party seed uses the maintained `rer` command path.
`install` prepares locked dependencies; `setup` reads the single root
`rer-setup.json` manifest, validates answers and delegates real build,
migrations, owner and sign-in work to the seed's declared adapter. Owner choices
remain authoritative, private inputs stay out of command arguments and logs, and
local dev opens automatically through `RER_OPEN`. HappyToHelp and Slate
retain their approved auth overrides. The [local operations guide](export/RUN-LOCALLY.md)
and [command contract](export/SEED-COMMAND-CONTRACT.md) define the current
commands, flags, state and safety requirements. Every seed has two homepages:
the installed Lobby and the static run site; the
[seed adoption note](export/HOMEPAGE-VARIANTS.md) says what each seed changes.

Authoring 1.1.0 supplies changed-input diagnostics, verified baseline extraction,
mapped incoming-source comparison and portable source-release receipts. See
[the command guide](edition-authoring/README.md). The selected shared
[owner migration mechanism](deployment/OWNER-MIGRATIONS.md) powers Lily and Lamp
while each edition retains its SQL directory and migration ledger. The
[SendGrid module](modules/sendgrid-email/README.md) exposes the actual wire
serializer and nullable provider receipt, with uncertain outcomes kept explicit.

## Public commands

The shared `rer` dispatcher provides install, setup, dev, preview, build, verify, reset, deploy, export, import, doctor, describe and check; release keeps its existing producer and flags. This maintained path is required for every first-party seed. See [run it on your computer](export/RUN-LOCALLY.md) for exact flags, Node 22.23.4/pnpm 10.34.7 pins, readiness/sign-in lines, JSON, exits and the independent-project boundary. Local transfer covers declared supported resources; remote transfer requires complete adapter coverage. [CLI sources and export inventory](cli/README.md) documents the one runner and portable source boundary.

From `default-seed` or a composed first-party edition, use
`rer preview` for fixed production output or
`rer dev` for live HMR.
In a terminal the first invocation stays in the foreground (without one,
`rer dev` returns once the app is ready); compatible repeats verify and
reuse the running server, print readiness and exit. Stop with
`rer preview --stop` or `rer dev --stop`
before build, verification, reset or data transfer. Both retain the owner
and canonical local state; the default idle timeout is 12 hours and
the combined machine cap is 10. Bounded preparation uses the shared heavy-job
queue. See the exported RUN-LOCALLY guide for timeout, reuse, capacity, sign-in
and CI policy.
