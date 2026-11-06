# Held rer 0.2.100 release preparation

Task gr-rer-mailoff-02100-prepare-1; repository runeditrun/base; branch cloud/gr-rer-mailoff-02100-prepare-1.

Release preparation only. Landing remains HELD pending strategy clearance and final release qualifications. No tag, npm publication, live migration, cutover or deployment was performed. No fleet queue/canonical record was edited.

## Provenance and scope

- Accepted source: 1da58f1537aeef14b733223de19c1791a17d68f2 (advertised cd/rer-mail-off-deploy-1), parent 0da8ea78be784494f67c30673230241280ce22cb; original main lineage 601a56e0a5e8e21507003b902949e12723036148.
- Main was 601a56e0 at clone and advanced to the exact accepted source on refresh. The source is on main. No later main or light-Business source was merged; this candidate does not revive the superseded release preparation.
- Last release base rer-v0.2.99: ca42f4a94fbe71d98b0402607e5d557a51cfac90. npm latest was 0.2.99; npm 0.2.100 returned E404; rer-v0.2.100 was absent from remote refs.
- M: 896a437f0c5def74b1fcc2ce7cd0a50e073ef584, tree b13c933c39662b5babb3c4fdbb928a8c5a4311e4. Its direct parent is the accepted source. Only global/package.json and global/CHANGELOG.md change. The first real commit was published as a [skip ci] save after its complete publication scan and identity check.
- C: 1863aa8caafb4eef44c0d8fafd524c9b8cd1eb66, tree c7002c230298b1865920f694c9e87de74b2979d1. Direct parent M. C changes only default-seed/scripts/base-cli/inventory.json, generated at M.

The version changes 0.2.99 to 0.2.100. Other package manifest fields and historical changelog sections are unchanged. Release notes explain explicit MAIL_PROVIDER=none for adapters declaring mailOffSignIn, refusal of sending bindings, no mail credential binding and the named hosted sign-in. They also describe inherited accepted package transport, opt-in bounded waves, Zendesk, startup budget, legacy approved-read replay, Cloudflare list retry and value-free publication diagnostics. They make no live adoption/cutover claim.

## Counts and clauses

Tracked files: 4,761 before / 4,761 after. Candidate adds two commits and changes three files: two metadata files and one generated inventory. Product source, tests, dependencies, migrations and contract files edited: zero each. Clause status changes/promotions/demotions: none. Test registrations added/removed: 0/0; one relevant existing registration ran and passed (0 failed, 0 skipped). Four packed command probes passed. No clause claim is made by this metadata preparation.

## Generation and checks

The complete plan is PLAN.md. Both exporter invocations ran at M. Complete generated snapshots (1,573 files) are identical in bytes and modes, SHA-256 83e2f56c5eedd6aed4d847ccc4d4e72a8dc9f2598a1c2b270d9ee3837f3e8f09. All 1,343 CLI/onboarding inventory entries were checked against original source bytes, SHA-256 values and modes. The inventory names 0.2.100-dev.g896a437f. C contains exactly the one generated inventory-stamp difference.

The existing portable CLI export integrity/public execution assertion passes. Two package builds at C give identical bytes: 2,731,577 bytes, 1,396 files, SHA-256 344ef88766b81b6aed10bfa555d380ac0e40b5fab7072e96eb934c9066fa6d43. Export-map targets exist. The untagged package is 0.2.100-dev.g1863aa8c, as documented. Packed --version, --help, deploy --help and describe --cwd default-seed --json all exit zero. Describe correctly reports the reference's M-stamped vendored CLI. An initial assumption in the ad hoc evidence harness about describe's JSON shape was corrected; it was not a product failure and did not change any maintained test.

No source requires a new typecheck. No full local verify/suite, browser acceptance, provider operation or production action was run. The release's later ordinary plus explicit journeys=true Verify, stranger/installer proof and other release prerequisites remain required on the final candidate. No qualification is inferred from this preparation.

M publication scan: ordinary PASS, complete=true, zero findings and zero warnings, default 300-second deadline; actual elapsed 249.881788 seconds. Maintained wrapper and pinned Gitleaks 8.30.1, explicit project/repository runeditrun/base and public base https://github.com/runeditrun/base#main, full history. No scan policy changes, exceptions or timeout growth. Actual JSON retained in scan-M.json. Exact-C scan and CI/custody details are appended at completion.

Fleet identity and full messages/trailers are checked across all candidate commits including side parents before each push. No OpenAI/Codex coauthor lines are present. The hooks preserve repository hooks; no hook bypass, published-history rewrite or force push is used.

## Exact-C publication and custody

C publication scan: ordinary PASS, complete=true, zero findings and zero warnings, default 300-second deadline; actual elapsed 263.669952 seconds. Source and tree match C exactly. Same maintained scanner implementation digest as M: c5f2d788f2f08764cd018e049b507c26f5ac01f651e2e8696398d89a5a886ffb. Public base was accepted source 1da58f1537aeef14b733223de19c1791a17d68f2. Full raw report: scan-C.json.

Both pushes succeeded on their first attempt, through cloud-push.py, after all-candidate identity/trailer and message inspection. Only the named product branch was pushed. Draft PR: https://github.com/runeditrun/base/pull/831, exact head C. The final pre-push advertisement still named accepted source for both cd/rer-mail-off-deploy-1 and main, with no rer-v0.2.100 tag. No drift beyond source was included.

CI receipts are collected by one REST watcher. Verify has a pre-main pull-request/manual entry point, and Release rer supports pre-main dry runs. C follows a [skip ci] save and only changes the generated inventory, outside Release rer's global/** push filter; a missing release run is dispatched once only after exact-head discovery. Explicit journeys=true is intentionally left for the final release operator, as required by this preparation brief. No duplicate run or rerun is requested.

Release rer dry-run 42235085021 completed/success on exact C: https://github.com/runeditrun/base/actions/runs/42235085021. It was the one existing-workflow dispatch after discovery found no natural exact-C release run. The publish job remains excluded by dry-run mode. Ordinary Verify 42235012226 was still in progress at the subsequent scheduled read; final observations are in ci-receipt.json.

## Terminal result

Product custody: PUSHED branch=cloud/gr-rer-mailoff-02100-prepare-1 head=1863aa8caafb4eef44c0d8fafd524c9b8cd1eb66. Draft PR https://github.com/runeditrun/base/pull/831.

Verify: run 42235012226, in_progress/None, exact head 1863aa8caafb4eef44c0d8fafd524c9b8cd1eb66; https://github.com/runeditrun/base/actions/runs/42235012226.

Release rer: run 42235085021, completed/success, exact head 1863aa8caafb4eef44c0d8fafd524c9b8cd1eb66; https://github.com/runeditrun/base/actions/runs/42235085021.

No READY claim is made while Verify is pending. Pending CI is returned as pending, not as green or a product blocker. The REST watcher made scheduled reads no more often than once per 300 seconds per run, including discovery. No duplicate run or rerun was requested. Actual calls/timestamps are in github-calls.json. The landing hold remains in force regardless of preparation custody.

Main at terminal advertisement: 1da58f1537aeef14b733223de19c1791a17d68f2. Later main was not merged into this exact-source candidate. No release tag or npm publication was made; the final npm recheck still returned E404 for 0.2.100.

Actual selected packet files are published through evidence/gr-rer-mailoff-02100-prepare-1 only. The product checkout remains clean, with all work pushed, through that transfer. Cleanup follows successful evidence transfer; no dependencies, browser or development server were installed/started for this metadata preparation. The packet remains outside the clone.
