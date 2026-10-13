# Operating this reference

Use Node 22.20.0 and pnpm 10.12.4. Run public operations from this seed's
checkout root with `rer`; without it, install it once with
`npx -y @runeditrun/rer cli install` or the installer script on the RER site
(`curl -fsSL https://runeditrun.com/install.sh | sh`). `rer dev` alone launches
a fresh checkout for review. See `RUN-LOCALLY.md` for complete flags, output,
state and exit behavior.

```sh
rer install
rer setup --owner-email you@example.com
rer dev
```

Use the setup prompt instead of the owner-email flag when entering the real
mailbox. Open the `RER_OPEN` URL printed by `dev` on this computer; the app opens
signed in as the owner. With `dev --login`, open the outbox it prints, choose
the newest ordinary sign-in message and follow its link. No external email is
sent. Stop `dev` with
`rer dev --stop` or Ctrl-C, and stop `preview` with
`rer preview --stop` before build or verification.

```sh
rer verify
rer reset --yes
rer export --output exports/installation.rer
rer import --input exports/installation.rer --yes
rer deploy
rer describe
```

`rer deploy --dry-run` validates and builds locally without
provider requests. Real deployment requires privately supplied
`CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`, declared owner/session/setup
secrets, and a verified production mail sender in `deploy.json`. Follow the
owner-account deploy-kit instructions under `scripts/base-cli/modules/deploy-kit`.
Local checks do not establish provider acceptance, inbox delivery or hosted
health.

## Local data and recovery

Local installation archives use the shared portability module. All supported
D1 domain rows, including durable jobs and schedule records, are included;
owner/auth, outbox, bookkeeping, private settings, queue delivery attempts and
runtime caches are excluded. Import verifies the archive and restores
atomically into an empty destination. Confirmed reset preserves exports. Run
setup after restore to establish a fresh owner and local configuration. Every
first-party seed verifies export/import/export equivalence across supported
resources. Remote transfer is supported only where the adapter declares
complete resource coverage.

Canonical local data is `.wrangler/state`; generated settings are private and
remain outside source control. The development provider and outbox are local
only. Any user or process with access to the machine can read that outbox and
sign in as the owner. Setup and dev preserve existing owner/data and exact
private settings; they do not rotate secrets implicitly.

Preserve applied migration history. Schema changes require forward migrations
and verified transition and recovery. Never commit account credentials,
owner secrets or local resource identifiers.
