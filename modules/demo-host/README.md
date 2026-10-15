# Hosted demo

The front Worker `rer deploy --demo` deploys at `demo.<domain>` for a seed
that adopted demo mode (`withDemo`, export/DEMO.md). `plan.mjs` turns `deploy-demo.json`
(optionally `instanceType`, one of Cloudflare's predefined Container instance
types, `basic` unless set) into the Worker's Wrangler configuration; the CLI (`cli/demo-host.mjs`) writes
it with these files and the seed's container image folder (workerd engine) to
`.rer/demo-host/` and runs `wrangler deploy` there.

- `worker.mjs`: `GET /` is the start page; `POST /__demo/start` checks the
  exact Origin, the `STARTS` rate limit (3 per IP per 60 s), Turnstile's
  siteverify and capacity, then starts the visitor's demo and answers with the
  owner claim's 303, its session cookie and the `rer_demo` cookie. A request
  with that cookie goes to the visitor's Durable Object; nothing else reaches
  a container.
- `container.mjs`: `DemoContainer`, one per visitor (`newUniqueId`, checked
  with `idFromString`). It starts the container with public internet enabled,
  `RER_DEMO=1`, the fixed origin (`RER_INGRESS_ORIGIN` and the seed's origin
  variable), fresh `SESSION_SECRET` and `SETUP_TOKEN`,
  `OWNER_EMAIL=owner@demo.invalid` and the owner claim's issuer, installation
  id and public key; waits for `/health`; and posts a five-minute ES256 claim
  (`claim.mjs`) to `/auth/owner-claim`. Its alarm ends the demo at its hour or
  after 15 idle minutes: `destroy()`, `deleteAll()` and the place released. A
  container that stops by itself ends its demo too.
  Public internet reads and checks run against real services. The app's demo
  guard simulates effects on people and third-party accounts, while the
  container egress independently refuses direct mail/SMS provider transports
  and SMTP ports. Public-address filtering and TLS remain enforced.
  The platform stops a container about two minutes after its Durable Object's
  last event, when it evicts the object (and the object's exit watcher with
  it). So the alarm stays in flight until the demo's next check, at most three
  minutes, and arms the next at once, as the Containers class keeps its own
  object alive. A request or alarm that finds the container gone ends the demo
  and answers the ended page (410), never a 5xx.
- `capacity.mjs`: `DemoCapacity` admits at most `max_instances` live demos.
- `pages.mjs`: the start and ended pages (12ui designs), strict CSP.
  `start-script.mjs` is the start page's script: once Turnstile passes it
  posts the form with `Accept: application/json` (the Worker then answers
  `{ location }` with the cookies, or `{ notice }` with the refusal's status)
  and shows each step: the check, the private copy starting, the sign-in. A
  refusal, a network failure or a start past 25 seconds is shown with Try
  again, which runs a new check; progress is announced through a
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

Startup probes keep the existing 120-second budget, with a separate five-second
HTTP probe limit. Every attempt logs its timestamp, elapsed time, duration and
HTTP status or fixed error category, including successful probes. Exit records
include the numeric platform exit code when supplied. A separate random
`x-rer-demo-correlation` response header joins these events without disclosing
the visitor's bearer cookie. Worker observability also enables the platform's
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

Failed destruction retains its alarm and capacity reservation for cleanup;
only confirmed destruction (or an already-stopped container) releases the
place. A cleanup failure is logged separately and cannot replace the startup
failure shown to the visitor.
