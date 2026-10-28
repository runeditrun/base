# Contract document commands

`CONTRACT.md` is the only acceptance text and status source. Follow the format
under "Contract status" in `SEED-COMMAND-CONTRACT.md`. Keep `contract-docs.mjs`
and its relative imports beside the existing `seed-contract.mjs`; use that
actual directory in every command below. Run from the runnable seed root.

## Generate and check

```sh
node src/base/contract-docs.mjs write
node src/base/contract-docs.mjs check
node src/base/contract-docs.mjs check-prose
rer check
```

`write` regenerates `ACCEPTANCE.md`, `docs/CLAIMS.md` and the three Status
summary rows. Never edit these outputs by hand. `check` is read-only and fails
on stale outputs; run it in CI. Commit generated outputs with each contract
change. `rer check` validates parser structure and existing evidence paths;
it does not prove acceptance. Report Core done and full-target done together.

Follow `platform/CONTRACT-STANDARD.md` for the governing contract standard.
`check` also runs `check-prose`. The latter reads CONTRACT.md and, when present,
docs/contract/COVERAGE.json and its recorded old Git commit. Keep that commit
available locally. Each finding names its clause id, family and source location:

- ERROR a: acceptance prose mapped to `generated`, including an `also`
  destination. Only recognized status/count statements are exempt. Coverage
  initialization places unique clause acceptance at its clause, not generated.
- ERROR c: a Markdown tool-table row has no fleet class, including a missing
  class column or a placeholder. A populated declaration's semantic completeness
  still needs judgment; this check does not infer classes from action names.
- WARN b/d: literal phrases below match clause bodies or Status Gaps. Matching
  ignores case, Markdown formatting and whitespace. Output includes the actual
  matched phrase and its judgment source. Warnings alone exit zero. They ask for
  review; they do not authorize removing seed-specific obligations.

The 28 October 2026 judgments read for these rules are the following task reports
(`VERDICT.md` in each named task's directory):

- Strap: `ct-cleanup-judge-strap-819f84b-20261028-1015-cx2`.
- Orbit: `ct-cleanup-judge-orbit-97681f8-20261028-0950-cx2` (blocked before
  substantive judgment) and `ct-cleanup-judge-orbit-d4a8bf1-20261028-1130-cx2`.
- Mango: `ct-cleanup-judge-mango-9d0c381-20261028-1155-cx2`.
- Nook: `ct-cleanup-judge-nook-bf244ee-20261028-1030-cx2`.

Every warning pattern is verbatim from those reports; keep new patterns in
`contract-prose-patterns.mjs` with their source. Strap's phrases describe the
candidate rather than quoting a complete candidate sentence.

| Family | Literal pattern | Report source |
| --- | --- | --- |
| b | Assignment never grants access | Orbit d4a8bf1 F5, line 70 |
| b | Permission changes apply on the next request | Orbit d4a8bf1 F5, line 70 |
| b | untrusted source text | Strap F5, line 65 |
| b | authorized job handles | Strap F5, line 65 |
| d | This target-contract round leaves the approved homepage and app interface untouched | Orbit d4a8bf1 F8, line 76 |
| d | This deliberately replaces the former dedicated hosted-record walkthrough | Orbit d4a8bf1 F8, line 76 |
| d | Full verification includes the delegation D1, archive and native-browser regressions as well as all retained contract gates. | Orbit d4a8bf1 F8, line 76 |
| d | Run pnpm test:push | Nook finding 7, line 79 |
| d | ct pattern 1 | Mango finding 6, line 84 |

## Rewrite records

```text
node src/base/contract-docs.mjs convert --old <ref> [--old-acceptance <ref>]
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
