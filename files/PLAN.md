# gr-base-preview-plan-channel-1 plan

Repository: runeditrun/base
Product branch: cloud/gr-base-preview-plan-channel-1
Initial main: 055cf2c085cf720371a050be5999d85d95a3b39f

1. Reproduce preview startup through the exported `previewTarget`, keeping the real planner, option conversion, Miniflare listener and shutdown. Substitute only Wrangler's resolver so its stdout deterministically emits the `.dev.vars` banner and an ExperimentalWarning. Establish the quiet control and non-zero/empty failure controls.
2. Write `serializePlan(plan)` to a dedicated fd-3 stream and finish that stream before the planner exits. Redirect planner stdout to runtime stderr and read only fd 3. Keep stopping/planner termination unchanged; normalize non-zero and unreadable plan failures to the required fixed message.
3. Regenerate vendored onboarding source and its CLI inventory with `node scripts/export-cli.mjs default-seed`. Add the repository's Unreleased changelog line. Keep unrelated sources, contracts and generated contract views unchanged.
4. Run the regression before/after, existing onboarding and preview tests, typecheck, copy-inventory verification and publication scan. Use Base's exact Node 22.20.0 for final local validation; use installed system Chromium with `--no-sandbox` for existing browser tests.
5. Fetch main before the single product commit. Reconcile any unpublished movement before pushing; never rewrite published history. Audit every candidate identity and trailer, push only the named cloud branch through the fleet guard, and obtain one exact-SHA Verify run using REST. Leave landing to the fleet lane.
6. Retain actual non-secret reports and receipts in this packet and publish them separately to the evidence ref. Report exact product and evidence custody independently, with the lane POST line and terminal readiness line.

No clause status promotions or count changes are requested. No release, tag, registry publication, Wrangler pin change or application UI change is in scope.
