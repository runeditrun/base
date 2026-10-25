# Edition source authoring

Pin the published `@runeditrun/rer` package in the seed. Its public commands run
that pin; a seed does not need to carry `scripts/edition-authoring/`.

From an existing seed's Git root:

```sh
rer adopt-edition
rer refresh-base --ref FULL_40_HEX_BASE_COMMIT
```

`adopt-edition` creates `edition.json` describing the existing tracked local
source and `sources.lock.json` binding its working-tree bytes and authoring tools.
The initial lock also binds the generated recipe and the preserved or new copy
record, including an existing record that has not yet been staged. It uses
`rer-project.json`'s `projectId`, or the declared OPERATIONS project when no
project ID exists. It preserves an existing `base-copies.json` byte for byte;
without one it creates an empty record, which claims no Base copies. Existing
composition records remain historical evidence. It does not invent a
composition, infer copy mappings, regenerate source, stage files or commit.
Existing edition inputs cause a refusal; review them with their authoring tools.
Review and stage `edition.json`, `sources.lock.json` and any untracked
`base-copies.json`, and run the seed's tests before committing.

Refresh itself needs a Git root and a valid `base-copies.json`; the optional
edition recipe and source lock are not prerequisites. It updates recorded
verbatim copies, preserves acknowledged adaptations and refuses undeclared local
edits or rewriting existing migrations. Review those seed-side differences
explicitly. An absent, unadapted singleton is retired and named in `retired` and
its copy's `removed` list; repeating the same refresh does not recreate it.
Ordinary local absence is the removal signal, including an accidental deletion.
Absent files marked `skip-worktree`, `assume-unchanged` or `fsmonitor-valid`
are incomplete checkout evidence: refresh refuses before writes and names the
Git repair command. A recorded child beneath an uninitialized submodule refuses
with `git submodule update --init`; after initialization, refresh reads the
child's own index and bytes. Unreadable index evidence and deleted declared
adaptations also refuse.

Per-file vendored JavaScript copies outside `foundation/runtime` remain supported.
Refresh follows static
relative imports and exports, including side-effect imports, transitively up to
64 levels inside the original copied origin directory tree. It copies missing
helpers and reports them under `adopted`, recording separate file entries in
`base-copies.json` while preserving the existing per-file mapping. Already
recorded dependencies must remain present. Unrecorded imports outside that origin tree,
missing, deleted or kept-out dependencies, adapted importers with missing
dependencies, and destination collisions refuse before any writes and name exact
`record-base` commands for explicit reconciliation. Existing adapted files are
retained unchanged.
Each file uses its origin name and the target commit's nearest `package.json`
(read from Git objects, never the working tree or seed): `.mjs` is ESM and
`.cjs` is CommonJS; `.js` and extensionless files follow that package's
`"type"`. A nearest typeless package ends the search, as does `node_modules`.
Without a recognized type, CommonJS is the default, with Node's native syntax
detection selecting ESM for module-only syntax and lexical redeclarations of
CommonJS wrapper parameters. Explicit `"type":"commonjs"` never uses detection.
Every JavaScript helper, including extensionless helpers, is parsed transitively.
CommonJS is parsed as a function body with Node's five wrapper parameters using
`vm.compileFunction`; ESM uses `vm.SourceTextModule.moduleRequests`.
The same Node executable runs a parse-only child with `--experimental-vm-modules`
and `--expose-internals`. It never links or evaluates source. Callers need no
extra flag or package, including offline. For typeless inputs the CLI relies on
Node's private `contextify.containsModuleSyntax` detector, available in Node
22.20.0 and 26.8.1. Missing parser/detector APIs, invalid or unreadable package
configuration, and syntax invalid for the decided format refuse the entire
refresh before writes, naming the file and error. No content regexes or grammar
fallbacks choose a format. These rules use Node's ordinary default flags; custom
loader hooks and experimental default-type overrides are outside this finder.
The detector follows [Node's syntax-detection rules](https://nodejs.org/download/release/v22.20.0/docs/api/packages.html#syntax-detection)
through its [native parse-only implementation](https://github.com/nodejs/node/blob/v22.20.0/src/node_contextify.cc).
Relative ESM specifiers resolve exact URL paths (including query/fragment
removal), without suffix or directory-index searching. JSON dependencies are
copied as terminal data files, never parsed as JavaScript; Node still enforces
JSON import attributes and validates JSON at execution. Native `.node` addons,
`.wasm` (including extensionless Wasm binaries) and other unsupported static
import extensions refuse before writes: their closure is not established by
this JavaScript finder. They are never executed to inspect dependencies.
Strings, templates, regular expressions, comments, dynamic `import()`,
`import.meta` and CommonJS `require()` add no static dependencies. In particular,
relative `require()` calls are dynamic and are not followed. JSX and other
syntax the running Node cannot parse in the chosen format refuse atomically.

Copies from `foundation/runtime` retain their runtime-specific dependency policy:
refresh resolves JS/TS runtime dependencies and companion declarations, recovers
omitted old-pin siblings, advances copies matching their old baseline, and
preserves differing seed-owned siblings. Runtime additions appear in each copy's
`added` list; `adopted` reports the non-runtime JavaScript closure above. Both
graphs are planned before any writes; deleted recorded runtime dependencies
refuse without resurrection.

Use the immutable full commit behind the release tag. Base-checkout form:

```sh
git clone https://github.com/runeditrun/base.git ../base
git -C ../base rev-parse 'rer-vVERSION^{commit}'
rer refresh-base --ref FULL_40_HEX_BASE_COMMIT --base ../base
# The original Base-checkout command remains available:
node ../base/edition-authoring/cli.mjs refresh-base FULL_40_HEX_BASE_COMMIT --base ../base
```

Without `--base`, the helper clones the declared Base source as a temporary bare
Git repository and reads committed blobs. The default publisher identity
`runeditrun/base` resolves to `https://github.com/runeditrun/base.git`. A legacy
record repository or an edition's Base source URL is still honored. No source
scripts run, and the temporary clone is removed. `--base` is relative to the
seed root; it must contain both the recorded and target commits.

For offline use, supply `--offline --base CHECKOUT`. Without a checkout refresh
refuses plainly; it cannot refresh from hashes alone. Offline Git reads use an isolated
repository with the checkout’s object store and no remotes, including on Git 2.43.
They cannot launch promisor lazy fetches. If a partial
checkout lacks a required object, refresh preserves the record and names the
online refresh command to acquire it; retry offline after that command succeeds. Acquisition failures name
the public clone command and `--base`; an unavailable or malformed ref names how
to resolve/fetch an immutable release commit. Refusals preserve copy records.
`--record PATH` selects another contained copy record.

The package also includes the existing authoring CLI for recipe and copy work:

```sh
node node_modules/@runeditrun/rer/edition-authoring/cli.mjs inspect
node node_modules/@runeditrun/rer/edition-authoring/cli.mjs lock
node node_modules/@runeditrun/rer/edition-authoring/cli.mjs check
node node_modules/@runeditrun/rer/edition-authoring/cli.mjs verify-base --offline
node node_modules/@runeditrun/rer/edition-authoring/cli.mjs record-base LOCAL_PATH BASE_PATH FULL_COMMIT --base ../base
node node_modules/@runeditrun/rer/edition-authoring/cli.mjs adapt-base LOCAL_FILE
```

Stage intentional source changes before `lock`, then review and commit the lock.
Refresh does not silently update a source lock. See Base's
[authoring protocol](https://github.com/runeditrun/base/blob/main/edition-authoring/README.md)
for comparisons, retained origins and release operations. To migrate from
vendored scripts, pin the package, run `rer adopt-edition`, then drop the vendored
scripts and their copy records.

Both public verbs accept `--help`, `--cwd PATH`, `--non-interactive` and `--json`.
Help exits 0 before configuration, adapters or tools. `describe --json` includes
the verbs without requiring seed adapter declarations. Their bootstrap policy
comes from the command contract: project-code commands run the seed's exact
installed package pin, installing that pin when needed.

With `--json`, stdout is newline-delimited event objects. Success ends with
`{version:1, verb, event:"result", ok:true, exitCode:0, ...details}`. Adoption
details include `adopted`, `created`, `record`, `preservedCopyRecord` and `next`.
Refresh details include `refreshed`, `record`, `copies`, `retired`, `adopted`, `adapted` and
`next`; each copy reports `path`, `from`, `files`, `added` and `removed`.
Refusal emits an `error` event with `code`, `message` and `exitCode`, then a failed
`result`; authoring safety refusals exit 4 and malformed invocations exit 2.
Node selection or package bootstrap can emit progress events before the result.
