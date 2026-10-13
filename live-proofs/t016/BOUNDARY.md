# T016 execution boundary and independent Linux gate

The public tags remain unmodified. The literal public deploy command copies its
environment and unconditionally executes a real build. A clean child environment
alone is inadequate because candidate code could read the parent's process or
modify its filesystem. The approved mediator places that real child execution in
a separate unprivileged container. It mediates execution, not success.

## What runs where

| Executor | Authority and files | Real commands |
| --- | --- | --- |
| Host controller | Reviewed Base code; public Git clone; scoped provider inputs; Docker API. No candidate package code executes here. | Public Git clone/fetch/checkout/merge; bounded direct provider readbacks; container orchestration. |
| Build container | Private PID namespace, UID 10001, read-only root, no capabilities, no-new-privileges; writable private tmpfs; only public source mounted read-only; no host/controller/broker/Docker mounts or provider environment. | Real pnpm 10.12.4 install --frozen-lockfile, followed by the original real pnpm build. |
| Deployment container | Reviewed Node/pnpm/Wrangler image; original public scripts copied from a read-only source mount; private credentials; broker socket. Candidate dependencies are absent. | Real pnpm run setup -- --remote and pnpm run deploy -- --remote. The mediator routes only the original build child; real Wrangler executes all provisioning/migrations/upload. |
| Browser container | Separate UID/PID/filesystem; reviewed Playwright; only reviewed browser harness mount and generated scoped application inputs on stdin. | Real Chromium against hosted widget and operator pages. |
| Receipt runner | Fresh Actions runner, only the reviewed controller checkout and evidence-write token. | Fixed-schema validation and durable Git append/CAS. |

The deployment image's /mediator/pnpm routes the public deployment script's
single argv [build] through a Unix socket; the host always executes the actual
build in the build container and returns its exit code. Other allowed invocations
execute /opt/trusted/bin/pnpm and the reviewed Wrangler distribution. No fake
package manager, provider reply, no-op success or skipped migration exists.

The source mount is read-only. Build processes cannot mutate it or the controller.
After build, the entire build container is paused. A bounded regular-file archive
handoff is validated for path/type/duplicates and configuration equality before
being copied into the controller. The copied dist files are owned by root and
readable by UID 10001, preventing that UID from rewriting their bytes. Wrangler's
no_bundle mode is required from the actual emitted config, not added as an
override. A different emitted contract fails for review rather than falling back.

## Runtime preparation (independent Linux, no provider inputs)

No registry is required for the independent gate. The parent supplied this verified
linux/amd64 Node 26.8.1 bookworm-slim manifest from its independent runtime
preparation; this worker did not fetch it or build an image. The script refuses
mutable tags and Mac execution and explicitly builds linux/amd64. Prepare an
empty output directory:

```sh
mkdir -p /tmp/t016-runtime-review
env -i PATH="$PATH" HOME="$HOME" TMPDIR=/tmp \
  T016_NODE_BASE_IMAGE='node:26.8.1-bookworm-slim@sha256:27f5e13512830beb5d9a574108daa6701a0a0b91528aeaf1ee84ecdcddaeeaae' \
  node live-proofs/t016/build-runtimes.mjs /tmp/t016-runtime-review
```

Review controller-dependencies.json, build-dependencies.json and
browser-dependencies.json plus the built image contents. The Node base and
controller pnpm/Wrangler closure are trusted tooling; an image digest or the
public product lock alone is not a dependency trust review. The Dockerfiles pin
the direct pnpm/Wrangler/Playwright versions; the generated dependency inventories
and final image IDs identify the complete resolved closure to review. Rebuilding
can resolve a different transitive closure and requires renewed review.

Then copy the three actual local image IDs from runtime-images.json into the
following environment. Run against the exact candidate commit with no provider
inputs and an empty GITHUB_OUTPUT file:

```sh
env -i PATH="$PATH" HOME="$HOME" TMPDIR=/tmp RUNNER_TEMP=/tmp \
  GITHUB_ACTIONS=true GITHUB_RUN_ID=1 \
  CONTROL_SHA='<exact-candidate-40-character-sha>' \
  GITHUB_OUTPUT=/tmp/t016-isolation-output \
  T016_CONTROLLER_IMAGE='sha256:<actual-controller-id>' \
  T016_BUILD_IMAGE='sha256:<actual-build-id>' \
  T016_BROWSER_IMAGE='sha256:<actual-browser-id>' \
  node live-proofs/tests/isolation-linux.mjs
```

The adversarial test fixture runs through real pnpm install lifecycle and build.
It checks parent/controller environment invisibility through /proc, inaccessible
controller/broker/Docker/host paths, source/root immutability, and unchanged
controller state. Runtime version checks are real executions. It cleans every
container it creates. A failure yields no attestation.

The parent must additionally inspect and exercise the real mediator with the
pinned public source on Linux, including a failing real build (no later
migration/upload), emitted-config compatibility, immutable handoff, hosted
browser behavior and actual Cloudflare multipart/version/asset readback. These
are not claims made by source tests. Provider-free Linux verification should
precede any credential-bearing execution. Hosted proof still waits for the
throwaway account and selected sender/mailbox inputs.

## Hosted binding

For fresh hosted runners, make the same reviewed images available by an approved
immutable registry reference or preloaded content-addressed image. This change
does not publish images. The current hosted allowlist accepts the three explicit
runeditrun GHCR roles; local sha256 IDs require the exact images to be present.
Mutable tags and arbitrary registry references fail. The Actions isolation job
receives no provider Environment and binds its result to the exact three image
references and controller SHA; the privileged job requires that attestation.
No owner exception to the public source or command semantics is used.

Container failures/timeouts remain failed executions. Containers are labeled with
the run/attempt and removed on normal completion, controller signals, and the
workflow's always cleanup step. Hosted resources remain for independent review;
the harness never erases data or attempts a destructive cloud rollback.
