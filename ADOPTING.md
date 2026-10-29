# Adopting Base refresh and installation transfers

Use an installed current RER package to refresh a seed whose copied authoring
CLI is still from 0.2.82. Pin the package in the seed first, then invoke its
public command rather than `scripts/edition-authoring/cli.mjs`:

```sh
rer refresh-base --ref FULL_40_CHARACTER_BASE_COMMIT --base /absolute/base-checkout
```

Resolve a release tag in the Base checkout with
`git -C /absolute/base-checkout rev-parse 'rer-vVERSION^{commit}'` and pass that
full commit. A tag name is not accepted as `--ref`.

If the 0.2.82 refusal names a Base-equal untracked, ignored or excluded helper,
keep its bytes and explicitly record it before repeating the refresh:

```sh
git add -f -- LOCAL_PATH
node node_modules/@runeditrun/rer/edition-authoring/cli.mjs record-base LOCAL_PATH ORIGIN_PATH FULL_40_CHARACTER_BASE_COMMIT --base /absolute/base-checkout
rer refresh-base --ref FULL_40_CHARACTER_BASE_COMMIT --base /absolute/base-checkout
node node_modules/@runeditrun/rer/edition-authoring/cli.mjs verify-base --base /absolute/base-checkout
```

Record only verbatim Base bytes. For an intentional custom helper, stage it as
seed-owned, reconcile its imports, and verify the result. Current refresh already
preserves Base-equal seed-owned helpers without leaving an unrecorded-copy error.

On a case-insensitive filesystem, the historical 0.2.82 `mv -i` recovery also
needs Git's index spelling repaired. After running its named move, preserve the
`.refresh-backup` outside the checkout, remove the old spelling from the index,
repeat the refresh to deliver the canonical path, and stage the canonical path
with the copy record. For the historical authoring helper example:

```sh
backup=$(mktemp -d)
mv -- scripts/edition-authoring/copy-checkout.mjs.refresh-backup "$backup/"
git rm --cached -- scripts/edition-authoring/Copy-Checkout.mjs
rer refresh-base --ref FULL_40_CHARACTER_BASE_COMMIT --base /absolute/base-checkout
git add -- scripts/edition-authoring/copy-checkout.mjs base-copies.json
node node_modules/@runeditrun/rer/edition-authoring/cli.mjs verify-base --base /absolute/base-checkout
```

An extracted Base archive needs no Base `.git` directory:

```sh
rer refresh-base --ref FULL_40_CHARACTER_BASE_COMMIT --base-archive /absolute/extracted-base
```

The destination seed still uses its own Git index to protect ownership and
removals. Archives update recorded templates and preserve unrecorded workflows
with adoption notices. An exact match to the supplied current template may be
adopted; older template equality still requires Git history. Merge and explicitly
`record-base` an unmatched template to adopt it. Older records without
`originFiles`, and migrations needing ancestry, still require a Base checkout.

Delivered authoring tools include the complete tool identity, including yaml and
Babel LICENSE and README files. An unadapted delivered tool and the package tool
accept each other's source locks; no second lock with a different digest is
needed. Workflow helpers keep the ordinary collision and ownership protections.

Before transferring an installation with product tables prefixed `oc_`, declare
each in `includeTables` or an intentional `excludeTables` policy. Base excludes
its exact `oc_owner_claims` and `oc_idp_grants` identities; any other undeclared
`oc_` table refuses instead of silently losing its rows. Platform bookkeeping
and the existing `oa_` identity policy remain excluded.

Managed SQL downloads may interleave a populated child table before the parent
table definition. Intake validates the whole dump, creates every accepted table
before the other statements in the same deferred-FK batch, then retains their
relative order. Invalid SQL, missing parents, schema and ledger mismatches,
occupied destinations and confirmation requirements still refuse.

Base Verify exercises the delivered workflow's cache lifecycle on a hosted
Ubuntu 24.04 runner as its ordinary user: cold frozen install, Chromium launch,
the sudo dependency helper, cache save/removal/restore, and a warm frozen install
and launch. The pnpm, browser and apt roots stay under the runner temporary
directory and runner-owned. The proof executes the exported template's shell
blocks and requires an actual Actions cache hit.

## Hosted verification and optional integrations

Hosted output and agent-door verification leave `deploy.json` secrets marked
`optional: true` absent unless the declaration supplies a nonempty
`verifyStandIn`. Previously, invented bytes could enable an unconfigured native
identity provider and produce HTTP 500 during signed owner bootstrap (for
example, an optional SAML SSO URL became a random string).

Required secrets retain their disposable stand-ins. To exercise an optional
integration, declare hosted-valid `verifyStandIn` values or supply its generated
bindings through `agent-surface.json` verification hooks. Managed mail keeps its
existing declared credential stand-ins. Verification does not read real deploy
credentials. Native signature, replay, session and authority checks still run.
