# Credential-free Linux qualification

Run on the ordinary private Base pull-request workflow:

```sh
node live-proofs/tests/linux-ci/run.mjs --output "$RUNNER_TEMP/t016-linux-results"
```

The runner requires the event's private, same-repository `runeditrun/base` PR head,
records that exact checkout and the separate workflow/controller revision, and
checks the independently passed source/security commit is an ancestor. The
source-gate declaration comes from the root's assignment; it is not a new gate
verdict produced by this runner. No provider authorization follows from a pass.

The workflow uses a read-only checkout credential only in checkout, removes Git
credential/header configuration, and starts the runner with an explicit empty
base environment. Public Git operations have isolated HOME/config and no helpers.
No dependency cache, Environment, OIDC, provider command, registry push or token
is used. The Actions artifact client runs separately from source execution.

Each container's `/seed` is a distinct run-labelled local-driver volume backed
by tmpfs, with UID/GID 10001, nosuid/nodev and a 6 GiB bound. This keeps the actual
paused build bytes visible to Docker's archive view; `--tmpfs` creates a separate
empty mount in that view. The read-only root, private PID namespace and read-only
source mounts remain enforced. Inspections require the exact tmpfs options and
distinct controller/builder volumes. Container removal and final scoped cleanup
remove the volumes and assert none remain.

The committed three Dockerfiles build from the fixed Node manifest. The runner
retains actual Docker build logs, context hashes, image inspection, installed npm
locks/closures, Debian packages, executable and browser hashes. These are observed
transitive dependencies, not a claim of reproducible locking or trusted closure.
The transparent build-log recorder executes the actual Docker binary with the
same argv and preserves its status; it supplies no command result.

The unchanged native Linux tests run first. Additional randomly named synthetic
fixtures execute the real reviewedExecutor and Containers implementation, real
pnpm lifecycle and build commands, literal declared shell argv/cwd, committed Git
blobs despite dirty/ignored files, namespace/capability/mount probes, paused
mutator handoff, controller byte comparison and removal ordering. Instrumentation
only records real results and disconnects these package-free fixtures. Synthetic
credentials remain in memory/private temporary fixtures; evidence retains their
hash and explicitly sanitized inspect fields. Negative install/build/archive/
configuration/browser cases require the actual inner rejection and preserve raw
results. Nothing here simulates a publication or provider receipt.

Public HappyToHelp v0.2.0 and v0.2.1 are independently acquired from the public Git
repository, verified against tag/commit/tree/archive pins, and copied from Git
objects. Both native installs/builds run inside the actual build image. During
installation the builder has only an internal Docker network and a CONNECT
gateway limited to the two named public npm registries. Its external route is
removed before native build. Generated config uses committed public configuration
with synthetic resources and an `.invalid` origin. Setup, deploy and provider
commands are never executed. Emitted configuration and inert output are checked
with actual validateBuildConfig/buildIdentity/unpackArtifact and compared in a
separate controller. A failed native install/build is a failed proof, never a
substitute build.

The expected native configuration declares the pinned Wrangler/Vite closure's
exact inert defaults and configuration-path metadata separately from the input
file. The strict production validator compares every declared default and rejects
undeclared fields, changed bindings, and executable publication configuration.

Actual installed Chromium launches headlessly, loads each actual built widget
script on an ordinary local page, verifies JavaScript and pageerror observations,
and captures 1440/390 JPEGs. It does not initialize a widget against a fictional
backend. This narrow browser smoke does not claim login, media, sockets, replay
or replies. The real runBrowser/browser-entry rejects invalid origin and forbidden
environment inputs; its controller mount is a fresh committed snapshot without
`.git`.

`receipt.json` hashes every other retained observation file (`receipt.sha256`
separately hashes the receipt to avoid a self-referential hash). Each proof records
its actual runner argv and links a proof row; detailed subprocess argv, cwd,
timestamps, exit status and outputs are in `raw/`. Every required proof and
evidence family must be present before pass. Non-Linux invocation records
`incomplete`/`pendingLinux` without probing Docker. Missing prerequisites remain
incomplete; assertions remain failures. Scoped cleanup always runs and failure
cannot become success through cleanup.

Subprocess text streams over 16 KiB, native dependency inventories and installed
locks, source manifests and runtime inventories use lossless gzip storage. Raw command metadata records each stream's
encoding, uncompressed size and SHA-256, while the receipt hashes the retained
compressed bytes. Decompress `.gz` files to inspect the complete observations;
neither output nor required evidence is truncated to fit the report limit.

Image custody is separate: actual `docker save` output is capped at 4 GiB, split
into chunks under 50 MiB, and hashed in full and per chunk. The second private
Actions artifact retains these exact images for seven days. The report bundle
stays below 100 MB with individual files below 50 MB. A pass says custody was
prepared for upload; the workflow must successfully upload it and root must
independently verify the run identity, conclusion, artifact digest and loaded image
IDs. Unlocked rebuilds do not establish custody of this run's images. Download the
private image artifact, verify `manifest.json` chunk/full hashes, concatenate the
ordered parts, then `docker load` on the independent Linux gate. The root supplies
that gate; no independent gate is fabricated here.

Local checks (no Docker or provider access):

```sh
node --test live-proofs/tests/linux-ci/controls.test.mjs
actionlint .github/workflows/t016-linux-qualification.yml
find live-proofs/tests/linux-ci -name '*.mjs' -exec node --check '{}' ';'
```

The original T016 acceptance remains pending separately: hosted health/widget
200, real owner claim and reply receipt, actual throwaway-account
`node scripts/qualify-standalone.mjs --seed happytohelp`, Base main verify,
v0.2.0→v0.2.1 upgrade/rollback, independent runtime/source review, and the private
HappyToHelp docs/install PR after T020. This job does not complete those outcomes.

The public-source path repair permits committed native route filenames such as
`src/routes/_dashboard._workspace.$.tsx` without aliases. Each acquisition still
requires a separate production `snapshotSource` controller-source proof; a failure
prevents overall qualification passing. The test-only Git-blob materializer
independently verifies canonical paths and SHA-1 object/SHA-256 file bytes for the
native-build proof. It does not substitute for the controller snapshot proof.
