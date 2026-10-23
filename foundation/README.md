# Run it locally

For a product that offers data move-in, sign in as the owner and use its import
screen. First step: open this path on the destination app:

```text
/app/import
```

Upload a supported source export, review the plan and its differences, then
approve that exact plan to apply it. Reconcile the result against native data;
use Undo from the same history when needed. Base's reference accepts people JSON
here, not installation `.rer` archives. Editions adopt this same door
with their own supported readers and native adapters.

This technical foundation has no product import screen or product data yet.
When adding data move-in, mount the shared door and build `/app/import` before
publishing that workflow; do not add a separate importer. Follow Base's
[door adoption guide](https://github.com/runeditrun/base/blob/main/modules/import-kit/src/door/ADOPTING.md).

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
Review reset's exact removal inventory before confirmation. If data must be
kept, back up this installation first; restore that archive
only into an empty destination.

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
node scripts/rer.mjs deploy
node scripts/rer.mjs describe
```

To back up and restore this installation, use:

```sh
node scripts/rer.mjs export --output exports/installation.rer
node scripts/rer.mjs import --input exports/installation.rer --yes
```

These commands save and restore a supported installation archive. They do not
use the reviewed import door or provide its plan, reconciliation and Undo.
Archive restore requires an empty destination and explicit confirmation. Use
the signed-in import door when bringing records in.

Reset removes declared local state and settings. Archive restore requires an empty
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

The technical foundation leaves import-kit out until the product has native
records to map. Add data move-in through the shared import door using
[the adoption guide](../modules/import-kit/src/door/ADOPTING.md): it lists the
ordered schemas and door migrations. Supply the product's authorized native
target adapter, supported source readers and signed-in `/app/import` screen;
keep upload, plan, reviewed apply, reconciliation, history and Undo on that one
pipeline.

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

## Published migrations

The initial owner schema is a frozen numbered file in
`foundation/template/migrations/core/0001_owner.sql`. The initializer copies this
template into the family; it does not map the evolving operator-auth schema
draft onto an immutable migration. Keep that file after publishing or applying
it. Add each later schema delta as a NEW numbered migration.

`pnpm verify:foundation` starts with `node scripts/check-migrations.mjs`. This
Base-only check compares every existing file under `default-seed/migrations/`
and `foundation/template/migrations/` byte for byte against the highest stable
`rer-v*` release advertised by `origin` and HEAD's first parent. CI also compares
the GitHub push event's `before` commit or pull request base, so a multi-commit
push cannot rewrite numbered migrations published on plain main between releases.

The release comparison also freezes the initializer's actual migration origins
from both released and current mappings, every module SQL file, and
foundation runtime SQL. After a frozen install (`pnpm install --frozen-lockfile`),
the check uses the existing TypeScript parser to discover released JS/TS SQL
values without executing them. Exported non-function values containing SQL, or
derived from SQL through references, spreads and helper calls, are migration
inputs. Exported migration/schema arrays remain inputs too. Discovery follows
value bindings to their declarations across imports and re-exports, including
barrels and helpers without SQL literals or schema filenames. Type-only imports
and unrelated runtime functions are not dependencies of a schema value.

Exported functions and their reachable declarations also expose runtime schema
installers, including private functions and imported helpers. Any reached file
containing DDL (CREATE, ALTER or DROP of a table, index, trigger or view) is an
input, as are the value bindings that construct that DDL, such as interpolated
table names. Discovery follows the released binding graph; no installer filename
list is maintained. It does not freeze an installer's unrelated runtime
dependencies or SELECT/INSERT-only request handlers.

The entire containing file is frozen, including comments, whitespace and runtime
exports sharing that file. A comment-only edit outside this SQL dependency graph
or whitespace-only edit outside this SQL dependency graph is allowed. This includes the operator-auth draft still consumed by older
families. A changed schema needs a new source file and a new numbered migration.
Discovery uses committed release source, so removing today's import or export
cannot unprotect an input. A source added after the latest release stays editable
until its first release; numbered migrations are protected by plain-main
comparisons as well. Every initializer mapping must resolve to a regular origin
file; missing mappings, unparseable released sources and unresolved schema value
imports fail closed.

New files pass; changed or removed files fail. It reads the working tree, so
uncommitted edits are checked too. Shallow clones acquire missing baseline
commits from `origin`; inaccessible history fails explicitly. Offline runs are
not a substitute. For another known main baseline, also pass
`--base-ref FULL_COMMIT` (this adds a comparison; it cannot replace release or
CI baselines).

An exceptional correction to published history requires a reviewed entry in
`scripts/migration-exceptions.json`, with an explanation of why a new migration
cannot serve and the affected consumers' recovery plan. Each entry binds exactly
one comparison: `baseline` (the full commit ID), `path`, `before` (the old bytes'
SHA-256), `after` (the replacement bytes' SHA-256, or null for deletion), and
`reason`. The failure report supplies those identities. There is no blanket
skip flag. An exception accepts only those exact bytes at that path and
baseline, remains visible in the check output, and must cover each reported
baseline explicitly. Remove obsolete exceptions after the released baseline
advances. The current exception retains only the exact already-landed runtime
exports in import-kit `database.ts` authorized on 23 October 2026; no schema SQL
changed and no consumer recovery is needed.

### Existing families with the old owner draft mapping

Before changing a family's Base pin or composing it, use current Base's
`pnpm edition <edition> --family-repo <family> --base-repo <base> --output <new>`.
Its preflight reads the committed descriptor selected by `--ref` (HEAD by
default), before dispatching pinned tooling. It refuses the legacy
`modules/operator-auth/accounts/schema/operator-auth.sql` →
`migrations/core/0001_owner.sql` mapping in `compositions/<edition>.json`.
Historical direct `composition/cli.mjs` invocations do not run this preflight;
use the supported `pnpm edition` command when updating an existing family.

1. In the existing runnable edition, restore `migrations/core/0001_owner.sql`
   from the edition commit originally published or applied. Run
   `adapt-base migrations/core/0001_owner.sql` through the edition-authoring CLI
   to acknowledge and freeze those recorded local bytes. Keep the record and
   acknowledged migration together; never replace 0001 with the newer draft.
2. In the family repository, copy those same historical bytes into
   `editions/<edition>/migrations/core/0001_owner.sql` (or the descriptor's
   `source` directory). Remove the old draft-to-0001 copy from
   `compositions/<edition>.json`, then commit both changes before composing.
   Adapting the runnable edition alone does not remove the family's copy mapping.
3. Refresh the existing edition with `refresh-base <new-base-commit> --base <base>`.
   Review the adapted conflict's `diffHint` and `schemaDeltas`. Carry each later
   schema change as a NEW numbered seed migration, for example from the
   append-only `accounts/schema/scheduled-policy.sql`,
   `scheduled-policy-hardening.sql` and `last-signin.sql` sources. Record each new
   verbatim copy with `record-base`, or acknowledge seed-owned adaptations.
   Retain these new migration bytes in family source too, and commit.
4. Advance `family.json` to the new Base commit, compose with `pnpm edition`, and
   compare every existing migration with its published edition bytes. Run
   `verify-base`, `rer check` and the edition's tests before adopting the output.
   Commit the runnable edition's retained `base-copies.json` with its migrations.

The new frozen template is only a starting point for new families. It is never
an instruction to overwrite an existing family's applied 0001.
