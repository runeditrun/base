# Publication scan implementation

See [setup, command and scope](https://github.com/runeditrun/base/blob/main/scripts/publish-check-README.md).

`git_history.py` delegates revision resolution, traversal, tree inventory and
blob reads to system Git (`rev-parse`, `rev-list`, `ls-tree`, `cat-file --batch`).
Before any tree inventory asks for blob sizes, `history_hydration.py` counts
missing objects and hydrates a partial clone with one `fetch --refetch --no-filter`
from its promisor remote. The batch explicitly requests every missing object,
including selected history outside that remote's branch refspecs. A failed fetch
or remaining missing object makes the inspection incomplete and names a missing
blob and its committed path, with `fetch the full history` guidance.
`history.hydration` reports the missing counts, fetch
count and elapsed time; subsequent history reads disable lazy fetching.

Reports include implementation version, Python version and a digest of the
Python scanner source, plus total and per-phase wall times and call counts.
The release gate uses this same scanner entry point. When comparing it with a
standalone run, compare implementation digests as well as source trees:
`rer` inside a checkout runs the rer version that checkout pins, even when a
newer launcher started it. A tagged exact-source release stages its actual Git tag object in an isolated
clone and includes its message in the same full source scan. `annotationInspection`
is the staged annotation subset of that result; no second history walk is needed.
`gitleaks.py` runs the pinned scanner in git, directory and stdin modes and keeps
its report private until translating it into the value-free v3 envelope.
Hexadecimal credential assignments also use a Gitleaks rule without generic
entropy or English stopword filters. Both assignment rules go through the same
location-bound Source/module identity classification; provider and environment findings
remain independent.
`assignment.py` narrows only comma-separated pairs: the complete left token
must contain only letters, digits, underscores or hyphens. Gitleaks still
requires a secret-shaped right value, using its inherited entropy/length policy
or the hex rule. Native locations bind the check to the full key in files and
messages, so a filename or path's key-like suffix cannot become a key. Other
assignment operators retain their existing grammar.

`env_values.py` only hashes decoded dotenv values that have at least 16
characters, have Shannon entropy greater than 3.5 bits per character (the pinned
Gitleaks generic-api-key threshold), or start with a known token prefix:
`sk_`, `sk-`, `pk_live`, `ghp_`, `github_pat_`, `xox`, `AKIA`, `SG.`, or `eyJ`.
Prefix matching is case-sensitive. Ordinary short words, statuses and short
numeric IDs therefore do not become environment matches. Eligible values are still
compared only through in-memory digests and cannot be waived.
`tree_scan.py` applies the kept text and licence policy. `history_scan.py`
assigns release, working-tree and historical scopes. Inspection returns each
text's repository references instead of resolving them; `history_scan.py`
resolves the whole scan's references at once through `github_refs.py`
(GraphQL batches, a REST lookup for any repository a batch leaves in doubt) and
then adds their rules. The Node entry point bounds
the scan after slot acquisition and stops its private process group on
timeout/cancellation. `slots.py` obtains one per-user `fcntl.flock` slot before
starting the scanner. The holder watches Node's pipe for abrupt parent death;
its worker inherits the lock so it cannot outlive its slot. Queueing has its
own one-hour cap. `timeout.json` supplies the shared default and upper bound
to Python and the Node/release validator.

Git message records carry their kind explicitly. Only commit records enable the
bounded public coauthor address rule described in the command guide; a file named
`@commit-message` has no special status. `public_hygiene.py` matches complete raw
`Co-Authored-By` lines in the final trailer paragraph case-insensitively and
masks only the accepted address for email inspection, leaving names, other
addresses and every other rule intact.

`png_text.py` separates the fields of framed PNG `tEXt` and uncompressed `iTXt`
chunks before text hygiene inspection. Container length, type and CRC bytes
cannot extend a mailbox, and these explicit text fields do not use the binary
mixed-case host heuristic. Raw-byte hygiene inspection retains the original
binary classification outside those chunks; checksums do not suppress text
inspection. Gitleaks still receives the original bytes. Compressed metadata is
not decoded. `media.py` walks image and video containers to find their
pixel and sample spans; only those spans skip text hygiene, never
environment or Gitleaks inspection, and metadata around them is still text.
`c2pa.py` finds the strictly parsed X.509 certificates inside a PNG's C2PA
manifest store (`caBX`) and returns their Name and rfc822Name value spans,
which skip text hygiene the same way.

Other binary metadata decoding, Git protocol/object/ref modelling, frozen comparison,
resumable inspection and their tests have been removed. Tests live in `tests.py`
and `coverage_tests.py` and construct disposable repositories with actual Git.

`content_identities.py` binds generic-api-key and hex-api-key occurrences to
exact JSON value locations. `source_metadata.py` enumerates digest fields in the
formats emitted by `edition-authoring/cli.mjs` and `sources.mjs`: lock manifest,
toolchain, parent/baseline pins and file SHA-256 values; retained archive keys,
content digests and dependency pins; and the source origins' revision or
projection identities. These are format classifications independent of selected
graphs, canonical serialization, archive preimages and authoring freshness.
`source_shapes.py` first checks the documented local record types, immutable
origin identity, source selections and file/pin records. A malformed archive or
lock grants no identity roles; unknown extra fields never gain a role.
`provenance_pins.py` keeps the existing module revision classification.

`json_identity.py` rejects duplicate members and non-JSON constants and binds
native findings to exact string byte spans. Only documented structural fields
with the declared digest length qualify. An extra credential field, arbitrary
nested field or copy of the digest on the same minified line remains a finding.
Provider and known environment findings are independent. Native git/dir matches
stay in the private temporary report and memory; values are never added to the
public report. Authoring's integrity checks remain unchanged.

`copy_identities.py` proves the maintained `base-copies.json` and portable
`base/PROVENANCE.json` copy-inventory SHA-256 values
per entry against that file's bytes and regular-file mode in the same scanned
tree. An adapted entry must name a full commit and carry an acknowledgement:
its acknowledgement hash and mode prove the local preimage independently of
the baseline hash, which must match the regular file at the exact adapted pin
and mapped origin path in Base. Only a locally matching acknowledgement admits
an adaptation's baseline proof. Missing or invalid acknowledgements and unproved
values remain findings; one bad entry does not invalidate other proved entries.
`copy_origins.py` uses Git's normal fetch transport, like public-base acquisition,
into a disposable bare repository from the fixed `runeditrun/base` remote. It
fetches only full pinned revisions with depth one, no tags or submodules, no
lazy fetching, a 30-second command deadline, and no retries. The ledger cannot
select another remote. Each scan allows at most 32 origin revisions and 4,096
origin file reads, cached including failures; each JSON copy proof considers at
most 4,096 entries. Over-budget or unavailable preimages remain findings. The
outer scanner deadline still applies and temporary origin objects are removed.
Historical matches use only that commit's blobs; present files cannot
rescue a historical mismatch. Working-tree preimages reject linked paths.
Copy records use the same proof at custom JSON paths.
The captured secret must occur unambiguously inside the exact proved JSON value;
a native fragment ending partway through a digest qualifies too. The same value
in another field remains a finding. There is no filename, hash-value or
comma-delimited credential exemption.

`checksum_maps.py` classifies a file-name to digest map (`'0005_operator_auth.sql':
'<sha256>'`, in JSON, JavaScript, YAML or similar) in any file outside the
content-identity documents above. The native match must sit in a run of
`name: digest` entries separated only by commas, semicolons, whitespace and line
comments, and every entry in that run must name a regular file in the same scanned
tree (a path, or a trailing path component) whose bytes hash to that SHA-256. One
entry that does not prove, a 40-hex value, a key that names no tree file, or a hex
value with no file-name key keeps the native finding. Historical matches use only
that commit's blobs and working-tree preimages reject linked paths. There is no
path, filename, hash-value or repository exemption. `hit_location.py` resolves
the native match's exact bytes for both proofs.

`trust_bundle.py` classifies an email match as public CA certificate metadata
only when all of these hold: the file's path is an artifact listed by a committed
`trust-bundle.json` in its directory and its bytes hash to the SHA-256 pinned
there; that manifest's webpki-roots release and checksum are exactly the one the
same directory's `Cargo.lock` locks from crates.io; and the match lies entirely
inside an attribute value of a subject Name parsed (`der.py`, strict DER) from
those bytes, where the anchor's subject Name and SubjectPublicKeyInfo DER both
occur in the file and hash to one anchor entry of the manifest. With the verified
subject values blanked, no email may remain, and every match must be one found
inside them; otherwise the file keeps `hygiene.email`. Historical blobs use their
own commit's manifest and lock; working-tree files use the selected commit's.
The build that produces the artifacts (`modules/egress-service/tls/build.mjs`)
regenerates the manifest, and its `--check` mode rejects a stale one. An
alphabetic top-level domain label ends before a following digit, so a match
ends at the DER string's boundary rather than absorbing the next tag byte.

`controller_metadata.py` recognizes the standalone controller review manifest by
its exact four-field structure, immutable source revision, descriptor digest,
relative directory list and path-to-SHA-256 file map, at any JSON path. Only
those digest value locations qualify. Extra fields, malformed paths or digests
retain findings. The live-proof controller still independently checks all copied
file bytes against the pinned source before execution; the scanner does not claim
to fetch that source. Provider tokens and known environment values remain findings.
