# Run it locally

Base's repository root is the authoring workspace, not a runnable edition. To
run the maintained reference, enter `default-seed`. A newly composed foundation
is runnable from its edition checkout; a family authoring folder is composition
input and must not be used as an application checkout.

From the Base repository root:

```sh
cd default-seed
node scripts/rer.mjs install
node scripts/rer.mjs setup --owner-email you@example.com
node scripts/rer.mjs dev
```

Commands that run project work select the exact Node version declared by the
project. They use an exact matching installed runtime or a checksum-verified
copy cached at `~/.rer/node/node-vVERSION-PLATFORM-ARCH/`; when needed on
supported platforms, the runner retrieves the official Node release and checks
its SHA-256 against `SHASUMS256.txt`. It does not change global Node installations.
Set `RER_NODE_AUTO=0` to disable automatic selection. If selection is disabled
or acquisition fails, the command reports a repair invocation in this form:
`npm exec --yes --package=node@VERSION -- node SCRIPT VERB --cwd PROJECT`.
Help, check, describe, doctor and stop do not select or acquire Node.

After `RER_READY`, `dev` prints `RER_SIGNED_IN EMAIL` and `RER_OPEN URL`.
Open that URL on this computer: the app opens signed in as the owner and
finishes first-run setup at `/setup`. Treat the line as a credential.
`dev --as PERSONA` starts as a persona or signed out. Legacy `dev --login`
uses the same automatic sign-in. Until first-run completion is stored durably, app routes send the signed-in owner to `/setup`;
signed-out visitors sign in and return there. Once complete, `/setup` opens the
app or settings. Development and demo mail is silently suppressed.

The saved local port is used; a first setup saves the first free port from 8787. Explicit ports are decimal
integers from 1 through 65535 and must be free; a busy requested port fails
instead of silently moving. Only `127.0.0.1`, `localhost` and `::1` are allowed.
Dev applies the selected host and port to both the listener and runtime bindings;
readiness is bounded and failure stops the owned processes.

Missing non-interactive setup answers exit 3 and name the manifest fields.
Read `rer-setup.json` and pass a private, mode-0600 JSON object keyed by those
names using `node scripts/rer.mjs setup --answers PATH --non-interactive`,
for example `{"OWNER_EMAIL":"owner@example.com"}`. Secret values stay in
private inputs and never go in command arguments. A setup rerun with the saved
owner and origin preserves existing owner/data and exact private settings.
Conflicting saved identity or origin reports an actionable recovery path.
Review reset's exact removal inventory before confirmation; export domain data
first if it should be restored, and import only into an empty destination.

Queue waits report immediately with a reason and numeric one-based position,
then refresh about every 15 seconds while waiting. From the runnable project
root, inspect the live queue with
`node scripts/base-cli/modules/job-queue/cli.mjs status`.

Use the setup prompt instead of `--owner-email` to enter the real owner
mailbox. Open the `RER_OPEN` URL printed by `dev` on this computer; the app opens
signed in as the owner, including with legacy `dev --login`. No external
email is sent in development or demo mode. Run the same
commands from a composed foundation edition's root.

Stop `dev` with `node scripts/rer.mjs dev --stop` or Ctrl-C, and stop
`preview` with `node scripts/rer.mjs preview --stop` before build or
verification.

```sh
node scripts/rer.mjs verify
node scripts/rer.mjs reset --yes
node scripts/rer.mjs export --output exports/installation.rer
node scripts/rer.mjs import --input exports/installation.rer --yes
node scripts/rer.mjs deploy
node scripts/rer.mjs describe
```

Reset removes declared local state and settings. Import requires an empty
destination and explicit confirmation. Local export/import covers the supported
resources; each first-party seed verifies an export/import/export round trip.
Remote transfer is available only where the adapter declares complete resource
support. `describe` reports the commands and flags implemented by the checkout.
See [RUN-LOCALLY.md](../export/RUN-LOCALLY.md) and
[SEED-COMMAND-CONTRACT.md](../export/SEED-COMMAND-CONTRACT.md) for the full
command and state contract.

## Start a future family from Base

This is an optional Base convenience path: a technical starting point, not a
catalogue edition or completed product. It carries the real TanStack
Start/Vite/React/Hono/Cloudflare stack, locked dependencies, a document, health
endpoint and real 404s. It includes minimal real owner/operator auth, D1 and
silent development mail suppression, with no precreated owner or speculative domain.
`default-seed/` remains the richer executable reference for native sessions,
direct private server functions, D1 SSR and Worker events.

RER can manage independently authored software without this foundation or the
Base seed stack. Products may choose another runtime or provider target; their
agents declare supported effects and verify the guarantees that apply. This
starting tree does not establish universal hosted compatibility.

From a Base revision containing the generator command:

```sh
node foundation/cli.mjs --base-repo /path/to/base --ref BASE_COMMIT --output /tmp/new-family --family example-family --edition example-edition --repository <owner>/<example-family>
```

The output must not exist. Template and runtime bytes come only from the explicit
committed Base revision, ignoring dirty source changes. `foundation.lock.json`
records that origin and SHA-256 hashes of generated/copied author files and the
runtime to be composed. Commit the new author repository, then use normal edition
assembly:

```sh
pnpm edition example-edition --family-repo /tmp/new-family --base-repo /path/to/base --output /tmp/new-edition --install --verify
```

`--repository` records the author family repository in `family.json`. The public
Run page uses the edition's `just-every/run-<edition>` repository convention,
with its clone command and folder generated from the edition name. The generated
setup manifest also uses the edition name for its title and `APP_NAME` default;
an owner's explicit setup answer still takes precedence.

The composition copies the pinned Base dispatcher into `src/base`; the exported
Worker needs no Base checkout. The author edition folder is composition input.
Its `core/`, `modules/` and `editions/` layout is the implemented authoring
layout, not a universal source-placement rule. Shared source may be substantial
and exported from any appropriate repository under the edition-owned protocol;
the edition owns integration. The initial manifest and contract are technical
examples, not claims of a useful finished product. Replace them with agreed
product scope and measured evidence as work proceeds.

The template declares D1 and real auth migrations. Local `setup` builds,
migrates and prepares the real first owner for automatic local sign-in.
`deploy --dry-run` validates and builds locally, then reads target secret bindings without provider writes; real deploy uses the owner-account kit, applies declared D1
migrations and checks health. Local checks do not establish hosted acceptance.

Fresh foundation generation assigns distinct migration ordinals, including
`0011_dependency_setup.sql`, `0012_dependency_approval.sql` and
`0013_erasure.sql`. This only defines the generated starting history; existing
owner and edition checkouts keep their already-applied migration names.

The default foundation leaves optional import-kit out because the module exposes
no single canonical complete D1 migration schema for generating a numbered
migration. Defer module selection until that schema API exists; a product
importer still needs its own authorized target adapter and product integration.

For private Start handlers, enforce native session authorization in every
server function, including direct transport calls; route guards alone are
insufficient. Use server-only modules and dynamic imports inside
`createServerFn` handlers so secrets never enter client bundles. Keep Queue/Cron
handlers and named Worker exports in `src/server.ts`; the dispatcher only
selects HTTP ownership and does not authenticate or catch failures.

The template has real minimal owner/auth/mail/D1 behavior and no product domain
or background jobs. Preserve applied migration history and owner requirements.
Owners may change source, schema, UI, framework, infrastructure and integration
method. Place reusable code where it can be maintained and keep the complete
product experience edition-owned.

The template pins Node 22.20.0 and pnpm 10.12.4. Its package scripts route the
public operations through `node scripts/rer.mjs`; internal targets have separate
names to prevent command recursion. `OPERATIONS.json` declares the first-party
profile and command effects. `node scripts/rer.mjs describe` inspects the
descriptor before dependencies are installed. The first-party structural check
is `node scripts/rer.mjs check --profile first-party`. Neither proves app
acceptance or remote health.

Local durable state lives under `.wrangler/state`; generated settings and
installer bookkeeping remain private and outside source control. Local export
and restore use the shared portability module and explicitly exclude owner/auth,
outbox, private settings and transient state. Remote transfers require full
resource coverage. Owner-account deployment requires private credentials and a
real verified mail provider configuration; no local check proves provider
delivery.

Read [the exported local operations guide](../export/RUN-LOCALLY.md),
[the command contract](../export/SEED-COMMAND-CONTRACT.md),
[the first-release acceptance guide](../export/FIRST-RELEASE-ACCEPTANCE.md),
and the composition and edition-authoring guides before changing their paths.
