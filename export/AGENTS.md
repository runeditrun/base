# Agent instructions

## Launch for review

When asked to launch, run or review this app, run this from the checkout root
and nothing else:

```sh
rer dev
```

- It installs and sets up a fresh checkout by itself and prints progress; a
  first launch can take several minutes. Give the shell tool at least 10
  minutes. If the tool times out, run the same `rer dev` again: it resumes.
- Never run install, setup, reset or deploy for this, and never ask for an
  email, port, password or answers file.
- Give the owner the `RER_READY` address and the `RER_OPEN` link, and ask
  nothing. `RER_OPEN` is a credential: share it only with the owner, in this
  chat. A seed without dev identity prints `RER_SIGN_IN` (its local outbox)
  instead.
- Stop the app with `rer dev --stop`. If a start is refused, the message names
  the cause and the next command: run that command.

Without `rer` on PATH, install it once with `npx -y @runeditrun/rer cli install`
or the installer script: `curl -fsSL https://runeditrun.com/install.sh | sh`.
For the current shell, run `export PATH="$HOME/.local/bin:$PATH"` after installing.

## Run it locally

Base and its maintained seed stack are optional ways to build and operate a
product; every first-party seed uses the RER command path shown here.
These instructions describe that path in a composed, runnable edition. Family
authoring input becomes runnable only after edition composition. Independently
authored projects may keep their own supported operations and integration.
`rer` runs each verb with the rer version this checkout pins.

To install for a real owner instead of a review launch, run the verbs yourself:

```sh
rer install
rer setup --owner-email you@example.com
rer dev
```

Commands that run project work select the exact Node version declared by the
project. They use an exact matching installed runtime or a checksum-verified
copy cached at `~/.rer/node/node-vVERSION-PLATFORM-ARCH/`; when needed on
supported platforms, the runner downloads the official Node release and checks
its SHA-256 against `SHASUMS256.txt`. Set `RER_NODE_AUTO=0` to disable automatic
selection. If selection is disabled or acquisition fails, the runner reports an
explicit repair command in this form:
`npm exec --yes --package=node@VERSION -- node SCRIPT VERB --cwd PROJECT`.

Use the setup prompt instead of `--owner-email` when entering the real owner
mailbox. With dev identity, `dev` prints `RER_OPEN`: open it on this computer
and the app opens signed in as the owner at `/setup` (`dev --as PERSONA` and
`dev --login` change that; treat the line as a credential). Otherwise open the
`/__dev/outbox` URL printed by `dev`, choose the newest ordinary sign-in message
and follow its link to finish setup at `/setup`. Until
first-run completion is stored durably, app routes return the signed-in owner
to `/setup`; a signed-out owner returns there after signing in. Once complete,
`/setup` opens the app or its settings. The local outbox sends no external
email. Stop `dev` with `rer dev --stop` or Ctrl-C, and stop `preview` with
`rer preview --stop` before build or verification.

Queue waits report immediately with a reason and numeric one-based position,
then refresh about every 15 seconds while waiting. Package mode has no queue
status verb. A vendored seed can inspect the live queue from its runnable root
with `node scripts/base-cli/modules/job-queue/cli.mjs status`.

```sh
rer verify
rer reset --yes
rer export --output exports/installation.rer
rer import --input exports/installation.rer --yes
rer deploy
rer describe
```

Reset is destructive local cleanup. Import needs an empty destination and
explicit confirmation. See `RUN-LOCALLY.md` for flags, state and deployment
requirements.

## Two homepages

An installed instance serves the Lobby at `/` (Sign in, or Finish setup before
the owner's claim) and answers `GET /setup/state`; the seed's run site
(`run-<seed>.com`) is its approved homepage with a **Run <Seed>** action, `/run`
and docs, built by `rer build --site`, previewed as `RER_SITE` by `rer dev` and
published by `rer deploy --site`. `HOMEPAGE-VARIANTS.md` says what each seed
changes; never redraw an owner-approved homepage for it.

## Base and the independent-project boundary

Base and its maintained seed stack are optional ways to create and operate a
product. Independently authored projects keep their own source, runtime, tools,
installer and provider choices. RER can manage them through their declared
operations; these instructions do not imply universal hosted compatibility.

Base provides reusable source, a runnable reference and an edition-authoring
path. A family holds source that its editions select. An edition owns the full
application experience and integrates the source it chooses. Composition makes
a complete runnable edition from authoring input; use the RER command path only
from that runnable checkout. Keep products editable and independent of
authoring repositories after composition.

Read the repository's `README.md`, `CONTRACT.md` and `HANDOVER.md`, relevant edition
briefs, and actual package and assembly configuration. Use the schema implemented
by the tooling you are running. Product manifests and assembly descriptions have
different responsibilities; do not invent accepted fields in either.

## Work from the product

Decide the intended journeys and interface first, then build the domain and
modules needed to deliver that complete product. Preserve recorded requirements,
including requirements intended for another edition. A family-wide incumbent
superset is not a prerequisite for shipping a useful edition.

Optimise total work, cost, elapsed time and owner attention to reach and keep the
accepted product as capable agent development approaches zero cost. Trust the
owner's agent to implement and maintain complex changes. Diagnose instructions,
context, schemas, normalisation, model choice and tools before imposing capability
limits. Fix the cause of an inadequate LLM result; never hide it with a semantic
fallback. Bound retries to transient transport failures.

No mock application code or production fallbacks. Mocks belong only in tests.
Remove deprecated code, keep files small and split by responsibility, and add
abstractions only for concrete needs. A compatibility shim for a released public
extension contract must name its removal version. Parallelise independent work;
migrations and ordered writes are not independent.

## Source and ownership

Base and families maintain reusable implementations; modules may live in an
edition, family, Base or independent repository. Choose placement for useful
maintenance, and keep the edition responsible for its complete experience.
Follow the repository's declared assembly mappings rather than maintaining another
copy of generated application source. Assembly must record its inputs, produce a
complete independent repository, and keep secrets and local resource IDs out of
the output. Do not regenerate over an owner's existing fork.

Owners may edit every installed source file, including base and domain core.
Owner-local conventions such as `src/ext/`, `.seed/`, `migrations/ext/` and
`tests/local/` can simplify common changes. Preserve these paths and customisations elsewhere when integrating updates.
These conventions never restrict the owner to them.
Published extension APIs may have supported import boundaries; coherent owner
changes can adapt the architecture itself.

## Stack and runtime

For this optional authoring path, the maintained default uses TypeScript, Hono and Hono RPC, Vite + React + TanStack Start, TanStack Router,
shadcn/ui + Tailwind, and Drizzle on D1. Owners may adapt this stack and infrastructure while verifying
applicable product guarantees. One Cloudflare Worker serves documents,
HTTP surfaces and event handlers; additional Workers need a concrete reason.
Before migrating an existing app, follow the
[TanStack Start recipe](https://github.com/runeditrun/base/blob/main/TANSTACK-START-MIGRATION.md).

The standard URLs are `/` for the owner's public front door, `/app` for the
session-protected operator app, and `/signin`. Declare sessionless paths in
`seed.json → deploy.publicPaths`; `/` matches exactly. Start renders React
documents, using server-function-backed loaders for current data and prerendering
only deployment-invariant pages. Preserve contract-owned Hono surfaces, including
APIs, auth, webhooks, feeds, widgets and authoritative R2 pages; dispatch them
before Start without consuming its `/_serverFn/` transport.

Check native sessions before private document reads and within every private
server function. Keep server code and secrets out of browser bundles. Unknown
documents and missing assets return real 404s. Hydrated React navigation must
avoid new document requests. Preserve Queue, Cron and other Worker event exports.

Use R2, Queues, Cron, Workflows, Durable Objects and KV for demonstrated needs.
Handlers are stateless; memory and KV are caches, not authoritative data. Isolate
bindings and declared external services in platform adapters. Native session auth
is the default. Do not introduce a hosted service where owned primitives suffice.
No telemetry, phone-home or kill switch.

## Guarantees and data

`BASELINE.md` records shared security, privacy and operational requirements. It
remains editable: deliberate changes must identify affected clause IDs, preserve
recorded owner requirements, and document owner-authorized replacement guarantees
and tests, including changed security consequences. Shared domain guarantees
belong with their family or module. The
edition contract identifies selected capabilities and verifies their integrated
behaviour. An omitted capability is not promised or reported as verified.

Use stable clause IDs and tagged tests. Reserve `BASE-` for the baseline and never
reuse published IDs. Product supersession explicitly names the baseline ID and
has its own test. Deliberate changes to requirements need recorded owner authority
and appropriate replacement verification. Existing authorization is sufficient;
ordinary fixes that meet the requirements need no additional acknowledgement.
Use any override fields only where the edition actually implements them. Report satisfied,
intentionally overridden, broken and uncovered guarantees honestly, using the
reporting actually implemented. An untested clause is not release evidence.

Capabilities map to contract clauses in `seed.json`. Declare non-goals, externals,
configuration, public paths, supported extension IDs, limits and costs truthfully.
Distinguish estimates from measurements. Incumbent replacement claims require
research and importer clauses tested against real incumbent exports.

Routes validate inputs at trust boundaries and call services; services apply
product decisions and call repositories. Only repositories access the database.
Use semantic operations, idempotent queue and webhook handlers, and visible job
failure. Published extension IDs are versioned; changing their meaning requires
a new version and release entry. Add policies, events, slots or adapters where
they save real work, without quotas or mandatory extension machinery.

Preserve applied migration history. Core schema changes are normal: add suitable
forward migrations and verify transition and recovery for existing data.
Provision resources by deterministic name with find-or-create behaviour, generate
configuration, and retain installation values outside upstream source. Declare
required secrets and identify missing configuration without fabricating behaviour.

## Verification and distribution

Document the exact install, local run, verify, provision, deploy and data
export/import commands implemented by each edition. Use the declared
`rer setup` command to provision a first-party seed. Do not
promise deploy-on-push, PR previews, account-free provider
behaviour or sample-data loading unless those paths are implemented and checked.
Missing release capabilities belong in the handover.

Verify the assembled artifact, not just its input repositories: clean installation,
real local runtime, integrated journeys, applicable contracts and baseline tests,
migrations, build and the deployment path claimed for that release. Exercise data
export and restore before claiming portability. A preview proves only what ran
there; compilation or the base reference alone is not edition acceptance.

Record guarantee changes by ID, consumer guidance changes, extension changes,
migrations, breaking changes and verification evidence in `RELEASE.json` using
its actual schema. Update instructions describe what to preserve and check; the
owner's agent chooses merge, rebase, reapplication or rewriting. Prepare updates
away from the live installation, verify recorded intent, and never replace the
owner's fork with a fresh generated artifact.

Generate the edition's owner `AGENTS.md` from its actual purpose, paths, commands
and readiness. No author placeholders or fictional tooling may ship. Preserve
the author repositories, check the generated owner guide, refresh key screenshots,
and leave an accurate handover. Commit, publish and deploy within session authority.

Roll useful edition mechanisms and regression tests into maintained shared source
when they save work elsewhere. Verify adoption against each edition’s requirements;
a deep local variant can still adopt or adapt later upstream improvements.
