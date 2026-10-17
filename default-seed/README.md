# Default seed reference

`pnpm typecheck` (also run by `pnpm run verify`) uses incremental build mode
with checkout-local, gitignored `.cache/typecheck.tsbuildinfo`; deleting it
forces a full check, while `pnpm run build` builds the real Worker and assets.

## Run it locally

Install the `rer` command once with the installer script on the RER site
(`curl -fsSL https://runeditrun.com/install.sh | sh`, which brings its own Node
when there is none), or with `npx -y @runeditrun/rer cli install` when Node 22
or later is on PATH.
From this seed's root, `rer dev` alone launches it: it installs dependencies,
sets up a local owner on a free port, starts the app and prints `RER_READY` and
a sign-in link. To install for a real owner, run the verbs yourself:

```sh
rer install
rer setup
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
`dev --as PERSONA` starts as a persona or signed out. Until first-run
completion is stored durably, app routes send the signed-in owner to `/setup`;
signed-out visitors sign in and return there. Once complete, `/setup` opens the
app or settings. Development and demo silently suppress application mail.

In dev and demo, invite a person and choose **Sign in as <name>** in operator
access or at `/signin`. The same one-click entry opens `/app` with their assigned
role. Each local browser profile first opens `RER_OPEN` for the checkout key
cookie. Mail is silently suppressed; there is no email-reading step.

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
owner and origin preserves existing owner/data and exact private settings.
Conflicting saved identity or origin reports an actionable recovery path.
Review reset's exact removal inventory before confirmation; export domain data
first if it should be restored, and import only into an empty destination.

Queue waits report immediately with a reason and numeric one-based position,
then refresh about every 15 seconds while waiting. From the runnable project
root, inspect the live queue with
`node scripts/base-cli/modules/job-queue/cli.mjs status`.

## Run it on your computer

Use Node **22.20.0** and pnpm **10.12.4**. From this seed's root, the package
aliases below run the same verbs as `rer` with this seed's pinned copy:

```sh
pnpm run deps
pnpm run setup -- --owner-email you@example.com --port 8787 --non-interactive
pnpm run dev -- --port 8787
```

Setup builds the real app, applies local migrations, prepares the first owner,
and stops its temporary Worker. Dev serves Vite assets and HMR using the same
database and auth. Wait for `RER_READY`, then open `RER_OPEN` to enter signed in
as the owner. Its fragment holds the checkout key; treat the link as a credential.

To rebuild and restart, stop the managed foreground server before build or
verification with `pnpm run dev -- --stop` (or Ctrl-C), or stop preview with
`pnpm run preview -- --stop`:

```sh
pnpm run build
pnpm run dev -- --port 8787
```

To run setup again with the saved owner:

```sh
pnpm run setup -- --non-interactive
```

`--help` has no project effects; `--json` emits events and one result for bounded commands. The complete
`rer` command list and flags are in [RUN-LOCALLY.md](RUN-LOCALLY.md).
Managed foreground dev and preview support explicit `--stop` and
`--idle-timeout`; their first invocation stays active while serving, and a
compatible repeated invocation reuses the live server and exits. Stop a server
with `pnpm run dev -- --stop` or `pnpm run preview -- --stop` before running
build, verify, reset or data transfer.

The private `.dev.vars` file is mode 0600; reruns preserve its exact bytes.
Conflicting owner or origin answers fail before effects. Builds exclude and
restore private settings, including interrupted-build recovery. Canonical local
data is `.wrangler/state`; symlinked or ambiguous legacy state is refused. Reset
shows its exact inventory and requires `pnpm run reset -- --yes`; it removes
declared local data, owner, bookkeeping and generated settings while
preserving source, dependencies, archives and deployment receipts. It refuses
active local operations.

Local export/import uses the shared portability module for supported D1 domain
data, with explicit auth, credential and transient-state exclusions. Reset
preserves archives; import requires an empty destination and explicit
confirmation. Each first-party seed verifies export/import/export equivalence
across all supported resources. Remote transfer is unsupported and fails
visibly. Setup reads the single root `rer-setup.json` through the shared
manifest reader.

See [RUN-LOCALLY.md](RUN-LOCALLY.md), [OPERATIONS.md](OPERATIONS.md) and
[SEED-COMMAND-CONTRACT.md](SEED-COMMAND-CONTRACT.md) for current flags, exit
codes, deployment requirements and compatibility behavior.

## Reference runtime

This is a technical reference, not a finished product edition.

Local mode is for one user’s machine: a process with access to its private
settings and checkout key can sign in as the owner. It runs one Cloudflare Worker: Hono owns `/health`,
`/api`, and `/api/*`; shared operator-auth handlers own `/auth/*`; TanStack Start
owns documents and `/_serverFn/*`. Queue and scheduled exports remain on the
same entrypoint. `/` is the Lobby, the installed instance's homepage (Sign in,
or Finish setup until first-run setup is confirmed), rendered by the Worker from
`GET /setup/state`'s claim reading and `src/core/app/identity.ts`; its run site
(`src/site/`, `deploy-site.json`) is built by `rer build --site` and served by
`rer dev` as `RER_SITE`. The public record at `/records` is request-time D1 SSR, `/reference` is an
invariant prerender, and `/app` plus both private generated server functions
validate the shared D1 session independently.

## First owner and production configuration

The RER `setup` command creates the real first owner through operator-auth and
preserves an existing owner and data on reruns. Local dev opens signed in
through a real, key-gated dev session for that owner (`src/server.dev.ts` is the
local-only entry; `rer build` refuses output containing the dev layer). The
one-click development entry is exercised through the browser in
`tests/local-journey`; no external mail credential or static session is used. Setup and dev do not rotate secrets. Production
deployment uses the owner-account procedure described in
[RUN-LOCALLY.md](RUN-LOCALLY.md); configure `OWNER_EMAIL`, `AUTH_ORIGIN`,
`SESSION_SECRET`, `SETUP_TOKEN`, and mail settings through its private inputs.
Do not commit credentials or place them in browser configuration.

## Sign-in, mail and administration

For production, set `MAIL_PROVIDER` to `resend`, `sendgrid` or `cloudflare`,
`MAIL_API_KEY`, and `MAIL_FROM` to a sender verified at that provider, as a
bare address (`billing@example.com`) or with a display name
(`Your Business <billing@example.com>`).
Cloudflare additionally needs `MAIL_ACCOUNT_ID`. Sends use the actual
`modules/mail/index.mjs` facade in production mode. The explicit `development`
provider silently suppresses mail in development and demo. Production never
selects it after a remote-provider failure.
Missing or failing mail denies link issuance; bootstrap and existing-session
access remain independent of mail. Provider API acceptance does not establish
inbox delivery.

The sign-in screen requests a link with `/auth/magic-link`. GET and HEAD
`/auth/confirm?token=…` only preview; explicit POST confirmation consumes once
and redirects to the stored safe `returnTo`. The operator app includes
invitations, role/status management and session revocation. Every action is
authorized by the shared server policy. Native sessions last seven days and
links last 15 minutes by default, without sliding renewal. Role/status changes
invalidate existing sessions and links; reactivation does not resurrect them.
`/auth/signout` revokes the current session. Public errors contain fixed codes
and no credentials.

If mail is not working yet on a hosted install, or `OWNER_EMAIL` was mistyped,
run `rer signin --environment NAME` from the checkout that deployed it, with the
same Cloudflare credentials. It prints a one-time owner sign-in link that works
once, only for the owner, and expires within 15 minutes. Its use is recorded in
the owner's audit log. Signed in that way, correct the address under "Your
sign-in email" in Operator access.

Optional `AUTH_ALLOW_LIST` is a comma-separated additional email restriction,
including the owner when enabled. `AUTH_IP_LIMIT` and `AUTH_EMAIL_LIMIT`
override the shared durable fixed-window defaults (30/IP and 5/email per
15 minutes). `/api/work` and every unknown descendant authenticate before route
matching; `/api/public/feed` remains public. `/auth/*` exposes the documented
[shared HTTP contract](../modules/operator-auth/README.md).

For local review only, set `AUTH_REVIEW_ENABLED=true` and optionally
`AUTH_REVIEW_EMAIL` (defaults to the configured owner). POST
`/auth/review-session` issues a one-hour review session for an already-active
operator. Issuance and admission reject a non-loopback Host even with forwarded
headers. Disable this flag outside a loopback listener.

## Sign-in page and an optional Auth provider

`/signin` is Base's shared server-rendered sign-in page
([`createSignInHandler`](../modules/operator-auth/README.md#the-sign-in-page)),
answered by the Worker before the route renderer, so it works before
hydration. It offers the email link, the first-owner setup form while the owner
is unclaimed, and "Continue with Auth" when
the app is linked to an Auth install.

To link one, set the optional `IDENTITY_PROVIDER` setup answer to the install's
exact HTTPS issuer and supply a private one-use approval file through
`RER_LINK_TOKEN_FILE` (or the `RER_LINK_TOKEN_FILES` interface-to-file map for multiple dependencies). Setup claims the native owner first, then the provider
pulls the app's public dependency document. The application generates and retains
its own private link key; the completed link supplies the client ID and pinned
metadata. No private key belongs in setup answers. Blank provider input keeps
email links working alone. Existing installations remain off until their owner
enables provider sign-in at `/auth/settings/identity`; only the first successful
setup link enables it automatically. The shared provider network transport uses
workerd's manual redirect mode and refuses every 3xx.

The fixed link callback is `/.well-known/rer-link/callback`, and OIDC returns to
`/auth/oidc/auth/callback`. Re-link and unlink need fresh app-local owner proof;
provider identities do not grant membership or ordinary roles. An explicit
`idp` owner-claim setup mode can consume a verified single-use installation owner
grant. See [the application link protocol](../modules/dependencies/README.md) and
[identity providers](../modules/operator-auth/identity/oidc/README.md).

## Existing installations

`0002_operator_auth.sql` adds the operator-auth tables, including OIDC
correlations, while preserving existing operators, sessions, articles, jobs and
schedules. Existing legacy sessions do not authenticate. Preserve existing
operator rows for migration and audit; invite prior staff through the current
operator flow with explicit roles. No automatic import elevates historical
operator rows. Removing them is a separate owner data decision.

`0003_invitation_cancellation.sql` adds a durable record and guard for cancelled
pending invitations. Apply it before using `/auth/invite/cancel`; cancellation
invalidates outstanding links without deleting operator history and cannot be
reversed by the active-operator reactivation API. Keep this migration and ledger
when rolling application code back or pruning expired credentials.

## Personal data and erasure (reference example)

`people`, `person_notes`, `person_files` (bytes in the `FILES` R2 bucket) and
`audit_events` are a small example of an entity that holds personal data
(migration `0015_people.sql`). Seeds replace them with their own entities.
`src/core/features/people/erasure.ts` declares the entity for Base's
`modules/erasure`. Every route is same-origin and limited to owners and admins:

| Route | Effect |
| --- | --- |
| `POST /api/people` | Create a person (`name`, `email`, `details`). Sends a welcome mail through the configured mail provider. |
| `POST /api/people/:id/notes` | Add a note. |
| `POST /api/people/:id/files?name=FILE` | Attach the request body as a file. Its R2 key is opaque. |
| `GET /api/people/:id/export` | The person's own export, with file bytes. |
| `GET /api/people/:id/erasure` | Preview: counts only. |
| `POST /api/people/:id/erasure` | Erase. The body must be `{"confirmation":"erase <id>"}`. Answers 200 with the completed receipt, or 202 while it continues on the queue. |
| `GET /api/erasures/:id`, `POST /api/erasures/:id/resume` | Read or resume a receipt. The cron sweep also resumes unfinished erasures. |
| `POST /api/people/imports` | Import a list (`label`, `people: [{ref, name, email, details}]`) through Base import-kit. The label is the import's operation key; `ref` becomes the person's id. Creates the job without applying it. |
| `GET /api/people/imports/:id`, `POST /api/people/imports/:id/resume`, `POST /api/people/imports/:id/undo` | Read, apply (`{"batches":N}` applies N people) or undo an import. A retired import answers 410 with its journal `receiptId`. |
| `GET /api/erasures/journal` | The import erasure journal: receipt id, stores touched with row counts, time. No erased values. |

Erasure deletes the person, notes, files and their bytes, plus any historical
development mail stored for the person. Audit rows stay, relabelled
`erased:<random>`. Each deleted row is written to portability's erasure
journal, so `rer import` refuses an older archive that still
holds any of them. On a fresh destination, pass the latest archive as
`--journal FILE`. An old archive restored into a brand-new store without that
journal cannot be recognised.

Erasing a person also erases them from import custody (migrations
`0018_import_kit.sql`, `0019_people_imports.sql`,
`0020_import_erasure_append_only.sql`, `0021_import_preparation_steps.sql` and
`0022_import_stream_sources.sql`).
For an imported person the D1 erasure commits with import-kit's
`retireD1ImportCustody`: their
records become tombstones, so other people's imports still resume and undo, and
an import labelled with exactly their email is retired whole (its rows stay, its
undo and resume end). Matching is exact; a name is never used. Each erasure
appends one journal row, which nothing can rewrite. That batch also writes
portability's redaction checkpoint, so with `--journal` any archive made before
the erasure is refused whole, including one from while the person was still
pending in an import. Their ids also leave other people's imported reactions;
when those span more imports than one request rewrites, the erasure answers 202
and queues the next bounded step until it completes. The request and where its
redaction stands (job ids and revisions, never a value) are kept in
`person_erasure_redactions` (migration `0023_person_erasure_redactions.sql`),
so an erasure whose request or queued step is lost (a restart, a failed send)
is taken over by the cron sweep and finishes without being requested again;
repeating the request takes it over at once. The person's erasure deletes that
row.

## Verification

`pnpm run test:operator-auth` runs one-import shared conformance against the
real consumer auth routes and Hono private guard with real workerd/D1, followed
by emitted Worker integration/browser checks. Test-only outbound transports
capture provider requests; the production build contains no test routes. The
checks cover fresh setup, prior-data preservation, private HTTP and generated
server-function admission, replay/revocation, Queue/Cron behavior and browser
navigation.

`pnpm run verify` also invokes the rendering verifier using real operator-auth
sessions, then the local setup and browser journeys. This reference has no
BASE-ACCESS-002 baseline reporter registration mechanism; the transport matrix
is local test evidence, not a claim of a reported shared-baseline result.
Hosted secrets, provider delivery, real IdP login and deployment remain
separate checks.

## Managed local runtime

Use `rer preview` for fixed production output or
`rer dev` for live HMR. The first invocation stays in the
foreground. A compatible repeated invocation verifies the registered server,
prints readiness and exits. Stop with
`rer preview --stop` or `rer dev --stop`
before build, verification, reset or data transfer. Both retain the owner,
canonical local state. The default idle timeout is 12 hours and
the combined machine cap is ten servers. Bounded preparation uses the shared
heavy-job queue. See [RUN-LOCALLY.md](RUN-LOCALLY.md) for timeout, reuse,
capacity, sign-in and CI policy.

The typecheck stage of `pnpm run verify` uses checkout-local, gitignored
`.cache/typecheck.tsbuildinfo`; deleting it forces a full check, while
`pnpm run build` still builds the real Worker and assets.
