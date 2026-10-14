# Changelog

## Unreleased

- A first `rer deploy` waits up to two minutes (it was 30 seconds) for Cloudflare's account listing to show a database, bucket, namespace or queue it has just created, whether the listing disagrees with its own page counts or leaves the new resource out; one that never appears stops the deploy before any upload, names the resource, and the same command resumes with it.
- A first `rer dev` no longer chooses the port another, stopped checkout was set up on, so both checkouts keep working origins.
- Seed recovery code can check the deploy migration ledger with one call: `migrationLedgerShape(rows)` from `@runeditrun/rer/modules/deploy-kit/migration-ledger`, given the rows of its `ledgerShapeQuery`, accepts all four ledger shapes a deployment can hold (Wrangler's `d1_migrations`, that table after a kit deploy adopted it, the kit's own `d1_migrations` since 0.2.2, and the `_rer_deploy_migrations` ledger a 0.2.1 or earlier deploy left, shape `legacy`, which wins when both tables exist) and refuses any other. A seed whose recovery checks that the ledger is exactly Wrangler's three columns refuses ledgers from 0.2.2 on (`MIGRATION_MISMATCH`); replace that check with this call.
- `rer import` and hosted restores refuse an archive that records a migration this installation has not applied (`schema_mismatch`), even when that migration left the schema unchanged (an index or a data-only change); such an archive is newer than the installation.
- After a pulled change to a checkout's `@runeditrun/rer` pin, every verb (`rer deploy` included) installs the pinned version with the frozen lockfile before it runs, instead of asking you to run `rer install` first.
- Dependency installs never receive your credentials: the frozen `pnpm install` that `rer install`, a fresh clone's first verb, `rer dev`, the installer and `rer release` run, the pnpm version check, `rer update`'s npm install and local data migrations run without variables whose name or value marks a credential, provider account settings (`CLOUDFLARE_*`, `AWS_*`) or application bindings, so dependency build scripts (esbuild, workerd, sharp, oxide) never see them. Names count run together too (`PGPASSWORD`, `CLIENTSECRET`, `GPG_PASSPHRASE`, `CI_JOB_JWT`, `DOCKER_CREDS`, `SLACK_WEBHOOK_URL`, `npm_config_*auth*`), and so do values under any name: a URL with a password or a credential query parameter (`?authToken=`), a JWT, or a provider token (`ghp_`, `github_pat_`, `sk-`, `xoxb-`, `AKIA`). `PATH`, `HOME`, proxy settings, locale and `CI` still reach the install; `rer deploy` and the seed's own `verify` still receive everything.

## 0.2.3

- `rer setup` finishes provider-free when a seed declares an optional dependency that you leave unconnected.
- A seed adapter can declare `resetPreflight`; `rer reset` runs it before listing or deleting anything, and `--yes` cannot skip it.
- A first `rer dev` whose chosen port is taken by another program before setup can use it moves to the next free port and says which.
- `rer deploy` says it is deploying to your Cloudflare account and names the live address, instead of saying the application is running locally; `rer build` ends with "Your application is built".
- `rer describe` in the default seed and new foundations names the release keygen, sign and receipt subcommands again.
- Importing an archive whose bytes are not valid UTF-8 is refused with the same `archive_json` diagnostic (exit 2) as invalid JSON.
- Converting a seed to package mode no longer leaves a broken queue sentence in its README or `scripts/base-cli` paths in its operations guide and erasure README.
- The owner's sign-in settings page (`/auth/settings/identity`) wears the seed's declared theme, like sign-in and setup.
- `rer demo` (the same as `rer dev --demo`) runs a seed as a throwaway local demo: signed in as the saved owner, filled with the seed's demo data, marked by a Demo bar, unable to send anything, and deleted on `--stop`, Ctrl-C or after an hour; the checkout's own state is never written.
- Under `rer demo`, `fetch`, redirects, `WebSocket`, `navigator.sendBeacon`, `EventSource`, `node:net`/`node:tls` and `cloudflare:sockets` reach loopback hosts only, and every refused send is listed in the Demo bar.
- `rer demo` refuses a seed that has not adopted it (no `withDemo` guard, no `demoSockets()` or a state path that ignores `RER_STATE_DIR`), and `rer deploy`, including `--dry-run`, refuses a deploy declaration or `--env-file` that carries `RER_DEMO` and names the key.
- `rer deploy --demo` hosts a seed's demo at `demo.<domain>`: each visitor passes a Turnstile check and gets their own signed-in, throwaway container of the seed that can send nothing, ended after an hour or 15 idle minutes. `export/run-demo.yml` deploys it when `RUN_DEMO_DEPLOY` is on.
- `rer deploy` claims the hosted owner after every deploy, including seeds whose own deploy hooks run, retires the setup token, keeps an existing native identity-provider owner and keeps a live owner token you supply.
- Container images built by `rer build --platform container` start again; they exited at start.
- The default seed's sign-in serves the signed owner claim whenever its public keys are configured.
- A seed can declare a reviewed rewrite of an already released migration in `migrations/rewrites.json`; deploys and local builds accept the released bytes for that migration only and still refuse every undeclared change.
- Seed table inventories can use the exported portability exclusion list, so native ZIP and remote export no longer refuse the deploy controller's migration ledger table.
- The publication scan skips only the compressed pixel and sample data of recognised images and videos; their comments, XMP, EXIF and tags are checked, and a text file behind a fake media header is checked whole.
- With `--public-base`, the publication scan reports a file identical to the public base's copy as pre-existing instead of a finding.
- Base's default seed and source import kit (outside the rer npm package) prepare and verify 100,000-row imports across requests within the Worker CPU limit and resume after a killed step; a changed re-upload under a published key is refused.
- Base's default seed and source import kit erase a person named in other people's imported records at seed scale, across requests, and when they never became a native record; an interrupted erasure is finished by a cron sweep within about 10 minutes.

### Upgrade notes

- Existing OIDC provider links show **not linked** until the next successful sign-in through each provider, because older stores have no verified token-exchange observation for them.
- The default seed's erasure queue message is now `{ redact, chain }` instead of `{ redact, operator, continuation }`; a message still queued in the old shape when you deploy is refused, so let the erasure queue drain first. Default-seed migrations 0021 to 0023 add the import-step, stream-source and erasure-progress tables, and its cron trigger sweeps erasures every 10 minutes.
- A seed adopting `rer demo` adds `src/demo.ts` (exporting an idempotent `seedDemo`), copies Base's `modules/demo/` and wraps its Worker entry's default export in `withDemo` as the entry's first import, and makes three `vite.config` changes: the state path reads `RER_STATE_DIR`, the dev entry's vars pass `RER_DEMO` and `RER_DEMO_EXPIRES`, and `demoSockets()` comes first in `plugins`; add `.rer/demo/` to `.gitignore`. `export/DEMO.md` has the steps.

## 0.2.2

- `rer deploy` claims the hosted owner, exits cleanly when it finishes, changes and removes secrets safely, and removes the resources it created when you ask it to.
- Local restore runs the seed's own restore-validation policies, so a seed no longer needs its own patch or adapter for them.
- Hosted exports stay portable: the deploy kit's migration ledger is kept out of seed archives, compound D1 migrations such as triggers apply, and an archive or import target with uncertain migration history is refused.
- Package-mode guidance in the exported docs names the commands a package-mode seed actually runs, and the local-run docs describe the sign-in outbox.
- `rer release --help` and the job-queue help print their usage.
- `rer describe` reports the effects a seed declares for each command instead of generic account effects.
- Linked OIDC providers report health from the token exchange, stay healthy when one authorization code is rejected, and send failures to the configured sign-in path.
- The run-site privacy check catches registered secrets inside prefixed base64 and accepts constant text that a client island imports.
- Fresh rer launches provision pnpm, prefer the provisioned pnpm, keep state under your HOME, and clean up their probe processes.
- Base can export a seed Verify workflow with source freshness checks for manual adoption.
- Base's default seed and source import kit erase a person in bounded steps after retiring their imported custody; this kit is outside the rer npm package.

## 0.2.1

- `rer release keygen` prepares publisher keys and anchor entries; `rer release sign` writes a detached signature for a completed tagged release.
- `rer release receipt` verifies signed artifacts against local anchors offline, using the shared verifier and vectors exported for reuse.
- Tagged releases record the annotated tag object, public commit and public tree needed to sign their artifacts.
- Package-mode conversion removes obsolete vendored-copy checks, component selections and packaging globs, and rewrites test launches to the installed rer entry with foreground development.
- Hosted-output and hydration checks run when invoked through pnpm's package symlinks.
- Run sites support seed-declared browser client islands, with bundled scripts and styles checked during the build.
- Run-site privacy checks match complete owner identifiers and accept examples already committed in source; `rer dev` warns on a run-site privacy refusal while `rer build --site` still refuses.
- `rer preview --detach` starts a background preview, refreshes stale build output after source changes and serves scheduled trigger routes.
- `rer dev --foreground --help` shows the command's help.
- Deploy failures name the failed step and error code, show redacted provider output and list resources created during that attempt.
- Sign-in pages hide the email form when mail is unavailable and expose typed handler options.
- Dev badge and sign-in outbox controls have larger click targets.
- The Lobby stays script-free; `RER_OPEN` exchanges the development key on `/__dev/key` under its own content security policy.
- `rer --version` handles a closed output pipe without an EPIPE stack.
- The publication scan accepts recognised vendor no-reply co-author trailers while continuing to flag personal email addresses.
- Local-run instructions give the stop, export, reset, import and setup order.
- Base provides an optional run-site workflow template for manual adoption.
- Base's source and reference import kit can erase selected personal fields from retained shared records and undo images; this kit is outside the rer npm package.

### Known limitations

the run-site privacy check does not detect deliberately obfuscated secrets, such as base64 concatenated to other text, in client islands

## 0.2.0

What changes for a user since 0.1.1.

### Package mode

- A first-party seed pins `@runeditrun/rer` as an exact devDependency instead of
  carrying `scripts/rer.mjs`, `scripts/base-cli` and `scripts/base-onboarding`.
  `node scripts/export-cli.mjs --to-package SEED_ROOT [--version X]` converts a
  vendored seed (it refuses local edits and lists them).
- `rer check` and `rer describe` in a checkout whose `node_modules` lacks its
  pin install it with the frozen lockfile first, then run the pinned verb, so a
  fresh clone checks with the pinned bytes. `rer check --profile first-party`
  accepts package mode (SC-13) and still accepts vendored mode.
- Named exports for every Base file a seed's adapter, Vite config, build or
  package script imports; nothing needs `internal/`.

### Lobby, homepage variants, setup state

- The Lobby (the pre-claim page) and `GET /setup/state`; a seed supplies its own
  first-run read, and the fonts stylesheet its edition names.
- Homepage variants and a hydration check that follows a redirecting `/`, counts
  cross-origin client scripts and fails an edit case React hydrated too early to test.

### Run sites

- `rer build --site` builds the seed's run site (with its own Vite config and
  CSS) and `rer deploy --site` deploys it. Ownership is proven from the provider
  alone (the latest deployment serves the newest version, which carries the
  kit's annotation), so a fresh CI checkout redeploys; a foreign Worker or
  domain is refused.
- The site Worker is Base-generated: `www.<domain>` answers a 301 to the apex
  (path and query kept) and everything else comes from assets. No zone ruleset
  is read or written.
- The publication scan accepts the run-NAME repository names the owner
  proposed (for example run-lamp under the just-every account) as intended
  public destinations; the earlier names stay valid.

### Local development hardening

- A request with a foreign `Host` gets a plain 421; keyless `/@fs` and any
  path Vite would answer with its 403 "Restricted" page (which lists checkout
  and home paths) get 404. The dev key opens them.
- `rer` fetches the pinned pnpm from the npm registry, checked against its
  integrity hash, when PATH lacks it.
- An explicit `RER_SERVER_LIMIT` caps its own start, higher or lower.
- `rer door`: keys never go through the door, a moved checkout keeps its name,
  a restart hands starts over, a missing folder is a plain page.

### Hosted output

- Built `.html` files are served by the hosted Worker (`staticAssetResponse`),
  including revalidation (`If-None-Match` answers 304). The hosted check
  requests every built file and sends one conditional request per `.html`.
- A deploy secret may carry `verifyStandIn` for the hosted check.
- Packed deploy assets leave out `.assetsignore` and what it names.

### Fixes

- Setup reads the seed's declared settings format and session-secret name.
- Large stores export, and a fresh install recovers a legacy backup.
