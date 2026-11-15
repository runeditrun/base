# REPORT — bz-connect-agent-run-1

Signed /root builder for bz, 2026-11-15T12:49:25Z. cc pr/gr/strategy/fv.

## Result and exact custody

**BLOCKED platform publication:** the one permitted candidate push published `cloud/bz-connect-agent-run-1` at **16821962b86956089d9e8a855dab2320c433b6f8**. Natural [Verify43713031385](https://github.com/runeditrun/platform/actions/runs/43713031385) finished **FAILURE**; supported ci-wait ended12:35:37Z, GH_CALLS=7. Do not land or deploy that head.

Its concrete repair is committed, tested and **unpublished** on the same local branch at **551a0deafc36b814f8c50b44b9932a0176f1dcec**. The brief says “One normal candidate push per repo”; that platform push was used. No second push, force, rerun, dispatch or landing submission was made. The remaining decision belongs to bz: authorize a normal successor push, then its natural exact-SHA CI and the required independent Opus gate. No owner key/token is needed.

**Base code READY:** `runeditrun/base`, branch `cloud/bz-connect-agent-run-1`, head **1d23121833d9c5d5aa3a880dc55878d8660ecbc5**. One candidate push; draft [PR863](https://github.com/runeditrun/base/pull/863) exists solely for natural CI. [Verify43713613390](https://github.com/runeditrun/base/actions/runs/43713613390) finished **SUCCESS**; supported ci-wait ended12:45:56Z, GH_CALLS=5. COMPLETE full-history publication scan PASS, zero new findings,166 pre-existing. Base is not released and the coupled change is not qualified for landing/stage until platform succeeds and bz's gate passes.

## Source lineage

Platform started at frozen `cloud/bz-front-handover-1`, **2ade5642b2dd292d8957d36f5029fc60d922ed2e**, never modified. Fresh main **7e9e3e25ad3f890176b9abf120ac872b59f2f59e** was already its ancestor; ordinary merges at start and before candidate push were up to date. Parked `cloud/owner-agent-door-1` resolves authoritatively to **f912d556bb31a7044b5123b9ccbcd697a16b3090**, parent **ca6be45e2327626aa4d092bccf1bd8c5d85c5b81**, common ancestor with main **6d33eb52afe6f3c51cf2caa7424269046d87cb1b**. Replayed its net agent-door change, not the obsolete per-app key intermediate. Restored pairing actions, audit, exact agent route admission and dotted installation/change/update/domain/profile/plan tools on existing routes; unbuilt import/owner-only capabilities retain explicit refusals. No software-specific installer was introduced.

Base began at fresh main **c3a38757f6ab6246f61aeca5eb9f4f83efd5f88f**; ordinary final main integration remained up to date. Parked `cloud/owner-agent-door-rer-1` resolves to **42bc289fcce17a1ccdb2d7e390615533f09b200d**, parent **4ad28df1503c40bedfd95a8f499e1959e2404e89**, common ancestor **9de808d45b9463eb4e691e7a36d502add3d9f4ef**. Replayed authored CLI agent verbs/MCP bridge, then regenerated maintained reference copies with `node scripts/export-cli.mjs default-seed`; stale generated output was not replayed. No package version, release, signing or seed pin changed. Published history was not rewritten.

Read current GitHub main DIRECTION.md/AGENTS.md from runeditrun/runeditrun, both repository AGENTS, relevant README/CONTRACT/ACCEPTANCE/OPERATIONS, lanes/LANE-RULES.md and briefs/RULES.md. Retained newer main/controller/SEC-1 and contract text. No clause Status/Gap/Evidence cells were edited. The coupled slice edits no production/stage config, workflows, scopes/client lists, Cloudflare runtime bindings, copy manifest or doctor bypass; inherited frozen-front changes remain intact.

## Migration and paths

New `migrations/152_business_agent_access.sql`: parked action/pairing/audit tables, plus safe command-lease metadata and Business erasure references. At candidate creation fresh main listed through149; frozen front supplies150/151 and stage already holds them. No real152 collision was present. Applied150/151 are byte-identical to frozen2ade5642, and no applied SQL was rewritten. Recheck fresh main before a future successor push; a real152 collision goes to bz/pr, never a rewrite of applied SQL. D1 remote-split application check passed without live migration/provider access.

Platform paths: `src/business/agent-door/`, `src/business/grants/{deploy-authority,exchange,leases,provider}.ts`; executor approval/settings/token integration; platform auth/Business access; existing change/publish projections; Pair/Computers action controls; migration152; maintained migration-delta documentation. Source lock/check ran last after each intentional change, preserving retained comparison sources.

Base paths: `cli/business/{run-grant,run-child,run-mask}.mjs`, command dispatch, parked agent verbs/MCP bridge, CLI guidance and generated `default-seed/scripts/base-cli` copies/inventory. Full candidate and successor path lists accompany this report.

## Runtime contract

The owner explicitly ticks deploy at pairing or in Computers and separately approves a per-agent resource grant. MCP `cloudflare.token` exposes safe instructions/status, never a credential. Only the paired-device-authenticated rer exchange returns a child directly to rer. Issuance checks exact Business, agent, selected account, active grant, allowed deploy action, current owner memberships, same confirmed OAuth consent, required scopes, provider-selectable permissions and expiry. Missing or narrowed authority refuses or remains PENDING. No parent token reaches the agent, and no ambient/fleet credential is a fallback.

Cloudflare must accept exactly the selected account resource policy and least-authority permission groups. The returned policy/expiry are verified. The child expires at the earliest of15minutes, grant expiry and provider authorization expiry; refresh retains existing narrowing. A preselected lease ID prevents credential replay and supports cleanup after a lost response. Only safe token ID/account/expiry/cleanup state is stored; rejected provider responses retain their cleanup identity. Child values never enter durable state, handover export, owner UI, audit, logs or MCP transcript.

`rer business run --grant G -- <cmd>` injects `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` into only the spawned command environment, removes Cloudflare credential aliases from the caller environment, inserts no shell and preserves argv. Raw/common encoded credential values are masked across split stdout/stderr writes. Exit codes and Unix terminating signals are retained after cleanup; spawn failures use127/126. It never retries with parent/broader/ambient access.

Cleanup runs on success, failure, interruption and spawn failure. Revocation is confirmed only by a matching provider acknowledgement; otherwise stderr reports **unconfirmed**, safe lease ID, server expiry and `rer business cleanup LEASE` / `--status`. Removing the grant/action does not prevent cleanup with the original still-valid pairing. SIGKILL/crash, revoked pairing or network loss may prevent cleanup; expiry bounds orphaned authority. No instantaneous stop of in-flight provider work is claimed.

This is an environment boundary, not an OS sandbox. The process and descendants can use/disclose their credential and access other same-user files or OS credentials. Protection against malicious entrusted software or arbitrary secret transformations is not claimed.

## Checks and actual CI correction

Public platform routes passed: real device start/lookup/owner approval/collection; OAuth start/callback with provider/network edges fake; real account-selection and grant approval; authenticated child issuance. Cases cover cross-Business/agent/account, browser/MCP credential refusal, missing selection/action/scope, expiry/revocation, replaced/narrowed consent, missing expiry, provider overbreadth, rejected-child cleanup identity and unconfirmed/retried revocation. Owner/export/audit/lease/tool surfaces contain no parent or child value. Existing front handover/consent and parked app-change/publish tests passed.

Base real subprocess tests passed: scoped env; spaces/empty arguments/child help preserved; split output masking; success and failure codes; missing executable127; refused authority never spawns/retries; SIGINT/SIGTERM; expiry; cleanup status/retry. Existing parked agent verbs/stdio bridge passed. Ordinary real `rer deploy --dry-run` under the wrapper against maintained default-seed passed (`dryRun=true,deployed=false,providerChecked=false`), with no live mutation. Reference typecheck and new CLI syntax checks passed.

Published platform CI found three regressions:20px checkbox inputs failed preserved44px target checks; static Business auth imports escaped the copied controller closure; migration delta tables omitted152. The unpublished551a0dea repair keeps44px interactive targets/20px visible marks, binds agent auth only in assembled Business API (copied controller stays closed and refuses unsupported agent bearers), and includes152 in the maintained delta tables. No assertions were weakened, skipped or deleted. Existing route-audit assertion now uses a safe route template rather than retaining caller paths; Pair actions default empty until owner ticks them.

On exact unpublished551a0dea: failed controller-copy and migration-runbook tests plus agent-door/command tests PASS4/4; typecheck PASS. Built-browser tests PASS4/4: original owner journeys at1440/390, original Set up/Claim journey, new command-agent journey. Ten refreshed images cover Pair actions, Approved, Connected, Computers actions and Revoked at both widths. Builder personally inspected all changed screens/end states; revised Pair/Computers images were inspected after the target fix. Earlier and corrected raw results are retained. Full natural CI on551a0dea remains owed after authorized publication.

Publication: Base scan through maintained `.tools/publish-check.sh`, full history, canonical `https://github.com/runeditrun/base#main`, project `runeditrun/base`. First default300s attempt INCOMPLETE at total deadline; supported900s retry PASS COMPLETE, historyScanned=true,1638commits/1617trees/10836blobs, zero new/166pre-existing. No scope/slot change or hand scan. Private platform candidate and unpublished successor added-line credential reviews found only synthetic test literals, zero production credentials.

## Evidence, limits and remaining authority

Actual logs/images/reports return only through maintained cloud_evidence publication/fetch, with file-hash verification. Isolated browser-job publication lacked a usable Git context; the same tool succeeded from the existing host Git context. No credentials were exported/copied and no report return was hand-fabricated.

One permitted normal candidate push per repo, one natural CI per head, one supported ci-wait observer at a time; no rerun/dispatch. Heavy work serialized through heavy-slot, tests/build/browser remotely, required publication scans locally at low priority; load checked below36 at starts. No GPU, real profile/session copy, live provider mint/account/consent, deploy/import/mail/DNS, paid effect, app.happytohelp.com, release or main push. Fresh synthetic browser contexts closed through owning wrappers. Completed remote scratch clones were removed by literal recorded job paths. No server/browser/watcher is left intentionally running. One Luna/max read-only provider researcher completed and was collected; registered `account-api-tokens.write` remains unchanged as directed.

Unpublished source preserved in local platform checkout and verified `platform-unpublished-successor.bundle` (requires published16821962) plus matching `.patch`, outside public report packets. Preserve these until the authorized successor is safely pushed. Independent Opus gate, PR landing/one stage-fast deploy with runner=false, GR release and later owner Connect/pair/grant clicks remain their named owners' work.

DEFAULT SETUP-001: bz authorizes one normal platform successor push of the tested repair, with fresh-main collision/integration and source lock last, then natural exact-SHA CI and the required independent gate. Never deploy/land red16821962; this builder makes no second push.
DEFAULT SETUP-001: use declared canonical runeditrun/base#main (also used by maintained Base publication briefs); just-every/run-base returned404. No replacement source or hand scan invented.
DEFAULT SETUP-001: generic arbitrary-command tools only; no Lamp installer, automatic choice-to-install/import/update or hidden adapter.
GAP SETUP-001: platform published CI is red; tested551a0dea awaits authorized successor publication/full CI. Live provider capability/consent/issuance/revocation awaits the later stage owner journey and fails closed meanwhile.
CLAIM SETUP-001 PARTIAL points=1,4 tests=tests/core/business-handover.test.ts#Owner decisions export and round-trip arbitrary software, preservation and pending references without starting setup; tests/core/business-command-grant.test.ts#owner Connect, account selection, ticked pairing and grant authorize only the paired command exchange, with private bounded issuance and honest cleanup

READY repo=runeditrun/base branch=cloud/bz-connect-agent-run-1 head=1d23121833d9c5d5aa3a880dc55878d8660ecbc5
BLOCKED repo=runeditrun/platform branch=cloud/bz-connect-agent-run-1 head=16821962b86956089d9e8a855dab2320c433b6f8 successor=551a0deafc36b814f8c50b44b9932a0176f1dcec reason=one-push-limit-after-red-CI
