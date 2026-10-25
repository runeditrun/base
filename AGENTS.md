# Base

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

When asked to launch, run or review Base, run this from the Base repository
root and nothing else; it launches the maintained reference app in
`default-seed`:

```sh
rer dev --cwd default-seed
```

- It installs and sets up a fresh checkout by itself and prints progress; a
  first launch can take several minutes. Give the shell tool at least 10
  minutes. If the tool times out, run the same command again: it resumes.
- Never run install, setup, reset or deploy for this, and never ask for an
  email, port, password or answers file.
- Give the owner the `RER_READY` address and the `RER_OPEN` link, and ask
  nothing. `RER_OPEN` is a credential: share it only with the owner, in this
  chat.
- Stop the app with `rer dev --stop --cwd default-seed`. If a start is refused,
  the message names the cause and the next command: run that command.

Without `rer` on PATH, install it once with `npx -y @runeditrun/rer cli install`
or the installer script: `curl -fsSL https://runeditrun.com/install.sh | sh`.
For the current shell, run `export PATH="$HOME/.local/bin:$PATH"` after installing.

## Run it locally

Base is the source and authoring repository. The maintained reference app lives
in `default-seed`; a new foundation app becomes runnable after edition
composition. Do not run the seed commands from a family authoring input folder.

To install the maintained reference for a real owner, from the Base repository
root:

```sh
cd default-seed
rer install
rer setup --owner-email you@example.com
rer dev
```

Use the setup prompt instead of `--owner-email` when entering the real owner
mailbox. Open the `RER_OPEN` URL printed by `dev` on this computer; the app opens
signed in as the owner, including with the legacy `dev --login` flag. For a composed
foundation, run the same commands from the runnable edition checkout root.

The other supported operations are:

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

Stop `dev` with `rer dev --stop` or Ctrl-C before running
`verify` or `build`. Stop `preview` with `rer preview --stop`
before those operations too.

Reset destructively removes the declared local owner, data and generated
settings. Archive restore requires an empty destination and `--yes` confirms the restore.
`describe` is read-only and lists the actual verbs, flags and effects. Managed
`dev` and `preview` servers support `--stop` and `--idle-timeout`; in a
terminal the first invocation stays active while serving (without one,
`rer dev` returns once the app is ready), while compatible repeats reuse the
live server and exit.

## Working in Base

The integration branch is `main`; target it with pull requests and rebase work
onto it after shared changes land. On a clean Ubuntu/Debian Linux machine, run
`bash scripts/agent-bootstrap.sh && pnpm verify` from the repository root. The
bootstrap needs root or passwordless sudo and `/usr/local/bin` on the calling
shell PATH; it installs Node 22.20.0 and pnpm 10.12.4 there for the parent shell,
Python 3 for the operations checks, frozen dependencies in the default shared
pnpm store, workerd from the lockfile, and Chromium in the default shared
Playwright cache plus its system libraries.
`verify` includes the existing foundation and default-seed runtime/browser checks.
Their typechecks use package-local, gitignored `.cache/typecheck.tsbuildinfo`; deleting it forces a full check, while `build` still builds the real Worker and assets.
The Verify workflow runs for pull requests and main pushes; its manual
`clean_bootstrap` option verifies without restoring caches. It also runs
packed-launcher acquisition, browser onboarding and offline resume for pinned
public HappyToHelp source through `scripts/ci/launcher-acceptance.mjs` and
`launcher/tests/release-acceptance.mjs`. CI fetches commit
`60e9a84688ea41575d56a8f692bbb8173366c7c5` without credentials and selects Node
26.8.1 after Base's Node 22 stages finish. The helper writes its manifest and
evidence under `$RUNNER_TEMP`; CI removes those temporary outputs after the suite.
This browser suite does not install the app. The separately available
`pnpm verify:launcher-acceptance` runs the full packed-launcher installation
journey; the current Verify workflow does not invoke it.
The reference prerender preview uses explicit IPv4 loopback so its listener and
fetch URL agree in Linux containers.

Publication checks use system Git and Gitleaks 8.30.1. On macOS or Linux,
run `bash scripts/install-gitleaks.sh` for the checksum-pinned release binary
in `~/.local/bin`; Linux bootstrap uses the same installer in `/usr/local/bin`.
No Git source build or special ref-backend version is required.

Read README.md and the relevant implementation guide. Base maintains a
useful complete starting path and reusable source and tools for editions; a
technical foundation is not a finished product. Current editions own their source,
selected graph, integration and releases. Use edition-authoring/README.md for that
protocol, and follow the composition and publisher guides for their committed-source
workflows. These authoring tools do not regenerate existing edition-owned products.
Beacon and HappyToHelp are edition-owned; do not regenerate them from family source.

Base is an optional convenience path. RER can manage software authored
independently of Base, the maintained seed stack, onboarding, launcher or
exporter. An agent may adapt the software, runtime and provider targets to the
product, provided it declares the supported effects and verifies the applicable
guarantees. No universal hosted compatibility is implied by using RER or this
repository.

Choose boundaries that reduce total implementation, adaptation and maintenance
work. Shared implementations may be substantial and optional, and may live in any
appropriate repository. Deep source, schema, UI and infrastructure changes are
normal. Hooks and configuration do not constrain owners. Agents choose any
integration method, preserving recorded owner requirements, applicable guarantees,
external-effect obligations and applied migration history.

During edition work, identify useful mechanisms and verification cases to roll
into shared implementations. Verify the shared default and a meaningful variation
in real adopting editions; keep a local variant when useful. Do not require all
forks to converge or introduce abstractions without a concrete benefit.

Keep runtime changes separate from documentation claims. Use existing commands
and schemas, preserve historical evidence and source provenance, and report
uncovered guarantees honestly. Follow repository tests appropriate to the change;
passing Base tests does not prove an edition's integrated behavior or deployment.
