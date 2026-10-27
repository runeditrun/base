# Publication hygiene

Install system Git, Node, Python 3 and `gh`. Install the pinned scanner on macOS
or Linux with `bash scripts/install-gitleaks.sh`; it downloads Gitleaks 8.30.1
from its upstream release and verifies the platform archive's committed SHA-256.
The default destination is `~/.local/bin`; CI bootstrap calls the same installer
with `GITLEAKS_INSTALL_DIR=/usr/local/bin`. ARM64 and x64 are supported on both
systems. No Git source build is required.

`pnpm publish-check --repo /path/to/seed --ref main` writes one redacted JSON
report. Exit codes remain 0 for PASS, 1 for FAIL and 2 for INCOMPLETE. Optional
arguments remain `--public-base <url>#<branch>`, `--project <owner>/<repo>`,
`--repository https://github.com/<owner>/<repo>`, `--env-file /path/to/file`,
`--cache-dir /path` and `--timeout-seconds N`. The default total deadline is
300 seconds and the maximum is 7200; expiry stops the scan's process group and
returns INCOMPLETE. The deadline starts after acquiring a machine-wide per-user
scan slot. Up to three scans run at once; `RER_SCAN_SLOTS` accepts an integer
from 1 to 8 to adjust that limit. Advisory locks in `~/.cache/rer/scan-slots`
are released automatically when their holders exit. A queued scan prints
`waiting for a scan slot` once to stderr and polls every two seconds. Waiting
does not consume its scan deadline; after 60 minutes it returns INCOMPLETE with
`scan.slot-timeout`. `rer release --scan-timeout-seconds N` forwards an integer
from 1 to 7200 to this deadline; omitting it keeps the 300-second default.
`--cache-dir` is accepted for caller compatibility and no
longer creates a resumable cache.

Invalid flags, missing values, invalid timeouts and malformed `--public-base`
arguments return INCOMPLETE (exit 2) with one `scan.usage` finding. Its `message`
names the argument problem and its `validFlags` lists the accepted flags. Only
flag names are echoed; argument values stay out of the report and diagnostics.
The same message appears on one stderr line pointing to `--help`, which prints
the command's usage. Other incomplete scans retain their existing rules, such
as `scan.public-base-rejected` for an unavailable or refused remote base,
`scan.deadline-exceeded`, `scan.interrupted` and `scan.worker-incomplete`.

Output change: the v3 report now includes `scanner` and secret findings include
Gitleaks `scannerRule`; binary/parser guarantees, limits and cache details are removed.

The working tree (including untracked and ignored files) and every commit
reachable from local refs plus the selected commit are scanned. Git object
storage and installed `node_modules` are excluded from the working-file scan;
tracked files in those paths still receive the history scan. Use a full clone:
shallow history, missing Git objects, unreadable inputs, submodules, LFS pointers,
scanner failures and unresolved GitHub visibility return INCOMPLETE.

Gitleaks' built-in rules detect stored provider tokens, private keys and generic
API-key literals. Explicit synthetic credential values carrying a leading fixture/test/example
marker, synthetic JWT signatures and PEM bodies are allowed, independent of
the containing path. Comma-delimited prose and file-to-SHA-256 manifest entries
are not credential assignments.
There is no blanket tests or documentation exemption. Known values from an
explicit dotenv file are compared in memory and cannot be reviewed away.
The scanner never executes that file and reports neither values nor hashes.

Generic assignments at module-provenance locations are public Git object IDs
when their values are exactly 40 lowercase hexadecimal characters:
`components[].source.moduleRevisions` for Git sources,
`components[].source.origin.moduleRevisions` for local sources in `edition.json`
and `sources.lock.json`, and `moduleCommits` in `base/PROVENANCE.json`.
Classification binds the native finding to that exact JSON value. Other fields,
non-digest credentials and provider-token rules retain their findings. The Base-generated `sources.lock.json` format identifies `manifest`,
`toolchain.sha256`, `parent.{key,digest,sha256}`,
`components[].baseline.{key,digest,sha256}`, and `files[path].sha256` as SHA-256
digests. Retained `.edition/sources/<sha256>.json` archives identify their root
`key`, `digest` and `dependencies[].{key,digest,sha256}` likewise. The `key` is
itself a digest of the source origin. Source origins in lock components and
archives identify `revision` as a 40-character Git commit, or
`projection.{originalSha256,recipeSha256}` as SHA-256 digests.

These specific structural JSON locations are metadata even when a lock is
stale, an archive is unselected, or original preimages are unavailable.
Authoring's integrity checks remain separate. Strict JSON parsing and exact
native match locations are required; other fields, nested lookalike fields and
the same value elsewhere on a minified line receive no exemption. Known
environment values and provider-token rules always retain their findings.
Copy inventories keep their separate same-tree content proof.

Text policy covers personal emails, absolute macOS/Linux/Windows home paths,
private or missing GitHub repository references and licence files. Reserved
example/test/invalid email domains are accepted. A committed
`.publish-check/config.json` with `schemaVersion: 1` can list exact `publicEmails`
and optional `internalReferencePatterns`. Source provenance bound to declared
repository and revision pairs retains its existing treatment; ordinary private
repository mentions fail. Commit and annotated-tag messages are scanned, excluding
Git author/committer identity headers. Matched values and messages are never printed;
sensitive paths receive opaque SHA-256 handles.

In files whose basename is `pnpm-lock.yaml`, `hygiene.email` can ignore a
single or double quoted scalar only at the unquoted `deprecated` key (allowing
spaces before the colon), at four-space field indentation of a two-space package
entry in the top-level `packages:` block mapping.
The scan consumes multiline quoted scalars with their escapes, continues plain
and block scalars by indentation and tracks nested flow collections; nested
fields, quoted keys, plain or block values, comments, trailing text, other
sections (including `snapshots:`) and other filenames remain inspected.
Unsupported or ambiguous structure, including anchors, aliases, structural tabs, unterminated
quotes or inconsistent indentation, disables every exemption in that file;
all other rules always apply.

In actual commit messages only, `hygiene.email` accepts the address in a complete,
case-insensitive `Co-Authored-By: Name <address>` line in the final trailer
paragraph when its local part is
`noreply` at the `anthropic.com` or `github.com` domain, or a numeric ID plus `+`
plus a GitHub username at `users.noreply.github.com`. The name and all other
addresses remain inspected. This does not apply to ordinary body addresses,
other trailers, annotated tags or files, and does not affect secret or other
hygiene rules. A trailer-looking line followed by ordinary prose remains body
text; the final paragraph must consist entirely of trailer lines.

Other classifications use content shape. A package manager's patch filename, consisting of a package name, an at sign
and a semantic version with the `.patch` suffix, is not a mailbox. Inside binary data (control bytes or
invalid UTF-8), a mailbox whose host name has mixed-case letters within a label
(`iM.jDe`) is not one; stored host names are lower case, upper case or
capitalised. PNG `tEXt` and uncompressed `iTXt` fields are inspected separately
as text, without surrounding chunk framing or CRC bytes. Their mailboxes retain
mixed-case domains. In GIF, PNG, JPEG, WebP, ICO, MP4/AVIF and WebM files the
pixel and sample data (GIF image data and colour tables, PNG `PLTE`/`IDAT`/`fdAT`,
JPEG scans, WebP `VP8 `/`VP8L`/`ALPH`/`ANMF`, ISO `mdat`, WebM clusters) gets no
text hygiene: it can spell an address or path by chance. Every other byte, such as a
comment, XMP, EXIF or a video tag, is still inspected. A JPEG whose first image
is followed by more (a phone's depth and gain-map images) has every image walked.
In a PNG's C2PA manifest (`caBX`), the issuer and subject names and alternative
email names of the X.509 certificates it carries are certificate metadata and get
no text hygiene; the rest of the manifest is inspected. A file is media only when
its bytes walk as one complete container to the end of the file (NUL padding
aside); an MP4/AVIF file needs a sized `ftyp` box with a known brand and a
`moov` or `meta` box. Text renamed `.gif` or an image with text appended is
still inspected whole. Known environment values and Gitleaks still see all
media bytes. Other binary content keeps the shape rule above.
A bare `word/word` in prose (`commit/tree`, `rer-delegation/1`,
`` font resource version tokens ``) with no GitHub context nearby (a URL, a repository field, a
label or command, `repository`, `clone`, `fork`, `upstream`, a repository route)
is a repository only when one exists privately; a missing answer proves nothing.
Stated references to missing repositories still fail.

POSIX home prefixes retain their canonical case (`/Users/` and `/home/`); Windows
home paths are case insensitive. Lowercase application URLs such as `/users/profile`
do not identify Mac home directories. Canonical copy inventories identify their
acquisition repository as source provenance only when every copy carries a
declared exact revision, valid path, file digests and matching modes. An undeclared
revision or malformed inventory retains the repository finding.

Base's [`publication-config.json`](./publish-check/publication-config.json) is the
single maintained list of exact owner-declared intended public repository names,
with the reason for each. These identities will be created by clean-history export
at the first public tag; ordinary source references to them need not already exist
or be public. This does not claim verified public availability. Seed configuration
cannot extend the list, and other private, missing or unresolved references retain
their findings. An explicitly supplied release destination still receives the
strict visibility and committed identity checks described below.

Every historical tree and current working tree needs a root LICENSE with
copyright holder lines. Holders must be `Run Edit Run` or have a dated exception
in selected `PUBLISH-EXCEPTIONS.json` or Base's `license-exceptions.json`, bound
to the exact licence bytes with `rule`, `path`, `holder`, `date`, `sha256`, and
`reason`. This checks publication policy, not legal validity.

## Reviewed findings

A selected `.publish-check/reviewed.json` may contain exact rule/path/blob
identities with nonempty `reason`, `reviewer` and `date` for only these reviewable
rules:

- Hygiene: `hygiene.local-path`, `hygiene.github-private`,
  `hygiene.github-missing`, `hygiene.email`, `hygiene.internal-reference`.
- Generic Gitleaks findings: `secret.assignment`, `secret.private-key`,
  `secret.jwt`, `secret.url-credentials`, `secret.authorization`,
  `secret.shaped-file`.
- Licence holder: `license.holder`.

SEC-3 credential assignments are **non-reviewable**, even for a verified
synthetic test constant and an exact matching rule/path/blob identity. Other
credential-class rules outside the list above are also non-reviewable; there is
no blanket credential waiver. Provider tokens (`secret.provider-token`), known
environment values (`secret.env-match`) and missing licences (`license.missing`)
cannot be waived. Their review records are parsed for compatibility, but a
matching finding stays blocking and adds `reviewed.forbidden`. Any rule outside
the accepted review schema, including SEC-3, rejects the review document and
makes the scan `scan.configuration-incomplete`.

First establish whether a flagged value is a credential. Remove and rotate real
credentials. For a verified synthetic constant, rewrite the constant so it no
longer matches, using the leading fixture/test/example marker semantics described
above, then rescan. Changing the working file does not clear historical findings:
re-author an unpublished commit to remove the matching literal, or use the
approved clean-history publication path (`rer release --clean-history`) when
retaining private history. Do not add a SEC-3 review record to bypass the finding.

## Coverage limits

Historical binary metadata decoders and contained-fixture inspection are
removed, along with screenshot and file-size policy. Existing contained-fixture
review fields are accepted for command compatibility without decoding them. Compressed archives,
compressed PNG text, other image metadata, C2PA, CBOR, COSE, JUMBF and exotic Git
parity are not covered.

An explicit `--public-base` is fetched with system Git into
`refs/publish-check/public/base`, with published tags fetched into
`refs/publish-check/public/tags/`. It scopes the history scan to the selected
release and public branch/tag ancestry. Exact public tag annotations and
already-public commit messages, including the selected commit's message, move to
`preExisting`. Historical already-public findings move to
`preExisting`, and so does a selected-tree or working-tree file byte-identical
to the same path at the public base's tip; other selected-tree and working-tree
findings and every known environment match still block. A newly public historical missing licence is a warning only when
the selected licence passes. No checkout, history rewrite, visibility change or
push occurs. The command scans local available history; it does not inventory
unreachable objects or reflogs.

Explicit project/repository inputs retain the existing committed edition and
project identity agreement checks. A confirmed GitHub 404 for the agreed pending
destination appears as `pending-public-destination` in `info`; a private or
unresolved destination fails. `gh` supplies existing authentication only for
visibility queries and Git's remote fetch uses its normal configured transport.

The scan collects every GitHub repository reference first and resolves them
together: one aliased GraphQL query per 100 repositories (`gh api graphql`, which
draws on GitHub's separate GraphQL budget), so a scan costs a few calls instead
of one per repository. A repository is public or private only from a complete
answer for it that is neither disabled nor locked, and missing only from
GitHub's own not-found error for exactly that name. Any other answer for one
repository, or a batch that is not a complete HTTP 200 GraphQL document, sends
that repository to the single REST lookup (`gh api repos/<owner>/<repo>`), whose
strict 200/404 reading decides public, private, missing or incomplete. Verdicts
are kept in memory for one run only.

Run the retained real-repository fixtures with `pnpm verify:publish-check`.
Apply publication scans to every public export, including Base. Retained private
authoring archives are separate from the public acquisition source.
