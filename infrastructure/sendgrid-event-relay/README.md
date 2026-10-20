# Optional owner SendGrid event relay

Use this infrastructure only when one owner's SendGrid webhook quota prevents
separate product callbacks. It is not required by any edition or a cross-family
runtime dependency. Deploy this binding-free Worker into that owner's account;
root `POST /events` receives SendGrid's signed raw event array.

Set `SENDGRID_WEBHOOK_PUBLIC_KEY` to the SendGrid webhook's base64 P-256 key.
Store `RER_MAIL_RELAY_DESTINATIONS` as a secret JSON object mapping allowlisted
`rer_product` values to `{ "url": "https://app.example/events", "secret": "..." }`.
Use a distinct random secret of at least 32 characters for each destination.
Configure an explicit custom hostname externally; no owner domain is in source.
From Base: `pnpm exec wrangler deploy --config infrastructure/sendgrid-event-relay/wrangler.jsonc`
with owner configuration/secrets supplied via Wrangler's normal deployment flow.

The relay verifies SendGrid ECDSA over the original raw bytes before parsing.
It partitions only known `rer_product` markers into separate event arrays and
forwards to the fixed configured URL, never a URL from an event. Unknown markers
are discarded. It does not log or persist bodies, recipient data or keys.
Delivery failures log only the configured product marker and HTTP status, or a
fixed transport-failure reason. Provider and receiver response bodies stay private.
A destination sees only its marked events, not other products' events in the same
provider batch. The original signature is invalid after partitioning; receiver
trust instead comes from the per-destination secret.

Receiver contract (copy `src/crypto.ts` from the pinned Base composition):

- Header `x-rer-mail-timestamp`: integer Unix seconds.
- Header `x-rer-mail-signature`: `v1=` followed by lowercase HMAC-SHA256 hex.
- Signed bytes: UTF-8 timestamp, one `.` byte, exact forwarded raw JSON body.
- `verifyRelayRequest({secret, timestamp, signature, rawBody})` rejects timestamps
  outside five minutes. Read the raw body once, verify, then parse.

Every destination must also enforce its product's known local delivery IDs and
persistently deduplicate `sg_event_id` before returning 2xx. Keep native SendGrid
signature verification for standalone deployments. Send `custom_args.rer_product`
from the selected edition, not from end-user message data.

Forwarding is synchronous and bounded to eight destinations and eight seconds per
request, with redirects rejected. Any destination non-2xx or transport failure
returns 503 so SendGrid retries; already successful destinations receive replays.
No retry loop, queue or database is added. Provider retry exhaustion remains an
operational failure to investigate. `GET /health` proves configuration shape only;
it does not probe providers, destination permissions or delivery.

Tests: `node --test infrastructure/sendgrid-event-relay/*.test.ts` with Node 26.
Dry build: `pnpm exec wrangler deploy --dry-run --config infrastructure/sendgrid-event-relay/wrangler.jsonc`.

Each destination receives at most 100 events per signed request. Chunks for one
product are sent sequentially with an eight-second timeout per request; products
run independently (at most eight configured destinations). A failed chunk stops
that product and returns 503 for the provider batch. SendGrid retries the whole
batch, so receivers must durably deduplicate every event already acknowledged.

## Isolated seed tests

Send `custom_args: { "rer_seed": "spool", "rer_test_installation": "test-id" }`
on the test mail. SendGrid emits these fields at the top level of each event.
An account operator registers that exact pair with a short expiry (milliseconds
since epoch, at most seven days ahead) in the optional secret
`RER_MAIL_RELAY_SEEDS`:

```json
{"version":1,"targets":[{"seed":"spool","installationId":"test-id","url":"https://seed-test.runeditrun.com/events","expiresAt":1793000000000}]}
```

Use a fresh expiry, not the illustrative timestamp. At most eight registrations
fit in the 16 KiB registry. Remove the entry to deregister. No HTTP registration
door exists: only the authenticated account operator may update the secret.
Before installing a registry, run `node infrastructure/sendgrid-event-relay/register.ts registry.json`
with `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` supplied by the approved
custody door. Capture stdout privately, check exit success, then pipe that file
into `wrangler secret put RER_MAIL_RELAY_SEEDS --config infrastructure/sendgrid-event-relay/wrangler.jsonc`.
Do not pipe a failed preflight directly into a secret update.

Registration deliberately supports only single-label `*.runeditrun.com` custom
domains authoritatively mapped to another Worker in the RunEditRun account.
The operator must retain that Worker route while registered and remove the
registration before changing or deleting the route. Arbitrary external origins
are refused: a DNS lookup followed by ordinary Worker fetch cannot pin the
second resolution. Worker routes keep the approved target at Cloudflare's
public edge rather than an arbitrary origin. Both registration and delivery
also require successful A/AAAA lookups with at least one address and no private,
loopback, link-local or special-purpose addresses. DNS failure closes the seed
route and reports only a configuration-failure count. IP URLs, credentials,
non-HTTPS schemes, nondefault ports and redirects are refused. This bounded
contract can expand only when a similarly safe destination door exists.

Raw seed forwarding occurs **only if every event in the entire signed array
has the same registered seed and test installation**. Empty, unknown, expired,
or mixed-scope batches have no raw delivery; legacy product delivery continues.
The seed receives the original body bytes and the original
`X-Twilio-Email-Event-Webhook-Signature` and
`X-Twilio-Email-Event-Webhook-Timestamp` values. Verify them with the webhook's
own public key, before parsing; durably deduplicate provider event IDs.
No signature is manufactured for a filtered subset. Mixed batches are counted
and omitted even when one of their events is the test receipt: this feature
cannot promise every test receipt in shared SendGrid batching conditions.

Seed delivery runs independently of the legacy product outcomes. It has a
1.5-second deadline for the two parallel DNS lookups, a three-second target timeout,
and at most one retry after 250 ms for transport errors, HTTP 429 or 5xx.
Redirects and other 4xx responses get no retry. Seed failure never changes a
successful legacy result into 503. Counts contain only unknown/expired events,
mixed batches, configuration failures, delivery failures and delivery successes;
no target, recipient, event body, signature or key is logged or stored.

Legacy `rer_product` selection, <=100-event chunks, sequential per-product order,
HMAC bytes, eight-target bound and 503 whole-batch replay remain unchanged.
Both forwarding routes send an explicit `User-Agent: RunEditRun-Mail-Relay/1`.
Provider verification consumes original bytes (including any UTF-8 BOM) rather
than a decoded/re-encoded representation. Input remains bounded to 1 MiB and
10,000 event objects. The seed registry cannot invalidate legacy configuration.

Typecheck: `tsc --project infrastructure/sendgrid-event-relay/tsconfig.json`.
Run the receiver tests above and the dry build, not the full Base suite locally.
Product and provider logs likewise contain only verified-event and batch outcome
counts. Worker custom-domain delivery uses `global_fetch_strictly_public` so
same-zone requests enter the public Worker route.
DNS uses the runtime's built-in `node:dns` resolver (`resolve4`/`resolve6`),
with `nodejs_compat` enabled. Direct HTTPS requests to the resolver from the
staging Worker failed at transport; the built-in resolver was proved separately
before replacing that path. An absent address family is allowed; any other DNS
error, timeout, or nonpublic answer rejects seed delivery.
