# Building and releasing `@runeditrun/rer`

The ordinary CLI is JavaScript with no runtime npm dependencies. The package
also carries TypeScript source, including its public D1 entry; Worker TypeScript
entries require a suitable bundler. Its npm tarball is the only package artifact:
no per-platform bundles and no website infrastructure. The site
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

## Packed release surfaces

Before publication, the release workflow installs the exact tarball in an isolated
HOME and checks the surfaces below. The current 0.2.82 notes claim only these
packaging repairs; older changelog sections describe earlier releases. Broader
release groups still require their independent release proofs.

| Surface | Delivered public entry | Check |
| --- | --- | --- |
| Import door and intake | `@runeditrun/rer/modules/import-kit/door` | Bundle actual runtime imports, compile public type imports; CSV, NDJSON and JSON projection, typed refusals, plan, apply, reconcile, replay and Undo against real SQLite. |
| Existing D1 engine | `@runeditrun/rer/modules/import-kit/d1` | Bundle and initialize the packed engine used by the door; compile its public types. |
| Base authoring refresh | `edition-authoring/cli.mjs` in the installed package | Refresh a fresh pinned public Pegboard checkout with its legacy singleton records; run both the refreshed local CLI and the package's `verify-base` against committed Base blobs, recorded SHA-256 values, modes and unrecorded copies; repeat refresh. |

```sh
node scripts/rer-package/artifact.mjs TARBALL --out EVIDENCE_DIR
```

The check installs its compiler tools from the reference's declared versions;
application imports resolve only inside the isolated installed tarball. Base is
used only as the explicit committed refresh source (`--base` / `--ref` can select
it). It never supplies a missing runtime module from checkout source. The JSON
report lists every checked surface and retains each authoring command's output.
The two groups run independently, so one missing surface cannot mask the other.
No global rer or seed dependency pin is changed.

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

The `build` job builds once, rebuilds from a second clone at another path and
requires identical bytes. It requires a version with no development stamp (a dry
run reports it), unpacks the exact tarball and runs `scripts/publish-check.mjs`
over it, stopping on any finding, then smoke-tests the same tarball and uploads
it with `install.sh`, `SHA256SUMS` and the scan report as a run artifact. On a release
tag only, the dependent `publish` job downloads that artifact and runs
`npm publish TARBALL --access public` (skipped when that version is
already on npm; nothing is rebuilt), then creates a GitHub release for the tag with the
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
