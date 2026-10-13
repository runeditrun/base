# Seed launcher

A portable, dependency-free Node package that acquires one of the supported
seed editions and opens its existing standalone setup. It needs Node 22+ and
Git, but no prior clone, fork, GitHub account for public source, or application
dependencies. This is an optional seed convenience path, not a generic
importer or a management admission mechanism for independently authored
software.
Private source still requires access through existing Git authentication.

**This package is unpublished.** The catalogue points to the real HappyToHelp,
Lamp and Orbit repositories. Ferry and Beacon are retired and require an explicit source. Their current remote revisions may not yet contain
the locally developed onboarding files. A missing installer stops with a clear
error; the launcher does not substitute another revision or application.

## Run the local package

From this directory, create the portable package:

```sh
npm pack --pack-destination /tmp
```

Then install that tarball from any ordinary working directory:

```sh
npm install --global /tmp/runeditrun-seed-launcher-0.1.0.tgz
rer-setup happytohelp --directory ./my-help-desk
```

The installed package is independent of the Base checkout. You can also unpack
the tarball anywhere and run its Node entry directly:

```sh
node /path/to/package/bin/rer-setup.mjs ferry --repository /path/to/ferry --directory ./my-ferry
```

For development, the equivalent entry is `node launcher/bin/rer-setup.mjs` from
Base. There is no published `npx` command to use yet; publication is separate work.

## Select source and setup options

```sh
rer-setup beacon --repository /path/to/beacon --ref <branch-tag-or-commit> --directory ./my-beacon
rer-setup ferry --repository /absolute/path/to/committed-ferry --directory ./my-ferry --no-open
rer-setup happytohelp --repository git@github.com:just-every/run-happytohelp.git --directory ./my-help-desk
rer-setup happytohelp --directory ./my-help-desk --resume --agent
```

Active defaults are `happytohelp`, `lamp`, and `orbit`, mapped to
`just-every/run-happytohelp`, `just-every/run-lamp`, and `just-every/run-orbit`.
The retired `ferry` and `beacon` IDs require `--repository` for a fresh setup;
`--resume` continues to use an existing launcher's recorded source. `--repository` explicitly selects trusted replacement
source for that seed. HTTPS, SSH, `file://` and local Git paths are accepted.
Credentials must not be placed in repository URLs; use Git authentication.
Selected source executes its own `scripts/install.mjs`, so custom source needs
the same trust you would give a manually cloned repository.

Without `--ref`, acquisition uses the remote HEAD actually fetched by Git.
`--ref` selects a branch, tag or commit and records its resolved commit. Local
repositories supply committed bytes, including when their working tree has edits.
There is no automatic ref fallback, dependency installation or app deployment.

`--agent`, `--no-open`, `--no-prefill`, `--port`, `--answers` and
`--secrets-stdin` pass to the edition installer. Relative answer-file paths resolve
against the directory where you invoked the launcher. The answers file follows
the edition's nonsecret answer schema. With `--secrets-stdin`, pipe the edition's
secret JSON from an approved secure source; stdin goes straight to the installer.
The launcher does not read or persist it. Do not put secrets in arguments or files.
The browser journey offers the existing connected-agent handoff and requires
owner approval before the edition adapter installs or deploys anything.

## Keep and resume your product

The default destination is `./<seed>`, a durable private directory, not a temporary
cache. Acquisition creates it exclusively and refuses every existing path. A
failed acquisition removes only the new directory it created. Once acquisition
finishes, installer failures and terminal shutdown leave the checkout intact.
Normal SIGINT/SIGTERM cancellation stops the owned Git command before cleaning
the new acquisition. A forced termination can leave an incomplete directory without a
receipt. Inspect and remove that incomplete checkout yourself, or choose a new
destination; the launcher will not treat it as a resumable installation.

The checkout retains full Git history, the upstream `origin`, an editable
`rer-owner` branch, and the initial source commit at `refs/rer/setup-base`.
`.git/rer-setup.json` is a mode-0600, nonsecret receipt containing the selected seed,
repository, requested ref, actual commit and creation time. No fork is required;
publishing the owner's changes remains a later choice.

Use the same seed and directory with `--resume` to reopen the saved edition
session. Resume verifies the receipt and retained base commit, then runs the
installer in place. It does not fetch upstream, change HEAD, clean files or reset
customisations. Optional `--repository` and `--ref` on resume must match the saved
selection. The edition owns its saved answers in `.seed/installer`; secrets must
be supplied again. `--no-prefill` is for a fresh session and cannot be combined
with resume, answers or secret input.

Keep this checkout: it is the owner's editable source and update baseline.
Remote application deployment stays with the edition's existing adapter. A fully
hosted setup runner is separate future work.

## Verification

`npm test` runs focused acquisition, provenance, input and resume checks.
`npm run test:acceptance` exercises real sibling editions and the packed executable
from this workspace. The package
contains only the executable, its small library modules and this guide; no Base
checkout, downloaded editions or installed application dependencies are bundled.
Acceptance should use real committed edition copies until the corresponding
onboarding revisions are published. Local setup verification does not prove cloud
deployment or public catalogue readiness.

For reproducible release preparation, select the exact candidate commit with
`--ref <full-commit-SHA>` and its trusted source with `--repository`. Unpublished
local candidate commits are not available from the public catalogue until they
are explicitly published. The interactive installer is separate from a project
manifest’s noninteractive `operations.setup` dependency/tooling preparation.
Opening the UI has no installation authority; explicit Start invokes the product
adapter. A managed target must use the authenticated RER-owned handoff; local
installer cookies and CSRF tokens are never credentials for remote management.
