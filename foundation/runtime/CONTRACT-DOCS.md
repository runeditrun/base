# Contract document commands

`CONTRACT.md` is the only acceptance text and status source. Follow the format
under "Contract status" in `SEED-COMMAND-CONTRACT.md`. Keep `contract-docs.mjs`
and its relative imports beside the existing `seed-contract.mjs`; use that
actual directory in every command below. Run from the runnable seed root.

## Generate and check

```sh
node src/base/contract-docs.mjs write
node src/base/contract-docs.mjs check
rer check
```

`write` regenerates `ACCEPTANCE.md`, `docs/CLAIMS.md` and the three Status
summary rows. Never edit these outputs by hand. `check` is read-only and fails
on stale outputs; run it in CI. Commit generated outputs with each contract
change. `rer check` validates parser structure and existing evidence paths;
it does not prove acceptance. Report Core done and full-target done together.

## Rewrite records

```text
node src/base/contract-docs.mjs convert --old <ref> [--old-acceptance <ref>] [--claim-map <file>]
node src/base/contract-docs.mjs id-map --old <ref-or-tracked-file>
node src/base/contract-docs.mjs coverage init --old <ref>
node src/base/contract-docs.mjs coverage check --old <ref>
node src/base/contract-docs.mjs coverage rebase --from <ref> --onto <ref>
```

`convert` starts a current-format rewrite; inspect its proposed placement.
`id-map` generates `docs/contract/ID-MAP.json` from From metadata and retired
rows. Coverage commands manage `docs/contract/COVERAGE.json`: initialize against
the old main revision, place every old sentence and gap, then check. After a
rebase, move coverage from the previous old reference to the new main revision,
place newly changed lines, regenerate the ID map against that same revision,
and check coverage again. A structural rewrite preserves scope, clause status,
evidence and the last judged commit and date; it never promotes status.

### Historical claim references

`convert --old` reads the recorded snapshot, including its handwritten claims
files. Editing the working contract or claims file does not change that input.
Conversion uses the largest original homepage claims source; errors name its
file, original line and exact claim. Valid product links need no mapping.

For historical OWN references, boundary labels or empty cells, pass a reviewed
JSON claim map. Its `old` must be the full original SHA. Each entry identifies
one selected source row by `file`, one-based `line` and exact `claim` cell text;
`clauses` lists distinct product IDs defined in that original contract. Supply
one entry per row needing repair. Unknown rows/IDs, duplicate entries, changed
text, empty lists, stale SHAs and unresolved claims refuse before output writes.
The caller must establish that each link represents the actual obligation;
the tool checks identity and existence, not semantic equivalence. An ownership
or boundary statement without a corresponding product obligation cannot be
made valid by inventing a link or assigning it a completed status.

Here is a complete example from a seed root with the synthetic legacy sample's
`docs/CLAIMS.md`: its identity claim cites `OWN-01`, its private-drafts claim
cites `Honest boundaries`, and its archive claim has an em dash. The original
contract actually requires identity/owner preservation in `E1`, private drafts
in `PUBLISH-01`, and readable archives in `AUTH-HOST-01`. Adjust these reviewed
claim/ID pairs to the real obligations when applying this procedure elsewhere.

```sh
export CONTRACT_OLD="$(git rev-parse main)"
node --input-type=module <<'JS'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
const old = process.env.CONTRACT_OLD, file = 'docs/CLAIMS.md'
const lines = execFileSync('git', ['show', `${old}:${file}`], { encoding: 'utf8' }).split('\n')
const reviewed = [
  ["Keep each entry's identity", ['E1']],
  ['Draft entries stay private', ['PUBLISH-01']],
  ['Archived entries remain readable', ['AUTH-HOST-01']],
]
const claims = reviewed.map(([claim, clauses]) => {
  const matches = lines.flatMap((text, index) => text.split('|')[2]?.trim() === claim ? [index + 1] : [])
  if (matches.length !== 1) throw Error(`Expected exactly one original row for ${claim}`)
  return { file, line: matches[0], claim, clauses }
})
writeFileSync('claim-map.json', JSON.stringify({ schema: 1, old, claims }, null, 2) + '\n')
JS
node src/base/contract-docs.mjs convert --old "$CONTRACT_OLD" --claim-map claim-map.json
node src/base/contract-docs.mjs check
node src/base/contract-docs.mjs id-map --old "$CONTRACT_OLD"
node src/base/contract-docs.mjs coverage check --old "$CONTRACT_OLD"
node --input-type=module <<'JS'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const read = name => JSON.parse(readFileSync(`docs/contract/${name}.json`, 'utf8'))
assert.equal(read('ID-MAP').old, process.env.CONTRACT_OLD)
assert.equal(read('COVERAGE').old.commit, process.env.CONTRACT_OLD)
JS
```

Keep the same original SHA for conversion, ID map and coverage. Preserve the
map for review alongside the rewrite. Conversion retains all claim text/rows,
archives historical references in `CHANGELOG.md` and coverage, and changes only
the selected claims' clause cells. Final `write`/`check` still require existing
product IDs and compute statuses from the unchanged clause statuses.

## Regenerate before locking

An edition carrying the edition-authoring tool and source lock runs generation
before its lock command. Put these lines in its `AGENTS.md`, using actual paths:

```text
Lander-Regenerate: node src/base/contract-docs.mjs write
Lander-Regenerate: node scripts/edition-authoring/cli.mjs lock
```

Then run the generator's `check` and the edition's source check. Foundation
initialization stamps `BASE_COMMIT` and `BASE_DATE` consistently in the contract
and its generated documents. After editing the contract, run `write` before
checking, locking or publishing. Authoring input folders
are not runnable editions, and placeholders are not a real judged revision.

## Record copied source

Copy the generator and relative imports from one immutable Base commit.
For each new copied file, record the destination, Base origin and full commit:
```sh
node scripts/edition-authoring/cli.mjs record-base src/base/contract-docs.mjs foundation/runtime/contract-docs.mjs FULL_40_HEX_COMMIT --base /absolute/base-checkout
node scripts/edition-authoring/cli.mjs verify-base --base /absolute/base-checkout
```

`record-base <path> <origin-path> <revision>` takes no repository positional
argument; `--record <file>` selects a record instead of `base-copies.json`.
It records Base bytes and modes, never copies files or accepts local drift.
Use the existing refresh workflow for an already recorded directory; records
must not overlap. Regenerate outputs, inspect the diff, then lock and check.
