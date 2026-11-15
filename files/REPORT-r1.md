# REPORT — bz-connect-agent-run-1

Signed /root builder for bz, 2026-11-15T13:33:26Z. cc pr/gr/strategy/fv.

## Result and exact custody

Authorized SAME-writer continuation signed bz2026-11-15T12:54:42Z supersedes the exhausted original push budget with ONE normal successor push per changed repository. Retained original551a0dea repair and evidence; no published history rewritten.

Platform final candidate **29b6c73dbe57dccab8d07c3fe043c3307d750e8c**, branch `cloud/bz-connect-agent-run-1`, normally pushed once in this continuation. Natural [Verify43716717717](https://github.com/runeditrun/platform/actions/runs/43716717717) **SUCCESS**; sole supported observer ended13:19:11Z, GH_CALLS=7. Original16821962 natural Verify43713031385 FAILURE remains recorded; its three observed failures were repaired in551a0dea without weakening assertions.

Base final candidate **3de4500376e9a7183e4c5443cd11805536edb202**, same branch, normally merges current main34847bae. Targeted tests/typecheck PASS; own COMPLETE full-history publication scan PASS, zero new/166 pre-existing. Normally pushed once in this continuation; natural [Verify43717431106](https://github.com/runeditrun/base/actions/runs/43717431106) **SUCCESS**; sole supported observer ended13:33:10Z, GH_CALLS=6. GitHub propagation delayed initial discovery; same existing draftPR863 updated normally, no dispatch/rerun/new PR. Original Base1d231218 natural [Verify43713613390](https://github.com/runeditrun/base/actions/runs/43713613390) SUCCESS was consumed by the original supported observer at12:45:56Z; no duplicate observer.

Both final heads are source READY with own green natural exact-SHA CI. No independent review, landing, stage or release qualification is claimed. Front successor07b20620 requires its separate frozen Opus re-gate, and ONE independent coupled Opus review must follow the final READY pair. PR owns landing/one composed stage-fast runner=false; GR owns rer release.

## Source lineage

Platform started at frozen `cloud/bz-front-handover-1`, **2ade5642b2dd292d8957d36f5029fc60d922ed2e**, never modified. Fresh main **7e9e3e25ad3f890176b9abf120ac872b59f2f59e** was already its ancestor; ordinary merges at start and before candidate push were up to date. Parked `cloud/owner-agent-door-1` resolves authoritatively to **f912d556bb31a7044b5123b9ccbcd697a16b3090**, parent **ca6be45e2327626aa4d092bccf1bd8c5d85c5b81**, common ancestor with main **6d33eb52afe6f3c51cf2caa7424269046d87cb1b**. Replayed its net agent-door change, not the obsolete per-app key intermediate. Restored pairing actions, audit, exact agent route admission and dotted installation/change/update/domain/profile/plan tools on existing routes; unbuilt import/owner-only capabilities retain explicit refusals. No software-specific installer was introduced.

Base began at fresh main **c3a38757f6ab6246f61aeca5eb9f4f83efd5f88f**; the original candidate’s main integration was up to date before the continuation merge recorded below. Parked `cloud/owner-agent-door-rer-1` resolves to **42bc289fcce17a1ccdb2d7e390615533f09b200d**, parent **4ad28df1503c40bedfd95a8f499e1959e2404e89**, common ancestor **9de808d45b9463eb4e691e7a36d502add3d9f4ef**. Replayed authored CLI agent verbs/MCP bridge, then regenerated maintained reference copies with `node scripts/export-cli.mjs default-seed`; stale generated output was not replayed. No package version, release, signing or seed pin changed. Published history was not rewritten.

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

Published platform CI found three regressions:20px checkbox inputs failed preserved44px target checks; static Business auth imports escaped the copied controller closure; migration delta tables omitted152. The retained551a0dea repair keeps44px interactive targets/20px visible marks, binds agent auth only in assembled Business API (copied controller stays closed and refuses unsupported agent bearers), and includes152 in the maintained delta tables. No assertions were weakened, skipped or deleted. Existing route-audit assertion now uses a safe route template rather than retaining caller paths; Pair actions default empty until owner ticks them.

On exact retained551a0dea: failed controller-copy and migration-runbook tests plus agent-door/command tests PASS4/4; typecheck PASS. Built-browser tests PASS4/4: original owner journeys at1440/390, original Set up/Claim journey, new command-agent journey. Ten refreshed images cover Pair actions, Approved, Connected, Computers actions and Revoked at both widths. Builder personally inspected all changed screens/end states; revised Pair/Computers images were inspected after the target fix. Earlier and corrected raw results are retained. The retained repair is now included in merged successor29b6c73d; its own natural CI is required and tracked above.

Publication: Base scan through maintained `.tools/publish-check.sh`, full history, canonical `https://github.com/runeditrun/base#main`, project `runeditrun/base`. First default300s attempt INCOMPLETE at total deadline; supported900s retry PASS COMPLETE, historyScanned=true,1638commits/1617trees/10836blobs, zero new/166pre-existing. No scope/slot change or hand scan. Private platform candidate and unpublished successor added-line credential reviews found only synthetic test literals, zero production credentials.

## Evidence, limits and remaining authority

Actual logs/images/reports return only through maintained cloud_evidence publication/fetch, with file-hash verification. Isolated browser-job publication lacked a usable Git context; the same tool succeeded from the existing host Git context. No credentials were exported/copied and no report return was hand-fabricated.

Original one permitted normal candidate push per repo plus the explicitly authorized ONE successor per changed repo in this continuation, one natural CI per head, one supported observer per run; no rerun/dispatch. Heavy work serialized through heavy-slot, tests/build/browser remotely, required publication scans locally at low priority; load checked below36 at starts. No GPU, real profile/session copy, live provider mint/account/consent, deploy/import/mail/DNS, paid effect, app.happytohelp.com, release or main push. Fresh synthetic browser contexts closed through owning wrappers. Completed remote scratch clones were removed by literal recorded job paths. No server/browser/watcher is left intentionally running. One Luna/max read-only provider researcher completed and was collected; registered `account-api-tokens.write` remains unchanged as directed.

Source preservation: original retained551a0dea is an ancestor of the normally pushed platform successor29b6c73d. Original bundle/patch remain outside all public evidence packets. No source was discarded.

## Continuation integration and checks

Platform29b6c73d is a normal merge with parents551a0deafc36b814f8c50b44b9932a0176f1dcec and frozen front07b20620debb29420f92178d86b30f7c71d16de9. Never edited the front branch. Its only authored source difference from original2ade is provider fetch `redirect:manual`, preserving non-success refusal in Workers. Provider source merged normally; only source-lock hash conflicted and was regenerated using maintained lock/check commands. Fresh platform main7e9e3e25ad3f890176b9abf120ac872b59f2f59e remains an ancestor, holds through149 and no152 collision. Applied150/151 byte identity with2ade verified. FV scopes were not in that fetched main; no claim they landed, no scope/config edit.

Base3de45003 is a normal merge with parents1d23121833d9c5d5aa3a880dc55878d8660ecbc5 and main34847bae3f640486f16d42affb2274f32075248a. Keeps GR dry-run output-only changes exactly. Only generated CLI inventory conflicted; regenerated maintained copies through exporter, no package/version/release/pin changes.

On exact platform29b6c73d: real command-grant/consent routes, copied-controller isolation and migration runbooks PASS4/4; typecheck PASS. No assertion weakened/skipped/deleted. Retained consumed551a0dea built-browser4/4 at1440/390; integration changes no screen. Pair/Computers images personally re-inspected at both widths. On exact Base3de45003: business-run and ordinary deploy dry-run tests PASS7/7, reference typecheck PASS. Real scoped child and deploy dry-run paths retained, no provider mutation. Remote heavy jobs serialized with low priority/few workers; current local scan uses maintained slot and load admission.

Private final diff credential review:2747 added lines, six pattern candidates reviewed; five test fixture/status literals and one runtime safe delivery-status constant, zero production credentials. No values printed. New own Base scan PASS COMPLETE on exact3de45003 against canonical main34847bae:1640commits/1619trees/10839blobs, historyScanned=true, zero new/166pre-existing;354.999seconds. Actual complete report retained, no hand scan. Exact-SHA CI results appear in final disposition above. No inherited review qualification claimed.

DEFAULT SETUP-001: use declared canonical runeditrun/base#main (also used by maintained Base publication briefs); just-every/run-base returned404. No replacement source or hand scan invented.
DEFAULT SETUP-001: generic arbitrary-command tools only; no Lamp installer, automatic choice-to-install/import/update or hidden adapter.
GAP SETUP-001: live provider capability/consent/issuance/revocation awaits the later authorized stage journey and fails closed meanwhile. Strategy DIRECT45 uses the existing RER-owned stage account, explicit grant -> short child -> Opus5.5 harness agent rer business run --grant G -- rer deploy test Worker -> revoke/audit; no new account/company touch/provider action in this source round.
CLAIM SETUP-001 PARTIAL points=1,4 tests=tests/core/business-handover.test.ts#Owner decisions export and round-trip arbitrary software, preservation and pending references without starting setup; tests/core/business-command-grant.test.ts#owner Connect, account selection, ticked pairing and grant authorize only the paired command exchange, with private bounded issuance and honest cleanup


READY repo=runeditrun/platform branch=cloud/bz-connect-agent-run-1 head=29b6c73dbe57dccab8d07c3fe043c3307d750e8c
READY repo=runeditrun/base branch=cloud/bz-connect-agent-run-1 head=3de4500376e9a7183e4c5443cd11805536edb202
