# Legacy export of unconverted family editions

This mechanism exports editions from committed family authoring inputs. Current
edition-owned products use the [edition-owned authoring protocol](../edition-authoring/README.md).
The family ownership and coupled pin rules below apply only to this legacy mechanism;
they do not describe the ownership or release process of those products.

A legacy family author repository contains headless
`core/`, optional `modules/`, complete edition-specific `editions/`, and
`compositions/`. Its `family.json` pins an exact base Git commit. Family-specific module changes travel in the family commit. Optional cross-family
modules may live under base `modules/<id>` and travel in the pinned base commit.
Each selected module has exactly one repository origin; modules have no
independent package versions.

From a base checkout, with Node 26.8.1 and pnpm available:

```sh
pnpm edition beacon --family-repo /path/to/support --base-repo /path/to/base --output /tmp/beacon --install --verify
pnpm edition brook --family-repo /path/to/support --base-repo /path/to/base --output /tmp/brook --install --verify
```

Both input commits must already exist locally. Cloning/fetching is explicit; the
exporter does not fetch or choose newer versions. Without `--ref`, it resolves
family HEAD and rejects a dirty family checkout. `--ref <commit>` explicitly
exports committed bytes even if the checkout has local changes. The selected
commit and pinned base commit are printed. Local repository paths are lookup
locations, never part of the exported product or lock.

The bootstrap reads committed `family.json`, extracts the pinned base's committed
tooling and schemas to a temporary directory, and executes that exporter. Base
working-tree changes cannot alter its behavior. Git replacement objects are
ignored. The family composition maps repository-relative committed sources into
an absent output directory; collisions, symlinks, submodules, unsafe paths,
tracked secrets/generated state, and unselected module source are rejected.

The output is ordinary editable source with local imports and its own dependency
lockfile, commands, tests and consumer instructions. `composition.lock.json`
records repository identities, immutable commits, composition, original source
paths and SHA-256 hashes/modes for every source file. It contains no machine
paths or timestamps. No author repository is needed to run the product.

`--install`, `--verify`, `--setup`, `--deploy` and `--dev` run the edition's commands.
`--dry-run` forwards to selected setup/deploy commands. Credentials and provisioned
state remain local to the installed product. Never export over an existing owner
checkout: prepare a separate candidate, have the owner's agent integrate the
applicable change, and verify recorded intent and product guarantees.

Author changes belong in their canonical layer. Commit base changes first, update
and commit the family's exact base pin with affected source changes, then export
and test affected editions. Shared source is absent from edition author folders
and copied from the selected base/core/module sources at export. This is source
composition, with no runtime plugin registry or module dependency solver.

Canonical generated repositories are published with the shared
[authoring helper](../authoring/README.md), using each family's committed
`publication.json`. This is separate from Cloudflare deployment and from owner
fork updates. Publication does not establish product acceptance.

Current exporter tests run via `pnpm verify:composition`.
