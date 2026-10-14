# rer

`rer` is the Run Edit Run command. Install it once, then run `rer <verb>` in any
Run Edit Run checkout: every verb runs that checkout's own pinned copy, so a
checkout always gets the behaviour it was built and tested with.

## Install

Any one of these leaves `rer` on your PATH:

```sh
npx -y @runeditrun/rer cli install                # user install in ~/.local/share/rer, launcher ~/.local/bin/rer
curl -fsSL https://runeditrun.com/install.sh | sh  # the same user install, without npm
npm install -g @runeditrun/rer                    # npm's own global layout
```

`install.sh` is the file at the root of this package. It reads the version, the
tarball and its sha512 integrity from the npm registry (`npm_config_registry`,
default `https://registry.npmjs.org`; `RER_VERSION=X` pins an exact version,
otherwise the latest), checks the download's integrity, file count and size,
refuses archives with absolute paths, `..` entries, links or devices, then runs
the package's own `rer cli install`. A failed or refused download leaves the
version you had selected.

No installer edits shell profiles. The canonical launcher is `~/.local/bin/rer`.
When that directory is absent from PATH, installation also links it into an
existing writable, user-owned PATH directory if available, preserving foreign
commands. Otherwise it prints one activation line to run in the current shell:
`export PATH="$HOME/.local/bin:$PATH"` (with fish syntax for fish). The launcher runs `node` from
PATH, so a Node upgrade does not break it. A re-run with the same build changes
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
- Node 22 or later on PATH; `rer` stops with one line naming the minimum on an
  older Node.
- For `install.sh`: `curl` and `tar`.
- For `rer dev` in a checkout: the checkout's own package manager (pnpm for
  Run Edit Run seeds).

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

or `RER_SIGN_IN <outbox>` for a seed that signs in through its development outbox.
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
`rer` supplies them only to checkouts whose pinned copy applies lower defaults
or does not report its own (`rer describe` reports `defaults`), so a current
checkout never records a limit you did not set.
A start is never refused for machine load alone unless `RER_SERVERS_LOAD_THRESHOLD`
or `RER_JOBS_LOAD_THRESHOLD` is set; memory and disk guards stay.

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
| `@runeditrun/rer/modules/operator-auth`, `/dev`, `/dev/badge`, `/dev-admission`, `/accounts/native`, `/identity/email-link` | operator auth | `scripts/base-cli/modules/operator-auth/index.mjs`, `dev/index.mjs`, `dev/badge.mjs`, `dev-admission.mjs`, `accounts/native.mjs`, `identity/email-link/index.mjs` |
| `@runeditrun/rer/modules/erasure/fence` | erasure fence statements | `scripts/base-cli/modules/erasure/fence.mjs` |
| `@runeditrun/rer/modules/owner-claim`, `/modules/dependencies` | owner claim, dependency links | `scripts/base-cli/modules/owner-claim/index.mjs`, `dependencies/index.mjs` |
| `@runeditrun/rer/internal/PATH` | any other package file, for tests | `scripts/base-cli/PATH`, and `scripts/base-onboarding/PATH` with PATH under `onboarding/` |

## Verbs

In a checkout, every verb runs that checkout's own pinned `rer`; `rer VERB --help`
there lists its flags:

`install`, `setup`, `dev`, `preview`, `build`, `verify`, `reset --yes`, `deploy`,
`export`, `import`, `outbox`, `doctor`, `describe`, `check`, `release`,
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
