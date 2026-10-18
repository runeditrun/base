# rer

`rer` is the Run Edit Run command. Install it once, then run `rer <verb>` in any
Run Edit Run checkout: every verb runs that checkout's own pinned copy, so a
checkout always gets the behaviour it was built and tested with.

## Install

Start a seed from an empty folder, with or without Node:

```sh
curl -fsSL https://runeditrun.com/install.sh | sh
rer dev just-every/run-inkwell
```

The installer needs no Node: without Node 22 or later on PATH it installs a
private one for `rer` (see below). It edits no shell profile: it names the next
command, `rer dev <owner>/<repo>`, and when `~/.local/bin` is not on PATH for new
terminals its last line is the one to run first, which adds it for your shell.
The same start also fits on one line:

```sh
curl -fsSL https://runeditrun.com/install.sh | sh -s -- dev just-every/run-inkwell
npx -y @runeditrun/rer dev just-every/run-inkwell   # only with Node 22 or later on PATH
```

Each of these installs the user CLI, clones into `./run-inkwell`, install dependencies, set
up a local owner and start the app. Open the printed `RER_OPEN` link to sign in.
Use `setup <repo>` to stop after setup, or `install <repo>` to stop after
dependency installation; each prints the next command. The repo can be
`<owner>/<repo>`, a GitHub HTTPS URL (with or without `.git`), or a git URL.
`--dir DIR` chooses another folder. An existing clone with the same origin is
reused; any other non-empty folder is refused. Inside a checkout, the commands
without a repository work as before. Dev follows the usual terminal behaviour:
Ctrl-C stops a foreground app; without a terminal it returns once ready and
leaves the app running. The restart command includes `cd` into the checkout.

Install `rer` with one of these commands:

```sh
curl -fsSL https://runeditrun.com/install.sh | sh  # user install in ~/.local/share/rer, launcher ~/.local/bin/rer; no Node needed
npx -y @runeditrun/rer cli install                # the same user install, with Node 22 or later on PATH
npm install -g @runeditrun/rer                    # npm's own global layout, with Node 22 or later on PATH
```

`install.sh` is the file at the root of this package. It reads the version, the
tarball and its sha512 integrity from the npm registry (`npm_config_registry`,
default `https://registry.npmjs.org`; `RER_VERSION=X` pins an exact version,
otherwise the latest), checks the download's integrity, file count and size,
refuses archives with absolute paths, `..` entries, links or devices, then runs
the package's own `rer cli install`. A failed or refused download leaves the
version you had selected.

With no Node 22 or later on PATH, the script installs Node 22.20.0 from
`nodejs.org` into `~/.local/share/rer/runtimes` (under `XDG_DATA_HOME` when set),
verifies the tarball against that release's published `SHASUMS256.txt`, and
prints its location. The launcher uses this private runtime on later runs.
System Node and other PATH directories are left alone: the private runtime's
`node`, `npm` and `npx` are not put on PATH, because `rer` is the one command
the installer provides. With no arguments the script names the next command,
`rer dev <owner>/<repo>`, and ends with the PATH line below when one is needed.

No installer edits shell profiles. The canonical launcher is `~/.local/bin/rer`.
Installation creates that directory if needed and never writes into another
PATH directory. It names any existing `rer` elsewhere on PATH and leaves it
unchanged. If `~/.local/bin` is absent from PATH, another command shadows it,
or no startup file of your shell adds it for new terminals, its last line is
one command to run: it appends `export PATH="$HOME/.local/bin:$PATH"` to that
startup file (`~/.zshrc` for zsh; `~/.bash_profile` for bash on macOS and
`~/.bashrc` elsewhere; `~/.profile` otherwise) and runs it in the current shell.
For fish it is `fish_add_path ~/.local/bin`. Without a private runtime, the
launcher uses `node` from PATH. A re-run with the same build changes
nothing; a different build is installed beside the current one, the previous one
is kept and older ones are removed. It refuses to replace a `~/.local/bin/rer`
that it did not write.

`rer --version` prints this rer's version; inside a checkout a second line
names the version the checkout pins, or says that its vendored copy is
unversioned (exported before copies recorded one).

`rer cli status` shows the version, the digest of the installed contents, the
install channel (`npx`, `script` or `npm-global`), the launcher, the install root
and every other `rer` on PATH. `rer cli uninstall` removes the launcher and the
install root it runs only; `~/.rer` (servers, jobs, Node runtimes) is untouched.
An npm global `rer` prints its `npm uninstall -g` command and leaves a user
install in place.

### Requirements

- macOS or Linux, on x64 or arm64. WSL2 counts as Linux.
- For `install.sh`: `curl`, `tar`, and `shasum` or `sha256sum` when it installs
  Node. macOS includes these tools.
- For the npm/npx install alternatives: Node 22 or later on PATH.
- Checkout commands acquire the checkout's pinned Node and pnpm when needed,
  in rer's own cache: neither goes on PATH. `rer run SCRIPT [ARGS]` runs a
  package.json script with them, so a project's `pnpm run X -- ARGS` is
  `rer run X -- ARGS`. `rer install` downloads no browser: the checkout's
  Playwright Chromium and headless shell download the first time a command needs
  them (`rer verify`, or `rer run` of a script that runs Playwright). Downloads
  print progress. `rer doctor` lists browsers not downloaded yet, without
  counting them as a problem or downloading anything itself.

Not supported: native Windows (`install.sh` and `rer` say to use WSL2), and
`OPERATIONS.json` version 1 projects.

## Update

```sh
rer update               # the latest published version
rer update --version X   # exactly X
```

`rer update` follows the way `rer` was installed. A user install (`npx` or
`install.sh`) downloads the version from the registry, checks it as `install.sh`
does and switches to it atomically, keeping the previous version and the same
channel; a damaged or mismatched download leaves the current version selected.
It says "already current" when the registry's version has the same contents. A
development build (`<version>-dev.g<sha8>`) moves to the release once that
version is published, and a different build of the same version counts as an
update. An npm global install runs `npm install -g @runeditrun/rer@X` for its own
prefix; when npm fails (for example, a prefix only root can write), `rer update`
exits non-zero with npm's message and the exact command to run.

In a terminal, `rer` checks the registry at most once a day and prints one line
when a newer version is published. It never prints in `--json` output or when
output is not a terminal, never delays a command by more than about 1.5 seconds,
and `RER_NO_UPDATE_CHECK=1` turns it off.

## Launch a checkout

```sh
rer dev
```

In a first-party checkout this is the whole launch. It installs dependencies when
`node_modules` is missing, incomplete (no `node_modules/.modules.yaml`, or an
install a launch started did not finish) or older than the lockfile, sets up a local owner
(`owner@<checkout-name>.test`) on the first free port from 8787 when the checkout
has never been set up (`--port N` picks the port), fills any setup answer the
seed declares a `localDefault` for in `rer-setup.json` (a literal, a generated
secret kept only in the checkout's private settings, or the chosen local
origin), starts the app and prints:

```
RER_READY http://127.0.0.1:8787
RER_SIGNED_IN owner@cradle.test
RER_OPEN http://127.0.0.1:8787/__dev/key#...
```

A seed that declares a run site prints one more line after those,
`RER_SITE http://127.0.0.1:8788`: a local preview of its static run site (its
marketing homepage, `/run` and docs) on the first free port above the app's. It
stops with the app.
Later, `rer setup --owner-email YOU` (or `--answers`) with the real owner
replaces that local owner in place and keeps all local data, saying so in one
line; a checkout whose database holds any other owner is still refused.
It never prompts and never re-runs setup on a checkout that is already set up. A
setup a launch started that was stopped or failed is run again by the next
`rer dev`, keeping the owner and origin it saved, unless a setup has finished
there since (for example your own `rer setup`). A checkout whose pin reports it is
not set up (`rer describe`'s `local.prepared`) but that already holds an owner
(`local.ownerSaved`, for example when a newer manifest requires another setting)
finishes setup keeping that owner and origin. A required setup answer with no value and no
`localDefault` stops the launch with exit 3 and setup's message naming it.

Inside a checkout `rer` acts on the nearest `OPERATIONS.json` at or above the
working directory; `--cwd DIR` names the project root itself, exactly as
`node scripts/rer.mjs` reads it.

Without a terminal (an agent's shell tool) it returns as soon as the app is ready
and leaves it running, printing the server's private log path; in a terminal it
stays in the foreground and Ctrl-C stops it. `--detach` and `--foreground`
override the choice, and `--json` prints `progress` events and the ready event. A
first launch can take minutes: it prints a progress line at least every 30
seconds, and if the calling command is killed the launch carries on; run
`rer dev` again to reattach. A second `rer dev` reprints the ready lines.
`rer dev --stop` stops the server, or a launch still preparing (which then
reports that it was stopped), waits until every process they started has
exited and says what it stopped; if any is still running it exits non-zero
naming their PIDs.

Servers started through `rer` (`rer dev`, `rer preview`) get a 10-server limit and a 12-hour idle timeout
unless you set `RER_SERVER_LIMIT`, `RER_SERVER_IDLE_SECONDS` or `--idle-timeout`.
`RER_SERVER_LIMIT_FILE=PATH` names a file holding the limit as a positive integer,
read at every start; it overrides `RER_SERVER_LIMIT` and the limits running servers
recorded, so a fleet's one current value cannot be capped by an older run's
environment. An unreadable or non-integer file refuses the start, naming the file.
`rer` supplies them only to checkouts whose pinned copy applies lower defaults
or does not report its own (`rer describe` reports `defaults`), so a current
checkout never records a limit you did not set.
A start is never refused for machine load alone unless `RER_SERVERS_LOAD_THRESHOLD`
or `RER_JOBS_LOAD_THRESHOLD` is set; memory and disk guards stay. The disk guard
needs 15 GiB free; `RER_SERVERS_DISK_FLOOR_GIB=N` changes it (CI runners may set
it lower, for example 4; people should not).

## The front door

```sh
rer door enable              # opt this computer in: port 8700, 10 servers, 12 hours idle
rer door add ~/review/*      # register checkouts; prints each http://NAME.localhost:8700
rer door status --links      # every checkout, its state, and sign-in links
```

One process on one port serves every registered checkout at
`http://NAME.localhost:PORT` (NAME is its folder name, unique and stable);
`http://localhost:PORT` lists them. A stopped checkout starts when you open it
in a browser and stops when idle; subresources, API calls and WebSockets never
start one. `rer door enable` stores the policy (`--port`, `--server-limit`,
`--idle-timeout`) and the `RER_*` variables in effect, so whoever later starts
the door cannot change what its checkouts run with. While it is enabled, `rer
dev` sets fresh checkouts up behind it; `rer dev --door` moves an existing one
(keeping its data), `rer dev --direct` moves it back, and `--port N` always
serves directly. `rer door start`, `stop`, `restart`, `disable` and `remove
NAME` do what they say; after a reboot or logout the door needs `rer door
start`. `rer door --help` has the details.

## Find what to launch

```sh
rer list [DIR] [--json]
```

lists the checkouts in a folder, newest change first, with their profile
(`first-party`, `independent` or `unsupported`), whether `rer dev` can launch
them, whether they are set up, and their running URL.

Independent projects (an `OPERATIONS.json` version 2 without a seed contract) run
their declared commands with `rer <verb> [-- args]`; zero-setup launching does not
apply to them. `OPERATIONS.json` version 1 is not supported.

## Package mode: a checkout that pins `@runeditrun/rer`

A checkout runs one of two copies of rer. In **vendored mode** it carries
`scripts/rer.mjs`, `scripts/base-cli` and `scripts/base-onboarding`, and `rer`
runs that copy. In **package mode** it carries none of them and pins this package
as an exact devDependency instead (`"@runeditrun/rer": "0.2.0"`, locked in
`pnpm-lock.yaml`): its `OPERATIONS.json` argv and package scripts are `rer VERB`,
which inside `pnpm run` is the pinned copy in `node_modules/.bin`, so
`pnpm install --frozen-lockfile && pnpm run build` needs no global `rer`. A global
`rer` hands every verb to the pinned package, launching included. Until
`node_modules` holds the pinned version (a fresh clone, or a pulled pin change),
every verb installs it first (the frozen `pnpm install`), then runs it; verbs
started at once share that one install.
Every dependency install, `rer release`'s included, receives an allowlisted
environment: the shell, locale, terminal and temporary-folder variables, `CI`,
`TZ`, `SSH_AUTH_SOCK`, `NODE_OPTIONS`, `NODE_EXTRA_CA_CERTS`, `XDG_*`, proxy
settings without their user:password, and `npm_config_*`, `PNPM_*`,
`COREPACK_*` and `RER_*` settings that carry no credential by name or value.
No other variable reaches the package manager or a dependency's build script.

Heavy package scripts wait for this computer's job queue with
`rer queue NAME -- COMMAND [ARGS]` (in vendored mode,
`node scripts/base-onboarding/queued-entry.mjs NAME -- COMMAND`).

`rer check --profile first-party` accepts either mode. In package mode it asks for
the exact devDependency (`SC-13.package.pin`), its lockfile entry
(`SC-13.package.lockfile`), no vendored copy (`SC-13.package.vendored.*`) and `rer
VERB` targets and aliases (`SC-02.target.*`, `SC-02.alias.*`); in vendored mode for
the copy and its recorded inventory, as before.

Convert a vendored seed from a Base checkout with

```sh
node scripts/export-cli.mjs --to-package SEED_ROOT [--version X]
```

(the default version is the latest published one, read with the seed's own npm
configuration). It refuses, listing them, when the vendored copy differs from its
recorded inventory: carry those edits with `pnpm patch @runeditrun/rer` once
converted, or upstream them to Base. Otherwise it pins and locks the package
(`pnpm install --lockfile-only`), rewrites imports into the copy to the exports
below (anything else to `@runeditrun/rer/internal/PATH`, which promises nothing
beyond the pinned version), rewrites the package scripts and `OPERATIONS.json`
argv to `rer VERB` and the delivery operations (`rer-project.json` and the
`scripts/delivery/base/packaging.json` it is generated from), the shell scripts
they and CI workflows run, and workflow lines to `pnpm exec rer VERB` (a frozen
`pnpm install` first where nothing has installed yet), drops the copy's own records from `base-copies.json` (the
app-runtime copies it records stay as they are), removes the copy and lists every
line that still names it. A later refresh is a version bump:
`pnpm add -D -E @runeditrun/rer@X`.

### Exports

| Import | What it gives | Vendored path it replaces |
| --- | --- | --- |
| `@runeditrun/rer/adapter` | `commandAdapter` | `scripts/base-cli/cli/adapter.mjs` |
| `@runeditrun/rer/deploy` | `ownerDeploy` | `scripts/base-cli/cli/deploy.mjs` |
| `@runeditrun/rer/portability` | `localPortability` | `scripts/base-cli/cli/portability.mjs` |
| `@runeditrun/rer/errors` | the CLI's error helpers | `scripts/base-cli/cli/errors.mjs` |
| `@runeditrun/rer/jsonc` | JSONC reading | `scripts/base-cli/cli/jsonc.mjs` |
| `@runeditrun/rer/parse`, `/scheduled` | CLI argument parsing, scheduled-job helpers | `scripts/base-cli/cli/parse.mjs`, `scheduled.mjs` |
| `@runeditrun/rer/dev-identity` | dev identity helpers | `scripts/base-cli/cli/dev-identity.mjs` |
| `@runeditrun/rer/operator-installer` | `operatorInstaller`, `developmentTarget`, `previewTarget` | `scripts/base-onboarding/operator-installer.mjs` |
| `@runeditrun/rer/local-installer` | `localInstaller` | `scripts/base-onboarding/adapter.mjs` |
| `@runeditrun/rer/operator-install` | `installOperator` | `scripts/base-onboarding/operator-install.mjs` |
| `@runeditrun/rer/operator-prerequisites` | `operatorPrerequisites` | `scripts/base-onboarding/operator-prerequisites.mjs` |
| `@runeditrun/rer/local/state` | `selectLocalState` | `scripts/base-onboarding/local/state.mjs` |
| `@runeditrun/rer/local/build` | local build step | `scripts/base-onboarding/local/build.mjs` |
| `@runeditrun/rer/state`, `/commands` | onboarding state and command runners | `scripts/base-onboarding/state.mjs`, `commands.mjs` |
| `@runeditrun/rer/local/environment`, `/local/files`, `/local/operation`, `/local/recovery` | local setup helpers | `scripts/base-onboarding/local/*.mjs` |
| `@runeditrun/rer/private-files` | private file helpers | `scripts/base-onboarding/private-files.mjs` |
| `@runeditrun/rer/adapter-settings` | adapter settings helpers | `scripts/base-onboarding/adapter-settings.mjs` |
| `@runeditrun/rer/adapter-auth`, `/adapter-hosting` | adapter auth and hosting helpers | `scripts/base-onboarding/adapter-auth.mjs`, `adapter-hosting.mjs` |
| `@runeditrun/rer/process-diagnostics` | process diagnostics | `scripts/base-onboarding/process-diagnostics.mjs` |
| `@runeditrun/rer/process-cleanup`, `/process-scope` | process cleanup and scope | `scripts/base-onboarding/process-cleanup.mjs`, `process-scope.mjs` |
| `@runeditrun/rer/failures`, `/redaction` | failure and redaction helpers | `scripts/base-onboarding/failures.mjs`, `redaction.mjs` |
| `@runeditrun/rer/setup-manifest`, `/setup-schema` | setup manifest loading and its JSON schema | `scripts/base-onboarding/setup-manifest.mjs`, `schema/SETUP.schema.json` |
| `@runeditrun/rer/production-runtime`, `/production-modules` | production runtime helpers | `scripts/base-onboarding/production-runtime.mjs`, `production-modules.mjs` |
| `@runeditrun/rer/queued-entry` | the job-queue entry | `scripts/base-onboarding/queued-entry.mjs` |
| `@runeditrun/rer/archive-output` | `archiveOutputGuard` (with types) | `scripts/base-onboarding/archive-output.mjs` |
| `@runeditrun/rer/launcher` | the browser installer launcher | `scripts/base-onboarding/launcher.mjs` |
| `@runeditrun/rer/installer-server` | the browser installer's server (installer journeys) | `scripts/base-onboarding/server.mjs` |
| `@runeditrun/rer/server-resources` | managed server resource readings (runtime journeys) | `scripts/base-cli/cli/server-resources.mjs` |
| `@runeditrun/rer/operations` | OPERATIONS describe and check | `scripts/base-cli/operations/operations.mjs` |
| `@runeditrun/rer/modules/portability`, `/catalogue`, `/cli`, `/cli-options`, `/files`, `/format`, `/http`, `/import`, `/journal`, `/legacy-safety`, `/migration-history`, `/storage` | portability module | `scripts/base-cli/modules/portability/*.mjs` |
| `@runeditrun/rer/modules/release/export`, `/publication-scan`, `/source`, `/signature` | release export, publication scan and shared signature verifier | `scripts/base-cli/modules/release/*.mjs` |
| `@runeditrun/rer/modules/deploy-kit/owner`, `/owner-cli`, `/prepare`, `/provider` | deploy kit | `scripts/base-cli/modules/deploy-kit/*.mjs` |
| `@runeditrun/rer/modules/operator-auth`, `/dev`, `/dev-admission`, `/accounts/native`, `/identity/email-link` | operator auth | `scripts/base-cli/modules/operator-auth/index.mjs`, `dev/index.mjs`, `dev-admission.mjs`, `accounts/native.mjs`, `identity/email-link/index.mjs` |
| `@runeditrun/rer/modules/erasure/fence` | erasure fence statements | `scripts/base-cli/modules/erasure/fence.mjs` |
| `@runeditrun/rer/modules/owner-claim`, `/modules/dependencies` | owner claim, dependency links | `scripts/base-cli/modules/owner-claim/index.mjs`, `dependencies/index.mjs` |
| `@runeditrun/rer/internal/PATH` | any other package file, for tests | `scripts/base-cli/PATH`, and `scripts/base-onboarding/PATH` with PATH under `onboarding/` |

## Verbs

In a checkout, every verb runs that checkout's own pinned `rer`; `rer VERB --help`
there lists its flags:

`install`, `setup`, `dev`, `preview`, `build`, `verify`, `reset --yes`, `deploy`,
`export`, `import`, `doctor`, `describe`, `check`, `release`,
`release sign`, `release receipt` and `release keygen`.

Anywhere: `rer list [DIR]`, `rer cli status|install|uninstall`, `rer update`,
`rer queue NAME -- COMMAND`, `rer --version` and `rer --help`.

Licence: MIT.

First-party commands acquire the exact `packageManager` pnpm pin when PATH lacks
it, verify its registry sha512 integrity and cache it under `$HOME/.rer/pnpm`.
No global package manager installation or sudo is needed. Independent projects
continue to run their declared commands with their own tools. Server and job
state default to `$HOME/.rer/servers` and `$HOME/.rer/jobs`; supplied
`RER_SERVERS_DIR` and `RER_JOBS_DIR` take precedence and are passed to older pins.

## Inspect local business signals

`rer business scan [DIR...] [--json]` scans the current directory or the named
local directories without installing dependencies, executing project code or
using the network. It works outside RER checkouts. Both forms print one JSON
document: `{schema: "rer-business-signals/1", source: "local", signals: [...],
withheld: N}`. Signals identify package, environment, CI, infrastructure and
configuration names with a relative `locator`, repository basename `repo`,
`class` (`live-use` or `trace`) and `observedAt`.
Identical `(kind, value, repo, class)` signals are emitted once with an occurrence
`count` and the first matching `locator`. `secret-file` signals remain separate
for each path, preserving each file's size and modification time.

Config keys come only from JSON (including JSONC), YAML and TOML files in
configuration directories or with known config filenames.
Data in tests, fixtures, locales, translations, samples and exports, along with
lockfiles and generated output, contributes no config keys. The document's
`configKeyLimit` declares the maximum distinct key paths per file (currently
200). JavaScript and TypeScript config files are not read or parsed;
dependencies still come from manifests.

Only names leave the scanner. Secret files are never opened and contribute
`secret-file` metadata (filename, path, size and modification time).
Sensitive-looking outbound names are dropped and counted in `withheld`.
Symlinks, generated outputs and dependency trees are skipped; unsupported
formats and syntax may yield no signals.

## Business device commands

`rer business connect --code ABCD-1234 [--origin https://app.runeditrun.com]`
redeems a browser-created code, prints a six-digit confirmation number and waits
for approval in the browser that created it. Device credentials stay in macOS
Keychain or Linux Secret Service. A missing or locked Secret Service refuses;
there is no plaintext credential store. Linux needs `secret-tool` and an
unlocked desktop Secret Service session.

In a terminal, connect asks separately before adding Claude Code user Read deny
rules, allowing export-scoped macOS wake prevention, and installing a launchd
or systemd user service. Only the exact answer `yes` opts in. Noninteractive
connect pairs but leaves those optional changes off. Background services use
absolute Node and CLI paths.

Connect also asks once which supported CLI should answer agent questions:
Claude, Codex or `none`. Detection reads only absolute PATH entries and skips a
candidate unless every link, the file and every folder above them, on the PATH
entry and on the resolved path, belong to you or root. Folders that group or
others can write are refused unless they are root's sticky folders (such as
`/tmp`), and so is a file they can modify. It checks the resolved file's help
in a throwaway home without credentials and records that resolved path (the
one that runs), its pinned cheaper-tier model (Claude: `sonnet`; Codex: the
smallest current model in the catalog the installed Codex ships) and device
capabilities. Noninteractive connect chooses `none`, preserving interactive
`next` / `answer` use. Reconnect to change the choice. `status` shows the
recorded questions CLI, model and limits.

Limits stay on the computer. At most 30 model questions an hour: the
supervisor pauses questions at the limit and keeps working other tasks. Each
question runs at most 120 seconds and holds at most 256 vendor ids. Claude runs
with `--effort low`, thinking off and at most 1024 output tokens per model turn
(`CLAUDE_CODE_DISABLE_THINKING`, `CLAUDE_CODE_MAX_OUTPUT_TOKENS`). Its
`--max-budget-usd 0.05` is checked after each turn, so it stops a question
once the cost passes $0.05 rather than capping the turn that crosses it. Codex
runs with low reasoning effort and has no per-question dollar limit. `connect
--questions-per-hour N` and `--max-budget-usd USD` can only lower the hourly
and dollar limits.

Each question's records live in `~/.rer/business/classifier/`, including Codex's
private home with its copy of your Codex login. If the supervisor is killed
mid-question, its next start stops any classifier still running from that
question and removes the folder; `disconnect` does the same.

`rer business vendor-key add sentry` requires hidden credential entry in a
terminal, stores it in the OS keychain and prints only `sentry:read`.
`remove` deletes it. The same commands support `uptimerobot`, `pagerduty` and
`calendly`. Never put a key in command arguments, chat or a URL.

`rer business next` returns one locally templated classification or owner link,
or `Nothing yet`, within 60 seconds. It never reflects server instructions or
raw evidence. Owner items cannot be answered from this CLI.
`rer business answer ID VENDOR uses|sells|both|product-dependency [CONFIDENCE]`
submits a task-scoped classification through MCP. Choose a vendor ID from the
question's displayed answer schema, or `none`; the suggested vendor can be
corrected. Confidence is a number from 0 to 1, defaulting to 1. The completion
sends exactly `{vendor_id, usage, confidence}`. Free text is refused locally.
The owner confirms the inventory in the browser.
`rer business token` emits an MCP Authorization header object for direct use as
a headers helper. That output is a short-lived credential: connect it directly
to the MCP client and do not paste it into an agent transcript.

`rer business status` shows local pairing, questions CLI, service state and progress without
printing checkpoints or vendor data. `rer business disconnect` removes the
service, device and vendor credentials, state and introduced Claude rules,
preserving preexisting settings and unrelated edits. Revocation in the browser
removes remote authority; disconnect removes the local installation's additions.

`rer business run` performs consented `discover.local` tasks through claims,
short-lived task bearers, quota-bound uploads, 60-second heartbeats and server
completion checks. Only the browser consent's paths are scanned. Names-only
snapshots and page boundaries are saved privately so a killed supervisor can
resume from its server checkpoint without rescanning a changed tree. Snapshots
are removed after completion. A missing snapshot for an acknowledged page is
an explicit error. Revocation stops the supervisor on its next 401.

With a chosen CLI, `run` also claims `classify.row` and starts one classifier
process per question in an empty temporary working directory. Its prompt has
only RER template text, catalog vendor IDs, and closed usage enums. A question
with more than 50 vendors, or a vendor ID longer than 32 characters of
`a-z`, `0-9` and at most 2 hyphens, is released with that reason before a
model starts. Raw vendor and DNS evidence, server instructions and schema
annotations never enter the prompt. Answers must match the question's closed
vendor/usage/confidence schema locally before completion, and confidence is
posted rounded to 2 decimals. Invalid output, process failure, cancellation or
a 120-second timeout releases the lease; model diagnostics are never printed.
Timeout and cancellation stop the private process group, including a CLI's
native child process.
Owner-only tasks remain in the browser. Temporary schema and answer files stay
outside the model's working directory and are removed afterwards.

Claude runs with `-p --tools "" --strict-mcp-config --setting-sources ""
--output-format json --json-schema <schema> --model sonnet --max-budget-usd 0.05
--safe-mode --disable-slash-commands --no-session-persistence` and receives
`HOME`, `USER` and `LOGNAME` (which Claude Code on macOS needs to find its
login; from the OS account when unset) plus only `ANTHROPIC_API_KEY` and
`CLAUDE_CODE_OAUTH_TOKEN`. Codex runs with `exec --sandbox read-only
--skip-git-repo-check --output-schema <schema-file> --ignore-user-config
--ignore-rules --ephemeral --output-last-message <answer-file> --model <model>`
in a fresh temporary `HOME` and `CODEX_HOME` holding only a copy of the
customer's `auth.json`, and receives only `OPENAI_API_KEY` and `CODEX_API_KEY`
as credentials. The customer's Codex config, MCP servers, hooks, skills and
global `AGENTS.md` stay behind. Credentials Codex refreshes during the run are
returned to the customer's `auth.json` unless their own Codex changed it
meanwhile. Codex additionally disables hooks, plugins, apps, memory, shell,
browser, image and subagent features and web search, and explicitly disables
each MCP server it still loads (managed or system configuration), listed with
the same private `CODEX_HOME` without starting them. Before the model starts,
`codex debug prompt-input` renders what the model would see; anything beyond
Codex's own developer text and a probe, such as an `AGENTS.md` or
`AGENTS.override.md`, releases the question, as do credentials that are not
in a copyable file or the environment. Supervisor preloads and agent-specific
environment instructions are excluded for both CLIs.

**Remaining export blockers:** grants for linked, configured targets now resolve
to an HTTPS `/api/rer/import/uploads` destination with a 2 MiB quota. They declare
`upload_authorization: seed_import_grant_required` but supply no signed seed
import authority. Vendor task inputs, adapter resume checkpoints and the chunk
assembly/upload contract are also absent. The CLI releases these tasks before
reading a vendor key; background mode parks them, and `run --once` reports the
dependency as a command failure. An unavailable destination reports its reason
and releases with `paused` after a `connected_runner_required` event.
Vendor export remains blocked.

The current MCP `next_question` filters out owner items. When an owner summary
is supplied, the CLI displays its browser link and refuses to answer it.

The four deterministic adapter implementations and their native output formats
are described in [the adapter guide](cli/business/vendors/README.md). Their
presence does not enable export until the seed import authority and remaining
transport contracts are connected.

## Local engineering companion

`rer companion` pairs your own computer with a Run Edit Run app, then runs the
change requests the app sends it with your own Codex or Claude, here. It makes
outbound HTTPS requests to the app only and opens no local server. It needs
Node 22 or later; `run` needs macOS, because each provider runs inside a macOS
`sandbox-exec` boundary. On other systems `run` refuses before it asks the app
for work: it never runs a provider without that boundary.

```sh
npx -y @runeditrun/rer companion map PROJECT_ID <owner>/<repo> /path/to/your/checkout
npx -y @runeditrun/rer companion pair https://app.runeditrun.com ABCD-2345
npx -y @runeditrun/rer companion codex-auth     # or: claude-auth
npx -y @runeditrun/rer companion run
```

With `rer` installed, drop `npx -y @runeditrun/rer`. Run `rer companion --help`
for every verb.

- `map PROJECT_ID <owner>/<repo> CHECKOUT` approves one local Git checkout for an
  app. Its `origin` must be exactly that GitHub repository. `PROJECT_ID` is the
  app's id, shown in the command on its Devices page. On a Managed app, if you
  cloned with the temporary clone URL the app gives you, reset `origin` first
  with `git remote set-url origin https://github.com/<owner>/<repo>.git`: `map`
  refuses a URL that carries a token, and the reset keeps the expired token out
  of your `.git/config`.
- `pair URL CODE` redeems the one-use code from the app's Devices page (the
  8-character code or the full code; both expire after 10 minutes). The app
  must name the repository you mapped, or this computer stays unpaired.
  `--project ID`, `--provider codex|claude` and `--name NAME` set the rest; in
  a terminal it asks for a missing project (and offers to map it) and provider.
  With exactly one mapped project it uses that one, and the provider defaults
  to `codex`. The earlier form `pair URL CODE PROJECT_ID [PROVIDER] [NAME]`
  still works.
- `codex-auth [AUTH_FILE]` copies only Codex's `auth.json`
  (`$CODEX_HOME/auth.json`, else `~/.codex/auth.json`) into a dedicated
  executor home. Codex configuration and MCP servers are not imported.
- `claude-auth` runs Claude Code's own sign-in with the dedicated executor home
  (add `--console` for a Console account). Host Claude configuration and
  history are not copied. To use API billing instead, set
  `RER_COMPANION_ANTHROPIC_API_KEY`; a host-wide `ANTHROPIC_API_KEY` is never
  passed to the provider.
- `commands PROJECT_ID FILE` approves argv lists for setup and verification,
  for example `{"setup":[["pnpm","install","--frozen-lockfile"]],"verify":[["pnpm","verify"]]}`.
  They run in the same boundary, with network access, a home of their own and
  no provider or deployment credentials. A job from the browser cannot change
  them.
- `run [--once]` takes jobs from the app and runs them. `status` prints the
  paired device, mapped projects, the active job and pending events, never the
  device key.

How a job runs: each job starts from the exact commit the app names, fetched
into a separate detached checkout with its own Git metadata. Fetch that commit
into your checkout first. Your branch, index, dirty and untracked files stay
untouched. Git runs without global or system configuration, hooks or
templates. The provider (Codex `app-server`, or `claude`) can write only that
checkout and the dedicated home, and read only them, its own installation and
the system runtime; other files, including through symlinks, are denied. Its
environment has no GitHub, Cloudflare or MCP credentials. A request to widen
that boundary can only be declined from the app; it is never approved
remotely. Known provider credentials are redacted from relayed progress and
block a result that contains them. Events wait on disk and are retried with the
same ids until the app accepts them. A job that was running when the companion
stopped is never restarted on its own: resume or cancel it from the app. The
provider's own network access is not fenced.

State lives in `~/.rer-local` (`RER_LOCAL_HOME` picks another private folder).
The device key is stored there in a 0600 file; the app keeps only its hash.

**Revoke a device** in the app: Settings › Devices › Revoke. A running
companion stops at its next request to the app. Then delete the state folder
on that computer.

If setup failed before any provider turn and you have confirmed no provider or
setup process is still running, `confirm-no-turn-started JOB_ID
--confirm-no-provider-turn-started` lets the app resume it. It refuses if the
checkout changed or the provider recorded a session for it. It reads the
checkout with Git inside the same boundary, because setup could have changed
the checkout's Git configuration.
