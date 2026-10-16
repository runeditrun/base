# `rer release`

Before a Base release, run `pnpm verify:scale` for the full import-kit datasets. It
is not part of `pnpm verify`: run it on a machine with at least 16 GB of memory and
nothing else heavy running, because its D1 datasets are large.

Set `PUBLIC_PROJECT` to the edition's project identity and `PUBLIC_REPOSITORY`
to its public GitHub destination URL. From Base, run:

```sh
pnpm rer release --repo /path/to/seed --ref main \
  --project "$PUBLIC_PROJECT" --repository "$PUBLIC_REPOSITORY" \
  --output /path/to/new-release-directory
```

The `rer` bin and `node bin/rer.mjs` expose the same command. Node 22+, Python 3,
Git, pnpm and tar are required. Use a full, clean seed clone with its declared
package-manager version and browser prerequisites available. The producer reads
committed `seed.json`, `package.json`, `RELEASE.json`, `LICENSE`, `CONTRACT.md` and
`AGENTS.md`. Version declarations must agree. `--project` declares the publishing
identity; `--repository` is the credential-free public destination URL. Neither is inferred
from repository naming or old site listings.

When either `edition.json` or `rer-project.json` exists, both must be ordinary
committed JSON objects. Before installing dependencies, running verification,
creating output or tagging, the producer requires `edition.json.id` and
`rer-project.json.projectId` to agree with `--project`. Separately,
`rer-project.json.sourceRepository` must agree with `--repository`. If
`edition.json.custody.repository` is present it must agree with `--repository`
too; the custody declaration is optional. The project identity may differ from
the repository identity. Repository fields are credential-free HTTPS GitHub
URLs; identity comparison ignores case and a terminal `.git` in URLs. Missing,
malformed, partial or inconsistent identities fail closed. The selected
committed tree supplies the declarations.

The platform reads these same HTTPS GitHub URLs, plus bare an owner and repository name separated by a slash for releases that carry it; ordinary release editions still require the URL here.

Every publication scan receives the explicit project and destination: source
history, staged final annotations, parentless exports and dry runs. If GitHub's
API returns a complete Not Found response with HTTP status 404 for that exact
agreed repository destination, references to it are `pending-public-destination`
with severity `INFO` in the report's `info` array. Other missing repositories and
existing private repositories, including the agreed target, still fail. A distinct project identity receives ordinary
reference checks. Empty, malformed or unresolved API responses remain
INCOMPLETE. This rule does not exempt other defects in the same file or message
and does not authorize publication. Legacy sources with neither declaration
accept independent project and repository inputs, retain strict reference checks
and cannot receive this INFO classification.

It installs frozen dependencies and runs `pnpm run verify` in a disposable clone
of the exact selected commit, then scans source history with publish-check.
When the checkout's origin is a confirmed public repository, the scanner uses
that source repository's advertised default branch and published tags as its public
base. Already-public findings are classified pre-existing; unpublished content
still blocks. Other sources retain complete local-ref history inspection.
A verify that mutates tracked source fails.
When declared in the committed package, it runs `pnpm run verify:release` after
default verification succeeds. Keep capacity, maximum-size memory and load cases
in that release-only script. Both dry runs and releases require it to pass;
`gates.verify.release` records its result. Routine CI and default verification
do not invoke it.
A passing step's receipt retains exit status and numeric final summaries from
Node's spec/TAP reporters and Playwright's text reporters. A failing install,
`verify` or `verify:release` step also keeps `output`: the last 40 lines (at most
8 KB) of that child's output, after the command store's credential redaction.
The output stays in the receipt and is left out of the site preview. Counts add across suites: `tests`, `passed`,
`failed`, `skipped` and `flaky`; nonzero `cancelled`, `todo`, `interrupted` and
`notRun` counts are retained when reported. Playwright's total includes each
outcome once, with flaky tests counted separately from passed tests. Node's
reported total is used directly. Unrecognized output is suppressed and contributes
no counts; the child exit status still determines the verification gate. Source
metadata and Git blobs are never loaded as producer code.

With `--tag`, passing gates produce `public-source.tar`, containing the checked tree's
exact ordinary files without Git history, and a hash-pinned site bundle:
`site/<id>/<version>/release.json`, published documents and `site/registry.json`.
Export attributes cannot silently omit or substitute bytes. The site metadata
comes from committed seed and contract data; no screenshots, install guarantees
or verified maturity claims are invented. Copy the reviewed bundle into the site
release registry through its normal review process; the one-entry generated
registry is input for that integration, not a replacement for the site's registry.

By default, success writes only the receipt, publication report and site preview;
its provenance says `publication: dry-run`. It creates no tag or source archive.
Pass **`--tag`** to create an annotated local `v<version>` tag at the verified
commit and the exact source export. Existing tags are never changed. The command
**never pushes,
changes repository visibility, dispatches Actions, deploys or edits a site**.
Publication and deployment retain their separate owner authorization.

`--dry-run` performs the real install, verify and history scan and suppresses
tag creation even with `--tag`. `--tag --dry-run` also prepares the source archive
for inspection. Existing tags do not prevent previews.
If gates fail, it exits 1, omits the source export, records BLOCKED in
`release-receipt.json` and still prepares a site preview whose provenance says
`publication: blocked`, with the actual gate results. That preview is for local
review and must not enter the public registry. Blocked `--tag` releases without
`--dry-run` produce only the receipt and redacted publication report. A bare
blocked release still writes the blocked preview. Invalid inputs exit 2. Outputs
must be new directories outside the source and may not traverse symlinks.

The first producer supports MIT seed listings and ordinary-file source trees.
Service integration bundles remain outside this command. Run producer tests
with `pnpm verify:release`; fixtures never replace seed verification in a pilot.

For a first public release whose private development history must stay private,
add `--clean-history --env-file /path/to/credentials.env`. The default history
gate is unchanged. This explicit mode constructs an ordinary-file parentless Git
repository, verifies its tree equals the selected source tree, and runs the full
history scanner against that actual public export, including environment hashes.
Passing tagged releases include `public-git/` with `main` and an annotated release
tag. The private source tag points to the verified private commit; the export tag
and site provenance point to the parentless public commit. The receipt records
both identities and `publicationHistory: parentless-export`. Never push private
source history to the public repository. Neither mode publishes anything.

Public export commit and annotated-tag messages contain the version and optional
`RELEASE.json.publicReleaseNotes` only. Private source commit identities stay in
the private release receipt. The clean export's final annotated tag exists
before publication inspection, and the checked repository is copied unchanged
into `public-git/`. Ordinary releases inspect their source history and stage the
exact final annotation in a disposable checkout for inspection before creating
the source tag. Release notes pass the same content rules as the public tree.

## Releasing a seed that is already public

Release the exact green source commit with the ordinary command:

```sh
pnpm rer release --repo /path/to/public-seed --ref GREEN_COMMIT \
  --project "$PUBLIC_PROJECT" --repository "$PUBLIC_REPOSITORY" \
  --tag v1.2.3 --output /path/to/new-release-directory
```

Both source-history and staged-annotation scans receive the repository's public
base. Public annotated tags, including the previous release, are fetched into
the scanner's isolated namespace and recognized by their exact object identity.
The selected source commit and final tag target are preserved.

Use `--public-base GIT_URL#BRANCH` to select public history explicitly, including
when the checkout has no public origin. The scanner fetches that remote branch
and its public tags; local refs and commit IDs cannot establish public history.
This option applies to exact-source releases and cannot be combined with
`--onto` or `--clean-history`.

Use `--onto` to create one public child of the destination's current branch from
an independently developed private source tree:

```sh
pnpm rer release --repo /path/to/private-seed --ref main \
  --project "$PUBLIC_PROJECT" --repository "$PUBLIC_REPOSITORY" \
  --onto "$PUBLIC_REPOSITORY#main" --tag v1.2.3 --dry-run \
  --env-file ~/.env --output /path/to/new-release-directory
```

The committed version must match the tag. The credential-free `--onto` URL must
match `--repository` and the committed destination declarations; its explicit
branch must exist in a confirmed PUBLIC repository. Pending, private, unresolved
or ambiguous destinations and an existing public version tag are refused.
`--onto` and `--clean-history` are mutually exclusive.

The producer pins the advertised public tip, installs frozen dependencies and
runs the exact selected private commit's real verification. It builds an
isolated public repository containing only public ancestry and the selected
source blobs. The new commit has exactly the pinned public tip as its sole
parent, and its tree must equal the private source tree, including executable
modes and raw blob bytes. Attributes cannot change or omit source content.
Private source commits and refs are never imported. Public commit and annotated
tag messages contain only `vVERSION` and optional trimmed
`RELEASE.json.publicReleaseNotes`.

The actual final annotation is staged before the real publication inspection,
which receives `--public-base` for the declared destination. Only PASS with
complete history inspection and that exact pinned base can produce artifacts.
The destination's visibility, branch tip and absent version tag are checked
again after scanning and immediately before final handoff. A changed, removed,
unresolved or ambiguous head blocks the artifact; start again against the new
public tip. The producer never pushes anything.

A passing tagged run writes `public-git/`, `public-source.tar`, the site bundle,
`publish-check.json`, `release-receipt.json` and `PUBLISH.md`. The receipt uses
`publicationHistory: public-child`, names `publicParent`, and records the public
commit, exact tree and annotated tag object. Site provenance names the public
child. `--tag vVERSION --dry-run` prepares and scans the same public tag and
handoff without changing any private source tag. Without `--dry-run`, success
also annotates the selected private source commit as in existing modes. An
untagged run remains a preview without public Git/archive/handoff artifacts.

Review the report and receipt before publishing. The generated `PUBLISH.md`
contains this complete shell sequence with concrete artifact-specific values;
the angle-bracket values below mark those substitutions. Run the generated
commands as written, from any directory, without changing their values:

```sh
set -eu
artifact='<ARTIFACT_DIRECTORY>'
cd -- "$artifact/public-git"
release_output=$(node -e 'const fs=require("node:fs"),c=require("node:crypto"); process.stdout.write(c.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$artifact/release-receipt.json") || exit 1
test "$release_output" = '<RELEASE_RECEIPT_SHA256>'
release_output=$(node -e 'const fs=require("node:fs"),c=require("node:crypto"); process.stdout.write(c.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$artifact/publish-check.json") || exit 1
test "$release_output" = '<PUBLISH_CHECK_SHA256>'
release_output=$(node -e 'const fs=require("node:fs"),c=require("node:crypto"); process.stdout.write(c.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$artifact/public-git/.git/config") || exit 1
test "$release_output" = '<PUBLIC_GIT_CONFIG_SHA256>'
# Discard inherited Git overrides while keeping authentication in the environment.
release_git() {
  node -e 'const cp=require("node:child_process"); const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith("GIT_") && k!=="GH_DEBUG" && k!=="DEBUG")); Object.assign(env,{GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null",GIT_NO_REPLACE_OBJECTS:"1",GIT_GRAFT_FILE:"/dev/null",GIT_TERMINAL_PROMPT:"0"}); const result=cp.spawnSync("git",["--no-replace-objects","-c","core.hooksPath=/dev/null","-c","core.useReplaceRefs=false","-c","push.followTags=false","-c","credential.helper=","-c","credential.helper=!gh auth git-credential",...process.argv.slice(1)],{env,stdio:"inherit"}); process.exit(result.status??1);' -- "$@"
}
release_output=$(release_git rev-parse --show-toplevel) || exit 1
test "$release_output" = "$artifact/public-git"
release_output=$(release_git rev-parse HEAD) || exit 1
test "$release_output" = '<PUBLIC_COMMIT>'
release_output=$(release_git rev-parse 'HEAD^{tree}') || exit 1
test "$release_output" = '<PUBLIC_TREE>'
release_output=$(release_git rev-list --parents -n 1 HEAD) || exit 1
test "$release_output" = '<PUBLIC_COMMIT> <PINNED_PARENT>'
release_output=$(release_git cat-file -t 'refs/tags/<VERSION_TAG>') || exit 1
test "$release_output" = tag
release_output=$(release_git rev-parse 'refs/tags/<VERSION_TAG>') || exit 1
test "$release_output" = '<ANNOTATED_TAG_OBJECT>'
release_output=$(release_git rev-parse 'refs/tags/<VERSION_TAG>^{commit}') || exit 1
test "$release_output" = '<PUBLIC_COMMIT>'
release_output=$(release_git ls-remote --refs -- '<DESTINATION_URL>' 'refs/heads/<DESTINATION_BRANCH>' 'refs/tags/<VERSION_TAG>') || exit 1
test "$release_output" = '<PINNED_PARENT>	refs/heads/<DESTINATION_BRANCH>'
release_git push --atomic --no-follow-tags -- '<DESTINATION_URL>' '<PUBLIC_COMMIT>:refs/heads/<DESTINATION_BRANCH>' '<ANNOTATED_TAG_OBJECT>:refs/tags/<VERSION_TAG>'
```

The receipt, report and Git config hashes bind the handoff to the reviewed
artifact. The local checks require the exact commit, tree, sole parent,
annotated tag object and peeled commit. The remote check requires exactly the
pinned branch parent and no version tag. The final command makes one ordinary
atomic push of that commit and tag; it never forces, rewrites history or pushes
private refs. A failed guard requires a fresh artifact. Keep the private source
tag in the private repository.

Generated source commits and annotated tags identify Run Edit Run with the
non-contact address `releases@runeditrun.invalid`. Provenance remains bound to
the source commit and tree; the Git author address is not a delivery destination.

## Signing and checking release receipts

`rer release keygen` creates a publisher key and its proof-of-possession anchor
entry; `rer release sign` signs a completed tagged release; and
`rer release receipt` verifies that detached signature against a local anchor
set. Use `--scope test` for development. The owner's production `rer` key is a
later vault operation and is not generated during this work; the owner will
create it directly in the vault.

Key generation accepts `--scope test|rer --publisher NAMESPACE
--github-owner LOGIN --github-owner-id ID --anchor-out FILE`, with optional
`--not-before YYYY-MM-DDTHH:MM:SSZ`, `--not-after YYYY-MM-DDTHH:MM:SSZ` and
repeatable `--unsigned-through PROJECT:VERSION`. `--anchor-out` receives one
public anchor entry with its enrolment proof and pending review status; it is
not a complete anchor set. On success the PKCS#8 private key goes to stdout
only when stdout is not a terminal. Pipe it directly to the owner's vault;
never send private key bytes to a terminal, repository, log or evidence. The
signer accepts `--artifact DIR` and exactly one of `--key-file FILE` or
`--key-stdin`, with `--scope test|rer` (default `rer`). Read production
signing material from the vault through `--key-stdin`; `sign` never echoes it.
`--key-stdin` refuses terminal input; pipe the key from a vault or file instead.

Signing requires `release-receipt.json` to record a completed `RELEASED`
tagged release with a created public tag. It writes the detached DSSE envelope
as `rer-release.dsse.json` beside the receipt. The statement binds the public
repository, tag, commit, tree and tag object, and hashes `public-source.tar`,
`release-receipt.json`, `publish-check.json`, the bundle's single
`site/<id>/<version>/release.json`, and every document under that bundle's
`documents/` directory. The envelope is an artifact file; signing does not
change the existing release or registry pins.

After writing the signature, `sign` prints (but never runs) a shell-quoted
`gh release upload` command for attaching `rer-release.dsse.json` to the
already-created GitHub release. The emitted command has this form:

```sh
gh release upload 'TAG' '/absolute/path/rer-release.dsse.json' --repo 'OWNER/REPOSITORY'
```

Review and run the actual printed command to upload the asset. `sign` itself
performs no upload.

Receipt verification accepts `--artifact DIR --anchors FILE`, optional
`--environment test`, and optional `--after VERSION:SHA256`; the environment
defaults to `production`. It checks the artifact and detached signature using
the same offline verifier used by signing. Exit 0 prints
`{"verdict":"VERIFIED"}`; exit 1 prints a refusal code as
`{"verdict":"REFUSED","code":"..."}`; invalid arguments exit 2. A
Base receipt check always requires a signature and refuses a missing envelope
with `SIGNATURE_MISSING`, even where site or service consumers accept a legacy
unsigned listing.

The dependency-free verifier source is `modules/release/signature.mjs`; it has
no `node:` imports and is exported as
`@runeditrun/rer/modules/release/signature`. Its default-seed portable copy is
generated byte-for-byte at
`default-seed/scripts/base-cli/modules/release/signature.mjs`. Shared public
test vectors live in `modules/release/vectors/release-signature-vectors.json`
and are generated byte-for-byte at
`default-seed/scripts/base-cli/modules/release/vectors/release-signature-vectors.json`.
The vectors use the existing public Octocat example repository context with synthetic bundle bytes and throwaway test keys; they do not represent an actual release.
Consumers vendor and pin the verifier source by Base commit and SHA-256.
