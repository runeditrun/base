# Shared docs-search admission — decision required

25 October 2026. Proposal for gr/main; not an implemented or provisioned service.
The docs-search correction remains held for release until this scope decision,
implementation and independent provider acceptance are complete.

The current runtime calls Workers AI directly; preparation calls its account
REST endpoint directly. Neither path shares accounting. The existing egress
service forwards outbound requests and has no authenticated per-account AI
budget. A ten-per-minute visitor limiter, evictable Cache API and isolate-local
single-flight cannot reserve preparation capacity. Cloudflare documents its
[Workers Rate Limiting API](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
as local to a location and approximate. The published text embedding ceiling of
3,000 requests/minute is a provider limit, not this application's budget or
reserve. See [Workers AI limits](https://developers.cloudflare.com/workers-ai/platform/limits/).

## Proposed smallest contract

Add one account-owned admission Worker and one SQLite Durable Object namespace,
with one stable object for each account's embedding budget. This is a new
resource/service and therefore exceeds the original no-new-search-service
constraint. Default decision requested: authorize this narrowly scoped shared
admission service, without a search index, database of documents, or retrieval
fallback. Existing deploy-kit resource ownership and version readback can manage
it; the site-specific contract must explicitly permit its service binding.

Proposed initial policy, to be confirmed by gr/main before implementation:

| Class | Calls in any rolling 60 seconds | Calls in a UTC day |
| --- | ---: | ---: |
| Anonymous search, all sites combined | 300 | 10,000 |
| Authenticated preparation, all sites combined | 60 | 2,000 |
| Total admitted work | 360 | 12,000 |

Preparation capacity is never loaned to anonymous search. These numbers are a
conservative policy proposal, not a measured limit, allowance expansion, or
claim about the current runtime. Count a provider RPC, including a batched
preparation RPC, before dispatch. Bound the model, query bytes, preparation
batch size and total input tokens as well. A call ceiling alone is not a dollar
ceiling; a monetary guarantee needs a conservative token/neuron reservation at
the current model price. Do not estimate spend after the work and call that a
hard cap.

The coordinator performs inference itself. Site Workers lose the direct AI
binding; preparation uses the coordinator instead of a direct AI token. Every
embedding client on the account must enroll, with bypass credentials revoked or
restricted; otherwise report only the managed callers' bound and leave the
account-wide requirement open. A reserve within this service cannot guarantee
provider availability if unrelated account clients can still consume its quota.

Admission authenticates a grant bound to account, exact origin, caller Worker,
phase and policy version. Runtime grants cannot select the preparation phase.
Base deployment owns the grant and binding; visitor headers/body fields cannot
choose identity, phase or account. Use a service-binding capability with a
server-validated grant for runtime, and a separate expiring authenticated grant
for CLI/CI preparation. The account owner controls issuance/revocation. A
visitor-supplied Origin or CF-Connecting-IP is not grant authentication. Keep
those visitor inputs limited to the existing abuse mitigation.

In a single durable transaction, verify grant and remaining class/day budgets,
record an opaque request id, and reserve one bounded dispatch before returning
admission. Perform network inference after the transaction. An uncertain,
failed or interrupted dispatch keeps its reservation; do not refund it or retry
it automatically. Replayed ids cannot dispatch again. Persisted reservations
survive object restart. Denial returns 429 with the next admissible time;
unavailable accounting returns 503 and makes no inference call. The
[SQLite transaction API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#transactions)
provides the atomic storage primitive; an in-memory counter does not.

Deployment must pin account, service, namespace, grant authority, policy version
and immutable coordinator version in the ownership/fingerprint/readback
contract. Refuse mismatched ownership or unavailable authority before replacing
a site. CLI validation, package/exported deploy-kit, preparation and generated
Worker must ship together. Do not hand-create unrecorded per-seed resources.

## Required proof after authorization

Use one actual native Durable Object namespace and multiple callers with
separate origins, identities and simulated ingress locations; fake only the
inference edge. Count all forwarded calls and assert the rolling and daily
partitions under concurrency. Exhaust runtime capacity, then prove preparation
still admits its reserved capacity; test denied/forged phase, replay, restart,
uncertain provider failure and missing authority. Verify no direct AI bypass in
runtime or preparation and prove generated bindings and immutable version
readback. A bounded independent held-key check can confirm forwarding; no
provider saturation test is necessary or authorized.
