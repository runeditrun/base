# Edition first-release acceptance guidance

Keep one generated `ACCEPTANCE.md` in the edition source, alongside
`CONTRACT.md` and `HANDOVER.md`. `CONTRACT.md` is the only acceptance text and
status source. `ACCEPTANCE.md` reads that contract by Core, Agent surface and
Later, with full-target progress and the Field proof register. `docs/CLAIMS.md`
and the three Status summary rows are generated from the same source. Never
edit these outputs by hand. After a contract change, run
`node src/base/contract-docs.mjs write`, then
`node src/base/contract-docs.mjs check` and `rer check`; use the generator's
actual path when the edition's parser lives elsewhere. CI runs `check`.

Record the edition's owner purpose and primary journey in `CONTRACT.md`'s
Product target. Its clauses hold observable acceptance outcomes, including
failure behavior. Keep the first-release decision and dated candidate receipts
in `HANDOVER.md`, linking clause IDs rather than duplicating acceptance lists or
maintaining another status registry. The edition owns this decision; a family
or Base verification command must not infer it from a successful build or
publication.

Record unmet first-release obligations separately from preserved wider
requirements and external unknowns. Keep owner-required minima, privacy,
authority, truthful outcomes and applicable operating guarantees in force. A
narrower release profile does not waive the contract or its explicit
full-release conditions; unresolved scope conflicts remain visible until
deliberately settled. Never delete original promises or mark uncovered clauses
satisfied to make a gate green. Later clauses remain visible and keep their IDs
and status. Field proof rows never block clause done; preserve any separately
recorded owner requirement for a release decision.

Include exact candidate and dated evidence references. Distinguish executed gates,
failed, skipped and unexecuted coverage, publication, deployment, provider acceptance,
confirmed business effects and mailbox delivery. Historical pilot evidence is not
a fresh candidate verification. Preserve fixture, temporary-session and test-mode
limitations. A successful `verify` reports the checks it ran; completion additionally
requires evidence for the minimum outcome and applicable guarantees, resolution of
scope conflicts, and honest disposition of remaining requirements.

Suggested compact handover structure: purpose and minimum outcome; unmet release
obligations; preserved wider requirements; candidate evidence and decision rule.
Report Core done and full-target done together, using the generated totals.
