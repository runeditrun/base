# Adopt local Worker runtime changes

Treat Wrangler, Miniflare, workerd and the Cloudflare Vite plugin as one
compatible dependency group. A lower Wrangler version alone can fail before
the application builds: the Vite plugin checks its Wrangler peer range at
startup. Select a plugin release whose declared range accepts the candidate.
For example, plugin `1.54.5` requires Wrangler `^4.129.1`, while plugin
`1.54.4` accepts `^4.129.0`. Dependency compatibility still needs journey
validation before adoption.

Base's dependency sources are:

| Consumer | Manifest and frozen lock |
| --- | --- |
| Shared runtime tests | Root `package.json` and `pnpm-lock.yaml` |
| Maintained reference | `default-seed/package.json` and the root workspace lock |
| New foundation editions | `foundation/template/package.json` and `foundation/template/pnpm-lock.yaml` |

Wrangler and the Vite plugin both depend on Miniflare and workerd. Inspect the
resolved tree, including those transitive dependencies, when changing versions.
Use exact `pnpm.overrides` in each affected manifest when the intended runtime
would otherwise resolve more than once. Regenerate both frozen locks with the
declared pnpm version; preserve reviewed native-build approvals and any required
Miniflare patch.

Base's `.github/workflows/verify.yml` installs through
`scripts/agent-bootstrap.sh`, which consumes the workspace lock. Delivered seed
workflows come from `export/verify.yml` and `export/verify-nightly.yml`; their
frozen installs consume the adopting edition's own manifest and lock. An npm
global install or a changed workflow command alone does not replace an
edition's local runtime dependencies.

Before adopting a runtime downgrade, compare the existing failing public
journey repeatedly against the candidate on the same application source and
Node version. Retain its authorization, stale-state and recovery assertions.
Check npm publication dates and upstream changelogs and issues; similar error
messages can have different causes. A successful build establishes dependency
compatibility, not that a transport failure is fixed. Keep the current versions
when the candidate does not reduce the observed failures.

Existing editions adopt a validated change through their normal Base refresh
and review their manifest, lock and workflow changes together. Preserve their
product tests and application source; shared runtime changes do not establish
new product-clause judgments.
