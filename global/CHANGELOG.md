# Changelog

## Unreleased

- `rer setup` finishes provider-free when a seed declares an optional dependency that you leave unconnected.

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
