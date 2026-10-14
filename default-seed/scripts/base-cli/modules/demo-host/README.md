# Hosted demo

The front Worker `rer deploy --demo` deploys at `demo.<domain>` for a seed
that adopted demo mode (`withDemo`, export/DEMO.md). `plan.mjs` turns `deploy-demo.json`
into the Worker's Wrangler configuration; the CLI (`cli/demo-host.mjs`) writes
it with these files and the seed's container image folder (workerd engine) to
`.rer/demo-host/` and runs `wrangler deploy` there.

- `worker.mjs`: `GET /` is the start page; `POST /__demo/start` checks the
  exact Origin, the `STARTS` rate limit (3 per IP per 60 s), Turnstile's
  siteverify and capacity, then starts the visitor's demo and answers with the
  owner claim's 303, its session cookie and the `rer_demo` cookie. A request
  with that cookie goes to the visitor's Durable Object; nothing else reaches
  a container.
- `container.mjs`: `DemoContainer`, one per visitor (`newUniqueId`, checked
  with `idFromString`). It starts the container with `enableInternet: false`,
  `RER_DEMO=1`, the fixed origin (`RER_INGRESS_ORIGIN` and the seed's origin
  variable), fresh `SESSION_SECRET` and `SETUP_TOKEN`,
  `OWNER_EMAIL=owner@demo.invalid` and the owner claim's issuer, installation
  id and public key; waits for `/health`; and posts a five-minute ES256 claim
  (`claim.mjs`) to `/auth/owner-claim`. Its alarm ends the demo at its hour or
  after 15 idle minutes: `destroy()`, `deleteAll()` and the place released. A
  container that stops by itself ends its demo too.
- `capacity.mjs`: `DemoCapacity` admits at most `max_instances` live demos.
- `pages.mjs`: the start and ended pages (12ui designs), strict CSP.

`node --test modules/demo-host/tests/*.test.mjs` runs the Worker in workerd
with its real Durable Objects and rate limit; Turnstile and the container
platform are the only fakes. The end-to-end proof (`wrangler dev` with Docker)
is in DEMO.md.
