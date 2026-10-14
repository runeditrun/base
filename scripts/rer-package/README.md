# Building and releasing `@runeditrun/rer`

The package is pure JavaScript with no dependencies, so its npm tarball is the
only artifact: no per-platform bundles and no website infrastructure. The site
serves a byte-identical copy of the package's `install.sh`.

## Build

```sh
node scripts/rer-package.mjs --out DIR   # last stdout line: the tarball's path
```

`global/package.json` is the one version source. A commit tagged
`rer-v<version>` builds `<version>`; any other commit builds
`<version>-dev.g<sha8>`, which sorts below the release.

The build is reproducible (`tarball.mjs`): entries in sorted path order, owner
0:0 with no names, mode 0644 or 0755, every mtime the commit time (the
`SOURCE_DATE_EPOCH` convention), and a gzip header with no time and a fixed OS
byte. The same commit gives the same bytes from any clone path on any day.

## Smoke test

```sh
node scripts/rer-package/smoke.mjs TARBALL [--port N]
```

In a clean HOME with an empty npm config: `npx --package=TARBALL rer cli
install`, `rer --version`, then a zero-setup `rer dev` and `rer dev --stop` on two
fresh default-seed exports: a vendored one, and one in package mode, converted by
`scripts/export-cli.mjs --to-package` to pin this tarball's version, which a
local registry serves (`registry.mjs`; `reference.mjs` builds that reference).
The package-mode export then runs `rer deploy --demo --dry-run`, which builds the
hosted demo's container image folder from the exported seed. It needs `pnpm` and `npm` on PATH, as `rer dev` and the conversion do.

## Package mode without publishing

`registry.mjs` is a local npm registry for `@runeditrun/rer` alone: publish a
built tarball to it and point the scope at it (`@runeditrun:registry=URL/` in an
npmrc named by `NPM_CONFIG_USERCONFIG`); every other package still comes from the
usual registry. `reference.mjs` uses it to export the default-seed reference and
convert it to package mode against the next release's own tarball, so the
conversion, `rer dev` and the delivery build (`pnpm install --frozen-lockfile &&
pnpm run build`, no `rer` on PATH) are proved before anything is published.

## Release workflow

`.github/workflows/rer-release.yml` publishes. It runs for real only on a pushed
`rer-v<version>` tag that equals `global/package.json`, points at a commit on
`main`, and whose commit has a green `Verify` run; a tag that fails any of these
stops the workflow. Every other trigger (`workflow_dispatch`, or a branch push
touching `global/`, the build scripts or the workflow) is a dry run.

One job, in order: build once; rebuild from a second clone at another path and
require identical bytes; require a version with no development stamp (a dry run
reports it); unpack the exact tarball and run `scripts/publish-check.mjs` over
it, stopping on any finding; smoke-test the same tarball; upload the tarball,
`install.sh`, `SHA256SUMS` and the scan report as a run artifact. On a release
tag only: `npm publish TARBALL --access public` (skipped when that version is
already on npm; nothing is rebuilt), then a GitHub release for the tag with the
tarball, `install.sh`, `SHA256SUMS` and the scan report attached.

The publish job runs in the GitHub environment `npm`, the only place its
credential lives. Authentication: npm trusted publishing (OIDC) when the package
trusts this workflow, otherwise the `NPM_TOKEN` secret of the `npm` environment.
Base is private, so npm records no provenance attestation.

### Owner setup

1. The npm organisation `runeditrun` exists (free plan).
2. On `runeditrun/base`, Settings → Environments → New environment `npm`. Under
   Deployment branches and tags choose Selected branches and tags and add the tag
   rule `rer-v*`, so only a release tag run can enter the environment.
3. First publish: a granular npm access token with read and write on the
   `@runeditrun` scope (bypassing two-factor for automation), stored as the
   environment secret `NPM_TOKEN` in that `npm` environment (Environment
   secrets → Add secret). Not as a repository secret: any workflow job on any
   branch can read a repository secret, while an environment secret reaches only
   jobs the tag rule admits. npm accepts a trusted publisher only for a package
   that exists, so the first publish uses the token.
4. After it: on npmjs.com, `@runeditrun/rer` → Settings → Trusted publishing →
   GitHub Actions: organisation `runeditrun`, repository `base`, workflow file
   `rer-release.yml`, environment `npm`. Then delete the `NPM_TOKEN` environment
   secret and revoke the token on npmjs.com.

Release: set `global/package.json` to the version, land it on `main`, wait for
its `Verify` run to pass, then push the tag `rer-v<version>` at that commit.
