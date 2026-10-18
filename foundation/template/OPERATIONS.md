# Foundation operations

For a product that offers data move-in, sign in as the owner and use its import
screen. First step: open this path on the destination app:

```text
/app/import
```

Upload a supported source export, review the plan and its differences, then
approve that exact plan to apply it. Reconcile the result against native data;
use Undo from the same history when needed. Base's reference accepts people JSON
here, not installation `.rer` archives. Editions adopt this same door
with their own supported readers and native adapters.

This technical foundation has no product import screen or product data yet.
When adding data move-in, mount the shared door and build `/app/import` before
publishing that workflow; do not add a separate importer. Follow Base's
[door adoption guide](https://github.com/runeditrun/base/blob/main/modules/import-kit/src/door/ADOPTING.md).

Start a fresh copy with one line: `npx -y @runeditrun/rer dev just-every/run-foundation`
(set up only: `npx -y @runeditrun/rer setup just-every/run-foundation`; without
Node, `curl -fsSL https://runeditrun.com/install.sh | sh -s -- dev just-every/run-foundation`).
It clones, installs, sets up a local owner and starts the app; to start it again
later, run `cd run-foundation && rer dev`. Run all other first-party operations
from the composed, runnable edition checkout with `rer`. The detailed flags and
effects are in `RUN-LOCALLY.md` and `SEED-COMMAND-CONTRACT.md`.

To install for a real owner instead, run the verbs yourself inside the checkout:

```sh
rer install
rer setup --owner-email you@example.com
rer dev
```

Use the setup prompt instead of the owner-email flag when entering the real
mailbox. Open the printed `RER_OPEN` link to sign in as the owner. Development
and demo mail is silently suppressed. Stop `dev` with
`rer dev --stop` or Ctrl-C, and stop `preview` with
`rer preview --stop` before build or verification.

In dev and demo, invite a person and choose **Sign in as <name>** in operator
access or at `/signin`. The same one-click entry opens `/app` with their assigned
role. Each local browser profile first opens `RER_OPEN` for the checkout key
cookie. Mail is silently suppressed; there is no email-reading step.

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

Use `rer describe` to inspect the checkout's actual
capabilities. `rer check --profile first-party` validates the
declared command contract; it does not run application journeys or contact a
provider.

## Local data and recovery

Setup and development use explicit owner identity and real local migrations.
Dev and preview use the same owner and canonical `.wrangler/state`. Local dev
sign-in uses the checkout’s private key; keep `RER_OPEN` private. Private
settings are kept in `.dev.vars` with mode 0600 and are not copied into build output.

Local export creates a private archive with an integrity receipt and explicit
exclusions. The foundation has no product-domain tables or background jobs; an
edition's archive contains the supported domain tables and resources that its
adapter declares. Owner/auth, outbox, bookkeeping, private settings and
transient runtime state are excluded. Archive restore validates and restores atomically
into an empty destination; confirmed reset preserves export archives. Run setup
after restore to establish a fresh owner. Each first-party seed verifies local
export/import/export equivalence across its supported resources. Remote transfer
is available only when the adapter declares complete resource coverage.

Preserve ambiguous state and applied migration history. Never place a remote
credential, owner secret or local resource ID in source. A schema change needs
a forward migration and verified transition/recovery.

## Deployment

`rer deploy --dry-run` validates the real owner-account
deployment declaration and builds locally without provider requests. Real
deployment requires privately supplied `CLOUDFLARE_ACCOUNT_ID` and
`CLOUDFLARE_API_TOKEN`, the declared owner/session/setup secrets, and a real
verified mail sender in `deploy.json`. Follow the owner-account deploy-kit
instructions under `scripts/base-cli/modules/deploy-kit`; account scope,
resource ownership, migrations, receipt and health checks are defined there.
Local validation does not prove hosted acceptance, provider delivery or remote
health.
