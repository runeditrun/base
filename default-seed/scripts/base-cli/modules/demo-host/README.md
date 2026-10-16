# Hosted demo

The front Worker `rer deploy --demo` deploys at `demo.<domain>` for a seed
that adopted demo mode (`withDemo`, export/DEMO.md). `plan.mjs` turns `deploy-demo.json`
(optionally `instanceType`, one of Cloudflare's predefined Container instance
types, `basic` unless set, and `ownerEmail`, the address the demo's owner signs
in as, `owner@demo.invalid` unless set) into the Worker's Wrangler configuration; the CLI (`cli/demo-host.mjs`) writes
it with these files and the seed's container image folder (workerd engine) to
`.rer/demo-host/` and runs `wrangler deploy` there. Declared
`container.hostVariables` resolve from demo settings to the primary hostname or
its descendants (for example `page.demo.<domain>`); each gets a custom-domain
route to the same front. The visitor cookie covers these hosts, while the
primary host's `__Host` owner session stays host-only. The front supplies a
validated public origin to the container ingress, so secondary page routing
sees the requested host. Anonymous secondary requests return to the primary
start page.

- `worker.mjs`: `GET /` is the start page; `POST /__demo/start` checks the
  exact Origin, the `STARTS` rate limit (3 per IP per 60 s), Turnstile's
  siteverify and capacity, then starts the visitor's demo. It answers with
  202 progress and a `rer_demo` cookie; `GET /__demo/status` polls that same
  copy until it can relay the owner claim's 303 (JSON `{ location }` for the
  page script) and session cookie. Every external admission step is bounded:
  the start answers within 12 seconds. A new copy that takes over two seconds
  to answer is still a pending start, not a failure. Each status request is
  held (at most 1.5 seconds) until the start changes, so the page learns of the
  sign-in at once; a slow status read answers pending. Each admission logs
  `demo_admitted` with the request's user agent and network owner, so a held
  place can be joined to whoever started it. On Turnstile's testing secret (a
  test host) a start must also carry the deploy's measurement token
  (`measurement.mjs`: cookie `rer_demo_measure` or header
  `x-rer-demo-measurement`), since automated browsers pass those keys; a
  test host without a token admits nobody. A request
  with that cookie goes to the visitor's Durable Object; nothing else reaches
  a container.
- `container.mjs`: `DemoContainer`, one per visitor (`newUniqueId`, checked
  with `idFromString`). It starts the container with public internet enabled,
  `RER_DEMO=1`, the fixed origin (`RER_INGRESS_ORIGIN` and the seed's origin
  variable), fresh `SESSION_SECRET` and `SETUP_TOKEN`,
  `OWNER_EMAIL` (`DEMO_OWNER_EMAIL`, else `owner@demo.invalid`) and the owner claim's issuer, installation
  id and public key; waits for `/health`; and posts a five-minute ES256 claim
  (`claim.mjs`) to `/auth/owner-claim`. Its alarm ends the demo at its hour or
  after 15 idle minutes: `destroy()`, `deleteAll()` and the place released. A
  container that stops by itself ends its demo too.
  Public internet reads and checks run against real services. The app's demo
  guard simulates effects on people and third-party accounts, while the
  container egress independently refuses direct mail/SMS provider transports
  and SMTP ports. Public-address filtering and TLS remain enforced.
  The platform inactivity timeout is set after start and reapplied when an
  object recovers an already-running container. Persisted alarms enforce the
  exact idle/absolute deadline without keeping a timer in flight. Requests
  check both deadlines before refreshing activity. A container found stopped
  ends the demo and answers the ended page (410).
- `certificate.mjs`: after `wrangler deploy`, the CLI waits for each demo
  hostname's certificate, a TLS handshake that verifies for that name at the
  address public DNS over HTTPS gives (10 minutes at most), and logs each
  attempt. A failed or unverified handshake never counts as active.
- `capacity.mjs`: `DemoCapacity` counts unexpired reservation rows inside a
  storage transaction, excluding diagnostics and expired rows. A lost start
  handoff expires after one minute; a successful claim extends the reservation
  to the demo's end. Refusals log the held ids as SHA-256 fingerprints (also
  logged with each start's correlation), never visitor bearer cookies. The
  refusal's response correlation also identifies that held-place snapshot.
- `image.mjs`, `prepare.mjs`, `template.mjs`, `entrypoint.sh`: the demo image
  build migrates fresh workerd persistence with the packaged engine and closes
  it into `/template`, with no network and no app requests. The entrypoint
  copies that state into a fresh `/data` under the host's existing flock;
  partial or foreign volumes are refused. Startup validates the existing
  migration hashes instead of replaying SQL. Owners, sessions and the seed's
  owner-dependent sample data are still created separately for each visitor.
- `pages.mjs`: the start and ended pages (12ui designs), strict CSP.
  `start-script.mjs` is the start page's script: once Turnstile passes it
  posts the form with `Accept: application/json` (the Worker then answers
  202 `{ pending: true }`, `{ location }` with the cookies, or `{ notice }`
  with the refusal's status)
  and shows each step: the check, the private copy starting, the sign-in. A
  refusal, a network failure or a start past 25 seconds is shown with Try
  again, which first destroys the abandoned copy and releases its place through
  `POST /__demo/cancel`, then runs a new check; progress is announced through a
  `role="status"` region and failures through `role="alert"`. Without
  JavaScript the form posts as before and gets the 303 or the page.
- `remove.mjs`: `rer deploy --demo --remove --yes`. The deploy passes the
  demo's record (`plan.record`) to `wrangler deploy --message`; removal takes
  the Worker for the demo's only while it serves that version, the Custom
  Domain only while it routes to that Worker and the Container application
  only while it belongs to that Worker's DemoContainer namespace, refuses
  anything else before the first delete, deletes by exact id (the Worker
  last) and reads back that each is gone (export/DEMO.md "Removing a hosted
  demo"). `cli/demo-remove.test.mjs` runs it through the CLI against a fake
  Cloudflare account (`tests/demo-account.mjs`).

`node --test modules/demo-host/tests/*.test.mjs` runs the Worker in workerd
with its real Durable Objects and rate limit; Turnstile and the container
platform are the only fakes. `start-page.test.mjs` drives the start page in
Chromium (default-seed's Playwright) through waiting, failure, Try again,
working and the signed-in landing. The end-to-end proof (`wrangler dev` with Docker)
is in DEMO.md.

Startup has a 45-second boot budget, with a separate five-second HTTP probe
limit; waiting for Cloudflare to place the container renews it, up to 90
seconds from the start (see placement below).
The Durable Object owns that work and cleanup while the page polls; a browser
that leaves cannot abandon it. Retrying a pending copy resumes the same
reservation; an explicit Try again cancels it before creating a replacement. Failed starts release their place before returning the retry state, retain the bounded operator diagnostic and destroy
the container. Destruction retries for failed starts never extend or reclaim the
released place. Each release logs the id's SHA-256 fingerprint with the start's
correlation. Every attempt logs its timestamp, elapsed time, duration and
HTTP status or fixed error category, including successful probes. Exit records
include the numeric platform exit code when supplied. A separate random
`x-rer-demo-correlation` response header joins these events without disclosing
the visitor's bearer cookie. Early refusals, including capacity, rate-limit,
Origin and human-check refusals, also carry a correlation and log their status.
Worker observability also enables the platform's
private Container stdout/stderr logs; historical stdout is not exposed by the
Container lifecycle API. Read those logs with an account principal granted
Workers Observability Write, and filter by the application and boot interval.

Optionally set a separate random `RER_DEMO_OPERATOR_TOKEN` (32–512 characters)
when running `rer deploy --demo`. It becomes a Worker secret. A host operator
can request `GET /__demo/operator/<correlation>` with
`Authorization: Bearer <RER_DEMO_OPERATOR_TOKEN>` to see the existing start page
with a bounded, redacted diagnostic line for a failed start. It retains the
last eight probe/exit records, for at most 15 minutes and 32 failed starts.
Unauthenticated requests, demo owner sessions and correlation IDs alone grant
no access. The token never belongs in a URL. Ordinary visitors keep the generic
failure page. No raw error text, health body, cookies or environment values are
included in this diagnostic.

Failed destruction retains its alarm for cleanup. A live visitor's demo also
retains its capacity reservation until destruction is confirmed (or the
container is already stopped); a terminal start failure releases it immediately.
A cleanup failure is logged separately and cannot replace the startup failure
shown to the visitor.

Cloudflare keeps a small prepared pool per application (7 instances on fresh
test hosts, measured in October 2026, whatever `max_instances` is) and places a
new instance only on demand: a start beyond the pool gets "no container instance
that can be provided" until Cloudflare has placed one (16 to 37 seconds
measured, after which boot was normal). `placement.mjs` keeps the same
reservation and launch options, requests placement again only for that specific
provider response, and renews the 45-second boot budget after each wait, up to
90 seconds from the start, extending the reservation to match. Boot, health
and claim errors are not retried. Placement exhaustion answers with the normal
failed-start retry state and releases the reservation; the capacity notice is
reserved for actual reservation exhaustion. Cleanup keeps only that terminal
answer and correlation for one minute, so a status poll after object recovery
still receives the right answer; its alarm then deletes the remaining metadata.

`DemoCapacity` alone admits visitors (`maxInstances` live demos). The Container
application's own `max_instances` is twice that, so instances Cloudflare still
counts after a demo ends or a start fails never refuse a place admission gave.
Its `rollout_active_grace_period` is an hour, a demo's longest life: a redeploy
that rolls the application out (a new image, instance type or limit) replaces
idle prepared instances at once and leaves every live demo running until it
ends. With no grace period a rollout replaced live demos' containers within two
minutes, and their visitors saw "This demo has ended".
