# Changelog

## 0.2.10

- First-owner bootstrap and signed owner claims use a client-IP rate budget, so junk setup-token requests from another client cannot block the correct claim. Repeated wrong tokens from one client remain limited.

### Upgrade notes

- Seeds receive this auth runtime fix with their next Base refresh. Updating the rer package alone does not replace seed-owned runtime copies.

## 0.2.9

- `rer deploy --remove --yes` empties each R2 bucket whose saved creation identity proves rer owns it, deletes the bucket, and verifies removal. Buckets with uncertain or replaced ownership are refused; interrupted deletion retains the deployment record so removal can resume.
- A failed hosted export names the export step, job ID, HTTP status and returned machine error code. A successful pnpm preparation is no longer blamed for a later export failure.
- The waiting-for-owner Lobby shows setup-token guidance only for an edition that declares `manualSetupTokenClaim: true`; automatic owner claims need no token from the visitor.
- Base's shared and exported dependency graphs carry sharp 0.35.5, undici 7.29.1, source-map-js 1.2.2, patched esbuild edges at 0.28.1 or newer, and Playwright 1.63.0.

### Upgrade notes

- Removal's existing `--yes` confirmation includes permanently deleting objects in buckets rer proves it created. Preserve an export before removing a deployment whose data you need.
- A seed using manual setup-token owner claims sets `manualSetupTokenClaim: true` in its edition identity. Seeds receive the shared runtime and dependency updates with their next Base refresh; updating the rer package alone does not refresh seed-owned runtime copies or dependency locks.

## 0.2.8

- `rer deploy --demo` resolves Wrangler through its exported package manifest and gives the Cloudflare Container application a valid explicit name. This fixes deployments refused by package export restrictions or an application name containing consecutive dashes.
- Hosted demos record every readiness probe's timing and status or safe error category, plus available container exit codes. Early exits and stalled probes fail promptly within the existing startup budget. Failed destruction keeps the capacity reservation and schedules cleanup again.
- An optional host-operator credential grants access to a bounded, redacted failure summary on the existing start page. Visitors retain the generic failure page; their demo session and the diagnostic correlation ID grant no operator access.

### Upgrade notes

- Redeploy the demo host to enable the new diagnostics. Set a separate random `RER_DEMO_OPERATOR_TOKEN` to enable the operator page; see `modules/demo-host/README.md`. Container stdout/stderr remains in Cloudflare's authenticated observability service.

## 0.2.7

- `rer deploy` after a custom deploy hook that returned its own kit state file as `state` reads that record for every finalization step (inspect, the setup token, the owner record), so it issues a setup token, claims the hosted owner, retires the token and exits 0, instead of failing with `HTTP 403 (invalid_setup_token)` because it looked only at `.rer/deploy/<environment>.json`. `--set-secret` and `--unset-secret` read the same record. An untouched repeat still writes nothing.

### Upgrade notes

- None: a hook that already returns `state` (0.2.6 upgrade note) gets its owner claimed on its next `rer deploy`.

## 0.2.6

- A job-queue client no longer crashes with an unhandled `write EPIPE` when a process probing its identity or policy socket closes before the answer is written (a probe that timed out under load); the prober reports its own timeout or reset. This stopped Orbit's release producer twice.
- `rer setup --owner-email YOU` (or `--answers`) on a checkout whose local owner is still the `owner@<checkout>.test` that the zero-setup `rer dev` created replaces that owner with you in place: the same account under your address, all local data kept, and one line saying so. A database that holds any other owner is still refused, as before.
- An untouched repeat `rer deploy` after the hosted owner was claimed writes nothing: retiring the setup token no longer changes the build fingerprint (so the Worker is not uploaded again), and the recorded claim stays `claimed`.
- The pinned pnpm check settles with a bounded retry: a fresh pnpm's version check is tried up to three times (10, 20 and 30 seconds), and if it still fails, rer says what pnpm did: no answer in time, could not start, its exit code and first error line, or the version it reported. The first `rer import` on a fresh clone no longer stops there when the same command succeeds on retry.
- A provider call Cloudflare refuses carries the call and Cloudflare's own error codes and messages (account id and token removed, each message cut to 300 characters); `rer deploy` names them when a custom deploy hook fails on one, instead of only `provider-http-400`.
- `rer deploy --remove --yes` removes what a custom deploy hook deployed under its own kit state file when the hook returned that file as `state`, and reads every resource back gone.

### Upgrade notes

- A custom deploy hook that keeps its own kit state file returns it as `state` in its result (the kit's `deploy` result names it as `state`), so `rer deploy --remove --yes` can find what it deployed.
- A deployment that an earlier rer redeployed after its owner claim uploads its Worker once more on the next `rer deploy` (the fingerprint again names the retired setup token); repeats after that write nothing.

## 0.2.5

- `rer deploy` with a seed's own deploy hook claims the hosted owner from what the hook returns, `{ deployed: true, origin }`, once the origin's `/health` names the checkout's commit, and prints the sign-in address. A hook that keeps its own deployment record (Penny's does) no longer ends in `missing-owner-receipt` with a live, unclaimed app; such a hook returns `setupToken` too when its Worker holds a setup token other than the `SETUP_TOKEN` rer passed it. A hook that reports no deployment, or whose app never names the commit, fails saying so and claims nothing.
- `rer deploy` with uncommitted changes to tracked files stops before building, lists the files, says to commit them and that nothing was uploaded (exit 4), instead of building first and failing with `owner-source-not-committed`.
- `rer deploy --demo --dry-run` and `rer build --platform container` work on an exported seed: the container import boundary admits the demo guard's `import { env } from 'cloudflare:workers'` in `src/modules/demo/index.mjs` (that file and that import only) and still refuses a Cloudflare import anywhere else in `src/`. The release smoke now runs the hosted demo dry run on a package-mode export.
- `rer describe` lists `demo` as a verb (`rer dev --demo`), with its effects and the flags a demo takes.
- Two launches claiming the same port, or two workers claiming the same checkout's launch, get exactly one winner: the claim is written complete and linked into place, so the other never reads it half-written and takes it as abandoned.
- `node scripts/export-cli.mjs --to-package` on a composed foundation drops the removed `scripts/base-cli` copy's entries from `composition.lock.json` along with its files, so `rer check` no longer fails `SC-05.auth-copy` for files the conversion deleted.
- `rer deploy` refuses a seed deploy hook's `http://` origin (other than a loopback host such as `localhost`, `127.0.0.1` or `[::1]`) before sending it anything, so the one-time setup token only travels over https; it says to make the hook return its https origin.
- After a redeploy whose app answers unhealthy, the owner state in `.rer/deploy/` keeps each health check's status and timing but not the response text, so a secret an app echoes is never saved there; the secret command already kept none.
- A secret change `rer deploy` could not yet confirm stays recorded until the provider's records agree, and blocks another secret change, deploy or removal until then; a secret added or removed outside rer meanwhile is refused instead of adopted.

### Upgrade notes

- A seed's custom deploy hook returns `{ deployed: true, origin }` with an https origin (and may add `setupToken`); `rer deploy` waits for that origin's `/health` to name the checkout's commit, then claims the owner itself.
- A seed adopting `rer demo` needs rer 0.2.5 for `rer deploy --demo`.

## 0.2.4

0.2.3 was tagged but not published; its changes are in 0.2.4.

- A first `rer deploy` waits up to two minutes (it was 30 seconds) for Cloudflare's account listing to show a database, bucket, namespace or queue it has just created, whether the listing disagrees with its own page counts or leaves the new resource out; one that never appears stops the deploy before any upload, names the resource, and the same command resumes with it.
- A first `rer dev` no longer chooses the port another, stopped checkout was set up on, so both checkouts keep working origins.
- Seed recovery code can check the deploy migration ledger with one call: `migrationLedgerShape(rows)` from `@runeditrun/rer/modules/deploy-kit/migration-ledger`, given the rows of its `ledgerShapeQuery`, accepts all four ledger shapes a deployment can hold (Wrangler's `d1_migrations`, that table after a kit deploy adopted it, the kit's own `d1_migrations` since 0.2.2, and the `_rer_deploy_migrations` ledger a 0.2.1 or earlier deploy left, shape `legacy`, which wins when both tables exist) and refuses any other. A seed whose recovery checks that the ledger is exactly Wrangler's three columns refuses ledgers from 0.2.2 on (`MIGRATION_MISMATCH`); replace that check with this call.
- `rer import` and hosted restores refuse an archive that records a migration this installation has not applied (`schema_mismatch`), even when that migration left the schema unchanged (an index or a data-only change); such an archive is newer than the installation.
- After a pulled change to a checkout's `@runeditrun/rer` pin, every verb (`rer deploy` included) installs the pinned version with the frozen lockfile before it runs, instead of asking you to run `rer install` first.
- Two verbs started at the same moment after a pulled pin change share one install of the new pin: the second waits for the first's install, then runs, instead of racing it and failing with "The declared adapter could not be loaded".
- The publication scan accepts AI-generated PNGs whose C2PA manifest carries the signing certificate's email address (certificate names are metadata) and phone JPEGs that store more images after the first (every image's pixels are skipped as pixels), while an address in the rest of the manifest, XMP or EXIF is still flagged.
- Dependency installs receive only the environment an install needs, never your credentials: the frozen `pnpm install` that `rer install`, a fresh clone's first verb, `rer dev`, the installer and `rer release` run, the pnpm version check, `rer update`'s npm install and local data migrations get `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`/`TMP`/`TEMP`, `TERM`, `LANG`/`LANGUAGE`/`LC_*`, `TZ`, `CI`, `SSH_AUTH_SOCK` (git+ssh dependencies), `NODE_OPTIONS`, `NODE_EXTRA_CA_CERTS`, `XDG_*`, proxy settings without their user:password, and `npm_config_*`, `PNPM_*`, `COREPACK_*` and `RER_*` settings except credentials (by name, such as `_authToken` or `*_SESSION`, or by value: a URL with a password, a credential query or connection-string parameter, a JWT, a private key, an Authorization header or a provider token). Every other variable stays with you, so dependency build scripts (esbuild, workerd, sharp, oxide) never see vault sessions (`BW_SESSION`, `OP_SESSION_*`), connection strings, keys or tokens under any name. `rer deploy` and the seed's own `verify` still receive everything.
- A proxy setting reaches a dependency install without its user:password even when the password contains spaces, an extra `@` or the value starts with whitespace.
- `rer deploy` setting or removing a secret whose answer was lost settles against the Worker version it recorded, so a later deploy recognises the change instead of refusing it.
- A secret change whose answer was lost while the read-back also failed stays recorded as pending, so the next `rer deploy` recognises it instead of locking you out; replacing an existing secret after a lost answer writes it again and confirms it before reporting success.
- After it claims the hosted owner, retires the setup token or sets or removes a secret, `rer deploy` checks the app's health on the new Worker version and fails with the HTTP status and the response's first line, instead of reporting success, when the app is not healthy.
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
- A private registry's auth must be in `~/.npmrc` (or the registry config your package manager reads from `HOME`): dependency installs now get only an allowlisted environment, so a token passed as an environment variable no longer reaches them.
- A seed with custom recovery code that checks the deploy migration ledger is exactly Wrangler's three columns uses `migrationLedgerShape` instead; the old check refuses ledgers from 0.2.2 on (`MIGRATION_MISMATCH`).

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
