# Generic standalone qualification boundary

The generic CLI accepts declared provider inputs through a reviewed Base adapter:

```sh
node scripts/qualify-standalone.mjs --seed happytohelp \
  --directory /path/to/public-v0.2.1-clone \
  --adapter happytohelp-v021 --origin https://t016-RUN-ATTEMPT.ACCOUNT.workers.dev \
  --widget-path /widget.js --target remote
```

Run only in the main-dispatched Base live-proof environment on Linux with the
existing exact controller/image isolation attestation. This change does not add
workflow dispatch inputs, publish runtime images or authorize deployments. The
controller checkout must be clean and its actual HEAD must equal CONTROL_SHA.
The adapter module must be committed under `live-proofs/standalone/adapters/`.
A seed-local `--journey` module is no longer loaded into the credential-bearing
host. Seed names do not select executable source on their own.

The generic executor supports OPERATIONS v1 and v2 argv arrays, explicit shell
argv, a checkout-relative command cwd (default `.`), and the existing explicit
`--local` to `--remote` selection. It resolves setup and deploy before effects.
The public command arrays execute unchanged inside `/seed/<declared cwd>`.
No package manager or provider is selected by the generic engine.

## Review contract

Each adapter exports `adapter` with these fields:

- `seed`, `sourceSha`, `descriptorSha256`: selected seed and immutable source and
  descriptor identity. `controllerFiles` maps the complete reviewed deployment
  code/configuration/SQL closure to SHA-256 hashes. Only these files are available
  to credential-bearing source execution; installed candidate dependencies and
  the rest of the candidate source are absent from that container.
- `controllerDirectories`: optional explicit source directories recreated empty
  in the controller. They grant structure only; their children are never copied
  recursively. Paths must be safe, unique, real directories in the source snapshot
  and separate from reviewed files and build outputs.
- `requiredEnvironment`: explicitly reviewed inputs, including every name in the
  descriptor and any prerequisites documented outside it. `deploymentEnvironment`
  and `journeyEnvironment` separately select the inputs needed by those phases.
  Controller/injection/evidence environment names are refused. A missing input
  fails; arbitrary parent credentials are never inherited by Docker or a build.
- `builds`: the exact child argv and cwd to mediate, actual installation argv,
  output directory and reviewed public build environment. `publicEnvironment`
  may select explicitly reviewed nonsecret deployment inputs (such as account ID
  and target name); names containing token/secret/key/password/credential are
  forbidden. A pure `environment(publicInputs)` mapper may derive configuration
  paths. Review must establish that these values contain no provider authority.
- `tools`: the immutable image executable for each mediated executable and the
  allowed provider argument prefixes. Exact public setup/deploy invocations are
  also admitted. Every other invocation of a mediated executable fails.
- `prepareBuild({index, publicInputs, readFile})`: optional reviewed transfer of
  generated nonsecret configuration from the controller. It returns bounded
  regular `{path, bytes}` inputs. The build cannot choose controller read paths.
- `validateArtifact({root, files, prepared, index})`: mandatory target/configuration
  and artifact validation. Files are extracted under a canonical `dist/` prefix
  regardless of the project's declared output name. The adapter must establish
  that the real publication tool consumes those files as inert bytes and does
  not rebundle, import or execute them with provider authority. Any additional
  privileged hook/dependency is part of the controller review, never part of an
  arbitrary source/dependency installation.
- `validateInputs(env, {origin})`: optional reviewed semantic validation before effects.
  `qualify({origin, env, commands, artifacts, browser})` drives actual hosted
  acceptance using reviewed code and the isolated real browser. Command output
  remains private memory; it is never printed or included in the generic success
  message. A generic run does not manufacture a fixed-schema T016 receipt.

An adapter is executable authority, not a self-asserted declaration from a seed.
A new adapter, its complete privileged source/tool closure and its artifact
validator require independent review and an exact-revision Linux check before
credential-bearing use. The source pin alone is not that review.

## Isolation and concrete profile

Committed Git blobs are copied into a fresh source snapshot. Ignored/untracked
files, the Git store, symlinks, submodules, devices and other nonregular entries
are never mounted. The build sees that snapshot in its own unprivileged Linux
container, with no provider environment, controller/broker mount, host PID
namespace or Docker socket. Each broker request performs the real installation
and build and propagates their exit status. A failed install cannot run a build;
a failed build cannot hand off files or complete publication.

After success the full build PID namespace is paused. The existing strict tar
reader accepts only bounded regular output files. The reviewed validator checks
those exact bytes before root-owned output is copied into the deployment
container. All containers and broker sockets are closed on normal completion or
failure; there is no direct-execution fallback.

`happytohelp-v021` is a concrete proposed profile for the actual public
59c6e2e1beb321e9f1cb5493efd05e20fc068638 source. Its JSON pins 53 original public
deployment/configuration/migration files. It uses real pnpm/Wrangler, validates
no-bundle output and unchanged bindings, checks serving module/static-asset bytes,
and runs owner claim, hosted widget/operator/socket/reload/attachment proof,
durable transcript/mail readback and the independent selected Gmail inbox check.
It requires the public deployment environment names plus explicit
`MAILBOX_ADAPTER=gmail`, `TEST_MAILBOX`, and `GMAIL_READONLY_TOKEN`; it never chooses
an inbox merely because a token exists. Mailbox inputs are not passed into the
deployment container. The profile is constrained to t016 run/attempt workers.dev
targets, registration off and SendGrid delivery. Hosted approval and actual
credentials remain separate inputs. The existing T016 R2-off, R2-on and
upgrade/rollback runners retain their public source and commands.

The profile also declares `src/modules` as an empty controller directory: the
unmodified public migration collector unconditionally reads that directory.
All 37 migrations are already among the 53 file pins. No module code is added to
the privileged closure. The collector regression reads the exact public Git blobs
from a supplied local repository and executes the actual collector, without a
provider command.

## Verification

Source/protocol fixtures (no provider calls):

```sh
T016_TEST_TMP=<short-session-scratch-path> PLAYWRIGHT_SKIP_BROWSER_GC=1 \
  T016_PUBLIC_REPOSITORY=<local-git-repository-containing-public-v0.2.1> \
  node --test --test-concurrency=1 scripts/qualification/*.test.mjs live-proofs/tests/*.test.mjs
```

The short scratch path keeps Unix sockets within OS path limits. Serial test
files avoid collisions on the browser harness's fixed allowed widget-host port.
The new browser negatives distinguish no initial frame, corrupt initial content,
no replay, corrupt replay with the same message ID, different replay event ID,
missing widget/operator reload content and missing/changed durable messages.
They also preserve accepted-SendGrid-but-missing-durable-row failure coverage.

Provider-free real Linux integration, with the already reviewed content-addressed
images available to that runner:

```sh
RUNNER_TEMP=<short-empty-scratch-root> \
  T016_CONTROLLER_IMAGE=<reviewed-image> T016_BUILD_IMAGE=<reviewed-image> \
  T016_BROWSER_IMAGE=<reviewed-image> \
  node live-proofs/tests/standalone-isolation-linux.mjs
```

This real integration fixture executes a declared credential-bearing Node setup,
a literal shell deploy from a nested cwd, and real credential-free install/build
through the same broker. Its hostile build checks `/proc`, immutable source/root,
and absence of controller/broker/Docker authority. It uses no provider or remote
application. The tests with Docker protocol fixtures are not Linux runtime proof;
actual public-source builds and hosted acceptance still need their own run.
