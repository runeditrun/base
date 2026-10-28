# Agent instructions

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
  chat. Independently authored apps use their own declared sign-in flow.
- Stop the app with `rer dev --stop`. If a start is refused, the message names
  the cause and the next command: run that command.

Without `rer` on PATH, install it once with `npx -y @runeditrun/rer cli install`
or the installer script: `curl -fsSL https://runeditrun.com/install.sh | sh`.
For the current shell, run `export PATH="$HOME/.local/bin:$PATH"` after installing.

## Run it locally

To install for a real owner instead of a review launch, run the verbs yourself
from this edition's checkout root. `rer` runs each verb with the rer version this
checkout pins.

```sh
rer install
rer setup --owner-email you@example.com
rer dev
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
`dev --as PERSONA` starts as a persona or signed out; legacy `dev --login`
uses the same automatic entry. Until first-run
completion is stored durably, app routes send the signed-in owner to `/setup`;
signed-out visitors sign in and return there. Once complete, `/setup` opens the
app or settings. Local dev and demo silently suppress mail.

The saved local port is used; a first setup saves the first free port from 8787. Explicit ports are decimal
integers from 1 through 65535 and must be free; a busy requested port fails
instead of silently moving. Only `127.0.0.1`, `localhost` and `::1` are allowed.
Dev applies the selected host and port to both the listener and runtime bindings;
readiness is bounded and failure stops the owned processes.

Missing non-interactive setup answers exit 3 and name the manifest fields.
Read `rer-setup.json` and pass a private, mode-0600 JSON object keyed by those
names using `rer setup --answers PATH --non-interactive`,
for example `{"OWNER_EMAIL":"owner@example.com"}`. Secret values stay in
private inputs and never go in command arguments. A setup rerun with the saved
owner and origin preserves the existing owner, data and exact private settings.
Conflicting saved identity or origin reports an actionable recovery path.
Review reset's exact removal inventory before confirmation. If data must be
kept, back up this installation first; restore that archive
only into an empty destination.

Queue waits report immediately with a reason and numeric one-based position,
then refresh about every 15 seconds while waiting. From the runnable project
root, inspect the live queue with
`node scripts/base-cli/modules/job-queue/cli.mjs status`.

Use the setup prompt instead of `--owner-email` when entering the real owner
mailbox. Open the `RER_OPEN` URL printed by `dev` on this computer; the app opens
signed in as the owner. Legacy `dev --login` uses the same automatic entry.
Local dev and demo silently suppress mail. Stop `dev`
with `rer dev --stop` or Ctrl-C, and stop `preview` with
`rer preview --stop` before build or verification.

Choose the following optional operations as needed. Export any data you want
to keep before running reset. Reset is destructive local cleanup; `--yes`
confirms removal of declared local data and settings. Archive restore requires an empty
destination and `--yes` confirms the restore. Deploy is a separate, deliberate
deployment operation; run it only when you intend to deploy.

```sh
rer verify
rer reset --yes
rer deploy
rer describe
```

To back up and restore this installation, use:

```sh
rer export --output exports/installation.rer
rer import --input exports/installation.rer --yes
```

These commands save and restore a supported installation archive. They do not
use the reviewed import door or provide its plan, reconciliation and Undo.
Archive restore requires an empty destination and explicit confirmation. Use
the signed-in import door when bringing records in.

Run `rer describe` to inspect the supported flags and effects before using
other options.

## Working on this edition

This repository contains the editable source of the owner's product. Its purpose,
implemented scope and operating instructions are in `README.md`; current coverage
and remaining work are in `HANDOVER.md`. Read those documents, `CONTRACT.md`,
`BASELINE.md`, `seed.json`, and existing customisations before changing behaviour.
Read `.seed/intent.md` where present and treat its recorded owner requirements as
binding until the owner changes them.

## Work on the product

A handler, registry or route table indexed by a request-derived name must use an own-property guard (`Object.hasOwn`) or a null-prototype/Map registry; inherited names (`constructor`, `__proto__`, `toString`) must answer 404/unknown.

Follow this edition's README and RER command contract for installation, local
startup, verification, provisioning and deployment. Check required accounts,
credentials, bindings and migrations before running an operation. Use the
configured health endpoint and real application journeys to establish what works.

A change that ships or alters a contract clause updates that clause's row in
`CONTRACT.md`'s Status table in the same PR. Follow the contract standard in
`SEED-COMMAND-CONTRACT.md` under "Contract status". Keep acceptance text and
status only in `CONTRACT.md`; never hand-edit `ACCEPTANCE.md`,
`docs/CLAIMS.md` or the generated Status summary rows. Run
`node src/base/contract-docs.mjs write` after every contract edit, then run
`node src/base/contract-docs.mjs check` and `rer check`. CI runs the generator's
`check` command. Use the actual generator path when this edition keeps its
parser elsewhere. Report Core done and full-target done together.

Landers regenerate after a rebase, then refresh the edition source lock. Use
this edition's actual paths; the lock line applies when the edition carries
that tool and lock:

```text
Lander-Regenerate: node src/base/contract-docs.mjs write
Lander-Regenerate: node scripts/edition-authoring/cli.mjs lock
```

Do not infer provisioning from a command named `setup`, deployment from a push,
or previews from a pull request. Those behaviours require actual scripts or
workflows. Missing configuration must remain visible. Never invent working
providers, sample data, mock services or fallback application behaviour.

## Make it fit

The owner may edit all source, including base code, family domain, modules,
schema, application UI, framework, infrastructure, configuration and tests for
new owner requirements. This is a
complete repository; authoring repositories are not runtime services it needs.
Choose the coherent change that minimises total work, cost, elapsed time and
owner attention, including future verification and updates.

Use existing configuration or extension APIs where they help. Core changes are
fully legitimate. Adding or removing capabilities requires handling their data,
dependencies and integrated journeys explicitly. Keep files small, remove dead
code, and preserve server-side authorisation and secret boundaries. Access data
through the product's repository layer and validate inputs at trust boundaries.
Declare new externals and isolate their integration. Preserve applied migration
history while changing core schema through tested forward migrations and recovery.

Record intentional departures in the edition’s existing requirements, divergence
or intent documents (`.seed/intent.md` is optional), with tests for the required behavior. Do not silently weaken a guarantee
or edit its upstream test to hide a regression. Use the edition's implemented
contract override mechanism with appropriate replacement verification. Record
owner-authorized changes to requirements, including any changed security
guarantees; existing authorization is sufficient. If tooling is missing, record the gap and
verify the intended behaviour directly without pretending an override passed.

Preserve owner-local paths such as `src/ext/`, `.seed/`, `migrations/ext/` and
`tests/local/` during updates, alongside customisations elsewhere. These are
conventions, not a general automatic-update guarantee or a limit on source edits.

## Verify and update

Run the edition's documented verification and exercise the affected journeys on
the real local app or a preview. Report uncovered or failing guarantees plainly.
A clean build or passing upstream tests alone does not prove owner intent survived.
No production mocks, hidden failures or semantic fallbacks.

Read the release changes, provenance and recorded intent before updating. Prepare
a candidate away from the live installation. Use update tooling only when the
edition supplies it; choose merge, rebase, reapplication or rewriting as appropriate.
Never regenerate over the owner's fork or discard conflicting work wholesale.
Verify applicable product guarantees, declared overrides and local intent tests
before adoption. Record what changed, what passed and any remaining limitation.

The owner may keep and change the MIT source independently of management services.
Use documented, verified export and restore procedures for data portability;
do not promise a command or recovery capability that has not been implemented.

Roll useful edition mechanisms and regression tests into maintained shared source
when they save work elsewhere. Verify adoption against each edition’s requirements;
a deep local variant can still adopt or adapt later upstream improvements.
