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
