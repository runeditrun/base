# Standalone qualification

This implementation is source work, not executed hosted evidence. T016 runs from
Base main through the existing immutable-source gate, with the validated source
SHA equal to the workflow/controller SHA. The three public proofs use fresh
public source at v0.2.1 `59c6e2e1beb321e9f1cb5493efd05e20fc068638` or v0.2.0
`3b34df590cff61358afc07ab56ea886461ca74fd`. Tags are fetched and resolved again.

| Proof | Required outcome |
| --- | --- |
| t016-r2-off | Run locked installation and the actual public remote setup. Record the real R2-disabled status/code and require setup to fail. This is deliberately a failed qualification with `r2-disabled-confirmed`. |
| t016-r2-on | Public installation/setup/deploy, serving-byte association, owner claim, actual widget/operator browser reply with socket replay and reload, R2 attachment readback, SendGrid and independent recipient mailbox readback. |
| t016-upgrade-rollback | Perform the full initial journey on v0.2.0, merge v0.2.1, install/setup/deploy, then check out v0.2.0 and repeat. Preserve representative D1 rows, immutable migration bytes/ledger, R2 media and owner login/UI access throughout. |

The literal `node scripts/qualify-standalone.mjs --seed happytohelp` is the
Actions command used for the full R2-on proof. It requires the main-dispatched
environment and the prior Linux isolation attestation. Mac invocations fail
before provider access. No private HappyToHelp tree, local provider login or model
credential participates.

## Process and filesystem boundary

The original public deploy script always builds and inherits its parent's
environment. It is unchanged. Its real `pnpm build` child is routed by a reviewed
execution mediator into a separate Docker container; see [BOUNDARY.md](BOUNDARY.md).
The mediator executes real pnpm, returns its actual exit, and never skips a build
or simulates Wrangler. Actual declared setup/deploy argv, migrations, upload,
secrets-file handling and health checks still run from the pinned public scripts.
Only the isolated build sees candidate installed dependencies. It has no provider
credentials, controller filesystem, host PID namespace, Docker socket or broker
socket. The controller has independently reviewed pnpm/Wrangler tooling.

The build's PID namespace is paused before reading its output. A strict archive
reader rejects links, devices, path traversal, duplicate entries and unsafe metadata
overrides. Only validated regular artifact files pass into the controller. The
configuration must retain the prepared target/bindings and disable rebundling.
Worker download bytes and every published static asset must match that exact
build, between two readbacks of the exact version reported by the real upload.
An unrelated recent deployment cannot qualify.

The credential-free `isolation` job must pass before the execution job can attach
to the live-proof Environment. It tests real pnpm installation lifecycle/build
code against environment, process and filesystem isolation. The attestation binds
the controller SHA and all three runtime image digests. The independent gate must
also review the runtime dependency closure and run the actual public builds;
source tests do not establish Linux or Cloudflare protocol success.

## Inputs still requiring selection or provisioning

Use the already provisioned Base Environment `SENDGRID_API_KEY`; the workflow
maps it to the controller's internal `T016_SENDGRID_API_KEY`. Do not provision a
duplicate key. Other Environment inputs are `CF_THROWAWAY_API_TOKEN`,
`CF_THROWAWAY_ACCOUNT_ID`, `T016_SENDGRID_FROM` (a verified sender),
`T016_TEST_MAILBOX` (dedicated test recipient) and the separate writer's
`EVIDENCE_WRITE_TOKEN`. The runner generates the owner/setup passwords privately,
retaining only the owner password in memory through upgrade and rollback.

The owner has not selected a mailbox adapter. `T016_MAILBOX_ADAPTER` is an
explicit nonsecret selection; no selection is a failed pending input, even if a
Gmail token exists. The implemented choice is `gmail`, with
`T016_GMAIL_ACCESS_TOKEN` scoped to Gmail read-only for that exact test mailbox.
An alternative mailbox requires a reviewed `snapshot()` / `readNew()` adapter:
authenticate the intended inbox, snapshot IDs before sending, require a new
message after the send with matching sender/recipient/subject/body and the unique
delivery correlation, and return only mailbox/provider identifiers, arrival time
and content digest. SendGrid remains the sender regardless of mailbox choice.

Gmail is supported, not assumed to have been chosen. Its readback polls at most
55 seconds; sends are never retried. Actual sender/mailbox/readback credentials,
throwaway account/R2 state and hosted receipts remain owner pending.

`T016_CONTROLLER_IMAGE`, `T016_BUILD_IMAGE`, and `T016_BROWSER_IMAGE` must be
reviewed immutable image references. Independent Linux preparation accepts local
`sha256:<64-hex>` image IDs. Hosted runners can use approved
`ghcr.io/runeditrun/t016-<role>@sha256:<64-hex>` references. No image digest is
invented or published by this change. [BOUNDARY.md](BOUNDARY.md) provides the
credential-free preparation and gate commands; registry publication is separate.

## Real browser and data checks

The browser container receives only the hosted origin and generated scoped
application/test inputs on stdin. It hosts an ordinary loopback page containing
the real remote widget script, configured as the project's allowed website
origin. It sends visitor content and a file through the actual widget, signs the
owner in at /login, opens the real conversation UI, reads that content and sends
a reply through the operator composer. The widget must display the reply, receive
its socket event, reload and observe replay with the same conversation/contact.
Replay must match the original event ID, message ID and content digest, and the
widget must display the reply after that replay event. An authenticated API read
also requires the exact persisted visitor and owner messages. The operator
transcript must survive reload. Startup exceptions fail the journey.
The widget is checked at 1440 and 390 pixels; no interception or application
fixtures are used. Browser state/cookies/tokens never enter evidence.

D1 readback covers the owner, project, membership, contact, conversation, messages
and attached media rows created by that journey. It excludes credentials/session
hashes. Before recording the initial baseline, the two D1 messages must match the
journey's distinct stable message IDs, conversation ID, visitor/owner actor IDs
and roles, exact request/reply content and its recorded hashes. The journey's
conversation and content hashes must also agree with its own retained fields.
Applied migration source bytes and the complete id/name/applied_at ledger
must stay unchanged; these two public releases have no SQL delta. The declared
migration steps still execute on every setup/deploy. Rollback is code-only:
`git checkout --detach <v0.2.0-SHA>`, install, setup, deploy; no ledger deletion or
reverse SQL. The actual update is `git merge --no-edit v0.2.1`. Owner API login and
UI access, D1 rows and authenticated R2 bytes are checked after each move.

## Receipts and generic descriptors

Version-2 qualification observations carry fixed, nonsecret facts as well as
their digest: origin, Worker/database/R2/queue/deployment/version identities, source/build
association, owner/project/conversation/message IDs, content/correlation hashes,
SendGrid/mailbox IDs and the R2 error code. Initial, upgraded and rollback serving
identities remain distinct. Arbitrary fields, logs, headers, tokens and cookies
are rejected. The fresh writer alone receives EVIDENCE_WRITE_TOKEN; append/CAS,
fixed paths, read-only source tokens, and failure persistence retain the T002b
contract. Store failures remain failures.

The generic v1/v2 CLI routes actual argv, cwd and explicit remote selection through
a [reviewed adapter and Linux executor](../standalone/README.md). Declared provider
inputs reach only the reviewed deployment closure; arbitrary source/dependencies
execute in the separate credential-free build. The CLI never imports a seed-local
journey into the host. Its generic success cannot manufacture the fixed T016
receipt or substitute for its browser acceptance.

Local source checks:
`T016_TEST_TMP=<short session scratch> T016_PUBLIC_REPOSITORY=<local public Git source> PLAYWRIGHT_SKIP_BROWSER_GC=1 node --test --test-concurrency=1 scripts/qualification/*.test.mjs live-proofs/tests/*.test.mjs`.
The original 31 tests remain immutable. Five assertions describe superseded
hash-only/REST-only/implicit-mailbox/secret-name/R2-fixture contracts; their exact
conflicts and proposed corrections are reported separately, without editing
those tests or claiming all-green. The added repair tests cover the new contracts.
The initial D1 binding also makes the older incomplete snapshot fixture stale;
its exact correction is proposed separately, with its continuity and lost-media
assertions retained. Originals remain unchanged pending independent review.
