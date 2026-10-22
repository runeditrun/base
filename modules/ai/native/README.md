# Native Workers AI consumer candidate

This opt-in extension uses the existing `modules/ai` and delivery declarations.
It is disabled without an explicit installation authority, a nonzero approved
budget, fresh versioned prices and an installation-held adapter proof. No native
provider or hosting mode is qualified by this candidate. No credentials are
fabricated, and neither the existing direct client nor Models is a fallback.

The reference app adopts `/api/ai` with its real operator-auth session store.
Only a current active owner may use it or read status/images. The reference's
second call checks a summary against the original text; Lamp must pass its own
server-owned `prepareSecond(first, original)` to `createNativeAiConsumer` to
retain its L17 extraction prompts and validation. This is a reusable consumer,
not acceptance of Lamp's product output. It never fetches websites. Lamp must
keep its SSRF, redirect and size checks in its existing site-fetch door and pass
site text as untrusted data. Browser fields cannot select model, tenant, prices,
account, epoch, bindings, tools, streaming, batches or reference images.

## Lamp declaration

Put `ai` inside delivery `artifact.specInputs` and the owner deploy declaration. This is a capability request,
not spending approval. Emitted Wrangler must bind the matching AI, private R2,
and SQLite authority class. Unknown fields, aliases and binding conflicts fail.
The exact ids below were rechecked in primary Cloudflare docs on 23 October
2026; they name contracts under investigation, not supported-provider claims.

```json
{
  "schema": 1,
  "provider": "cloudflare",
  "transport": "native",
  "binding": "AI",
  "budgetBinding": "AI_BUDGET",
  "imageBinding": "AI_IMAGES",
  "textModels": ["@cf/qwen/qwen3.8-27b"],
  "imageModels": ["@cf/black-forest-labs/flux-2-dev"],
  "purposes": [
    {"id":"site-read","kind":"text","model":"@cf/qwen/qwen3.8-27b"},
    {"id":"house-style","kind":"image","model":"@cf/black-forest-labs/flux-2-dev"}
  ],
  "limits": {"calls":0,"units":0,"microUsd":0},
  "operations": {"textCalls":2,"maxInputBytes":10000,"maxOutputTokens":1024,"imageUnits":100,"timeoutMs":20000}
}
```

Installation authority supplies `RER_AI_REQUEST` and `RER_AI_AUTHORITY` privately
from trusted installation configuration, never setup/browser inputs. Authority
has schema 1, `enabled` (default off), the installation account `accountId`,
installation/environment/tenant ids,
`revision`, a custody generation, `permitted` (the same strict request schema),
`prices` and `proofs`. `approve` computes the intersection and smaller limits;
seed requests cannot expand authority. One authority instance is selected using
only installation/environment, with tenant-scoped durable operations.

Prices are model-indexed records with a version, expiry timestamp and integer
micro-USD rates per million input/output tokens and per image unit.
Proofs are model-indexed records with a held-proof reference, kind, hard input,
output and image-unit ceilings and image MIME. These are installation-trusted
attestations, not a client boolean. The held-key gate must establish them; do
not invent references or infer proof from model existence. Qwen reserves the
entire documented 262144-token context per call and a proved output ceiling,
including the system/template overhead. The actual output request uses
`max_completion_tokens`, one choice, text, no thinking, no storage and no stream.
No free-tier or cached-token discount reduces a reservation.

For Free deployment, the owner declaration also names the SQLite DO and R2
resources plus class `AiAuthority` and a required secret binding
`RER_AI_PRIVACY_TOKEN` sourced from the same owner-only environment name. Supply `RER_AI_AUTHORITY` through the
owner-only deployment environment or private `--env-file`. Its installation is
the derived Worker name (for example `lamp-production`), environment is
`production`, and tenant is the server-owned installation tenant. Do not put
`RER_AI_*` variables in seed-controlled `vars`; the consumer derives them.
The first declaration above requests zero spending until both the seed request
and separate permitted policy explicitly authorize larger finite limits.

For an approved, proven installation, bind `AiAuthority` as a SQLite DO and the
named R2 bucket. The native transport calls the real binding's `run` method.
An owner POST to `/api/ai` with
`{"action":"text","purpose":"site-read","command":"read-1","input":"bounded site text"}`
reserves both calls before dispatching either. The server creates call two from
call one's result. The final response contains `result`; intermediate text is
not persisted. A replay is refused, because text results are deliberately not
stored. A new command is new authorization subject to the same aggregate budget.

An image POST uses `action:"generate"`, `purpose:"house-style"`, a command and
bounded prompt. Purpose identity ignores command keys. Changed prompt/model
input conflicts; repeats reuse validated stored bytes. GET
`/api/ai?purpose=house-style` reauthenticates and derives its key server-side.
No arbitrary-key reads exist. The bucket identity and read-only privacy token
are installation configuration (`RER_AI_ACCOUNT_ID`, `RER_AI_BUCKET_NAME`,
`RER_AI_PRIVACY_TOKEN`). Both r2.dev and custom domains are checked before
inference, write and every read. Unknown API results or any configured public
access refuse custody. Account owners must keep the bucket private: a readback
cannot prevent a simultaneous or later account-owner change.

## Liability and recovery

Hard application call/unit counters and estimated dollars are separate. The
SQLite transaction enforces settled plus outstanding plus new <= limit. Each
winning child durably flushes `dispatching` before sending. Provider work is
outside transactions. Fenced settlements are idempotent; missing usage, abort,
timeout, worker death or uncertain errors retain the full maximum. Later known
usage can settle the same child without another dispatch. Completed call-one
charges survive a failed call two. Excess usage records the debt and freezes
new work. Known-unsent children may be released; ambiguous children never are.
There is no expiry that permits regeneration, no automatic retry and no fallback.

Image purpose tombstones survive stored-object loss. Validated PNG output is
recorded before conditional R2 creation. Recovery adopts only matching scope,
operation, digest, MIME and structurally valid bytes. A missing object after a
possible dispatch refuses regeneration. FLUX documents no usage in its image
envelope: even a stored image retains maximum liability. The promise is stored
reuse and at most one application dispatch per stable purpose without explicit
reconciliation/new authorization. It is not exactly-once provider execution or
billing, nor guaranteed delivery.

The image adapter accepts only a conservative RGB/RGBA 8-bit, noninterlaced PNG
subset after proof: <=10 MiB decoded, <=4096 per side, <=16 megapixels; CRCs,
chunk order, decompression size, row filters, magic and MIME are checked.
JPEG/WebP remain refused until their adapters are proven. SVG/HTML, URLs,
metadata/unknown chunks, malformed Base64 and bomb outputs are refused.
Ledgers contain hashes, counters, finite purpose ids and states, never prompts,
text outputs, cookies, tokens or raw provider exceptions.

No epoch reset exists. Policy/custody/revision changes freeze the authority and
preserve all rows. Migration/restore must disable AI; declared native-AI archive
restore is refused. Reconciliation requires a new installation-authorized revision and an active
owner POST with `action:"reconcile"`; it checks the retained totals against
the new limits and preserves every liability and purpose tombstone. It cannot
refund uncertain work or erase debt. There is no wipe endpoint. Infrastructure
rollback detection remains required before production qualification. Never erase
or replace the DO or purpose tombstones to recover capacity. Raw bindings,
arbitrary Worker code and account owners can bypass the wrapper; infrastructure,
other apps and changing prices mean this is not an account-wide spending cap.

## Hosting and provider boundary

The Free owner-account deployment consumer accepts native AI only with a
separate `RER_AI_AUTHORITY` supplied by the deploying owner, bound to the derived
Worker installation, environment and exact payer account. It derives the payer account and bucket
name, requires the privacy-token secret, checks current prices/proof records,
renders the native binding and verifies exact provider readback. A missing
approval, conflicting built binding or cross-account plan fails closed. This
path is tested with the Cloudflare network edge doubled; live provider/account
qualification is still held. Assisted/Managed package
production explicitly refuses it; its service consumer lives outside Base
and mail support grants no AI authority. Native demos already refuse `ai`, and
the consumer rejects local/dev/demo modes before dispatch. Container hosting is
not a native Workers AI transport. `rer check` validates a matching first-party
`delivery.ai.*` declaration clause; that is not hosting or provider acceptance.

Network-edge doubles exercise real reference-app auth, SQLite DO and R2 in
`tests/native.test.mjs`. They do not establish Cloudflare billing, parameter
interpretation, private account custody or production hosting support. The
separate held-key gate must verify those without weakening the conservative
holds. Historical Lamp costs are not pricing guarantees.

Primary sources rechecked 23 October 2026:

- [Qwen model](https://developers.cloudflare.com/workers-ai/models/qwen3.8-27b/), [input schema](https://developers.cloudflare.com/workers-ai/models/qwen3.8-27b/sync-input.json), [output schema](https://developers.cloudflare.com/workers-ai/models/qwen3.8-27b/sync-output.json).
- [FLUX model](https://developers.cloudflare.com/workers-ai/models/flux-2-dev/), [input schema](https://developers.cloudflare.com/workers-ai/models/flux-2-dev/schema-input.json), [output schema](https://developers.cloudflare.com/workers-ai/models/flux-2-dev/schema-output.json). The current schema supplies no field-level step/tile ceiling. New inference is unqualified until proof supplies one.
- [Bindings](https://developers.cloudflare.com/workers-ai/configuration/bindings/), [pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/), [SQLite durability](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).
- [R2 conditional operations](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/), [public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/), [managed domain readback](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/domains/subresources/managed/methods/list/), [custom domain readback](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/domains/subresources/custom/methods/list/).
