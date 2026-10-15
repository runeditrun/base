# Demo mode: adopting `rer demo`

`rer demo` (the same as `rer dev --demo`) runs this checkout as a throwaway demo:
signed in as the saved owner, filled with the seed's demo data, marked by a
"Demo · nothing is sent · ends HH:MM" bar on every page, and unable to send
anything. It needs `rer setup` first; it reuses the saved owner and private
settings (`.dev.vars`) and nothing else.

```sh
rer demo            # prints RER_READY, RER_OPEN and RER_DEMO_ENDS_ON_STOP
rer demo --stop
```

Its data lives in `.rer/demo/<start time>/` and is deleted when it stops:
`rer demo --stop`, Ctrl-C, or its end (one hour after it starts; `--idle-timeout
SECONDS` sets another). The checkout's own `.wrangler/state` is never written.
Only one server runs per checkout, so stop `rer dev` before `rer demo` and the
other way round.

## What it guarantees

Base's `modules/demo` (`withDemo`) does nothing unless the runtime has
`RER_DEMO=1`. With it, global `fetch` answers loopback hosts only, for the whole
isolate (routes, cron, queue consumers, Durable Objects); any other request
throws `TypeError: fetch failed`, the error a failed delivery already raises,
and is listed in the bar by method and host. A loopback answer's redirects are
followed through the same check, hop by hop. `new WebSocket`, `navigator.sendBeacon`, `new EventSource`, `node:net` (and
so `node:tls`) and `cloudflare:sockets` `connect` answer loopback only too, and
their refusals are listed the same way. Mail stays in the development outbox
and is listed too. `rer deploy` refuses a deploy declaration or
`--env-file` that carries `RER_DEMO`.

## Adopting it in a seed

1. **The hook.** Add `src/demo.ts` exporting
   `seedDemo(env, { ownerEmail, now })`. Put the seed's existing sample data in
   (the records a new owner would want to see, the owner's finished first run).
   It runs once, after the owner exists, and must be idempotent: fixed IDs with
   `INSERT ... ON CONFLICT DO NOTHING`. It never fetches.
2. **The import.** Copy Base's `modules/demo/` beside the seed's other Base
   modules (it uses `operator-auth/http.mjs` and `operator-auth/csp.mjs`). Make
   `withDemo` the first import of the Worker entry (`src/server.ts`), so it runs
   before any module could keep the real `fetch`, and wrap the default export:

   ```ts
   import { withDemo } from './modules/demo/index.mjs' // first import; Base's default-seed: '../../modules/demo/index.mjs'
   import { seedDemo } from './demo'
   export default withDemo({ fetch, queue, scheduled }, { seed: seedDemo })
   ```

   Options: `binding` names the D1 binding when it is not `DB`; `owner(env)`
   returns the owner's email when the seed's accounts are not Base
   operator-auth's.
3. **Three `vite.config` changes.** The dev persistence path reads
   `RER_STATE_DIR`, the demo switches reach the dev entry's vars, and
   `demoSockets()` (first in `plugins`) hands the Worker's `cloudflare:sockets`
   imports the guarded `connect` under `rer demo`:

   ```ts
   import { demoSockets } from './src/modules/demo/vite.mjs'
   persistState: { path: process.env.RER_STATE_DIR ?? '.wrangler/state' },
   const serve = { main: './src/server.dev.ts', vars: { /* ... */ ...local('RER_DEMO'), ...local('RER_DEMO_EXPIRES') } }
   plugins: [demoSockets(), cloudflare({ /* ... */ }), /* ... */],
   ```

Add `.rer/demo/` to `.gitignore`. Then run `rer setup` (once), `rer demo`, open
`RER_OPEN`, and check the bar, the data, and a send the seed makes (it must
appear under "Blocked sends").

## Hosting the demo

`rer deploy --demo` puts the demo on the web at `demo.<domain>` (the run site's
apex), so a visitor gets their own throwaway copy: the start page runs a
Turnstile check and starts it, and they land signed in as the owner, with the
seed's demo data and the Demo bar. Each visitor gets their own Cloudflare
Container running this seed's image (`rer build --platform container`, workerd
engine) with `RER_DEMO=1` and no internet, behind one front Worker
(`<project>-<environment>--demo`). The engine's egress worker refuses every
request too, so a send fails three ways. Only the visitor's random `rer_demo`
cookie (HttpOnly, Secure, SameSite=Lax, one hour) reaches their container. A
demo ends after 60 minutes, or 15 minutes with no requests; its container is
destroyed and its state deleted, and the visitor sees "This demo has ended".
Until then the container stays up however quiet the visitor is, and one that
stops early anyway also ends its demo and frees its place.
The demo image carries its databases already migrated. Each visitor copies that
prepared state, then gets a fresh owner, session and owner-dependent sample data.
The start page polls progress on the same copy; a slow start does not leave a
request waiting for minutes. Admission answers within 12 seconds, each progress
poll within two seconds, and a copy that cannot start within 45 seconds is ended.
A retry while it is starting resumes that copy without taking a second place.

At most `maxInstances` demos (10 unless set) run at once, and one IP starts at
most 3 a minute.
Mail lands in the outbox (and the bar) only where the seed's development
outbox accepts the demo's https origin; otherwise the seed's mail is simply
unconfigured. Nothing is sent either way.

The seed needs, beyond the adoption above:

1. **`deploy-demo.json`** beside `deploy-site.json`:

   ```json
   { "version": 1, "domain": "run-lamp.com", "name": "Lamp" }
   ```

   Optional: `"maxInstances"`; `"instanceType"`, the Cloudflare Containers
   instance type every visitor's container runs on (`lite`, `basic`,
   `standard-1`, `standard-2`, `standard-3` or `standard-4`; `basic` unless
   set); and `"settings"`, plain demo settings for the
   container (never secrets, never `RER_*`, the origin, `OWNER_EMAIL`,
   `SESSION_SECRET` or `SETUP_TOKEN`, which the front sets). `deploy.json`
   must list `"container"` in `platforms`.

   A larger type starts a demo sooner and costs more for every minute a demo
   runs: Cloudflare bills a container's memory and disk as provisioned and
   its CPU as used. `standard-1` (1/2 vCPU, 4 GiB) costs about 4x `basic`
   (1/4 vCPU, 1 GiB) for memory, 2x for disk, and can use 2x its CPU;
   `standard-2` (1 vCPU, 6 GiB) costs about 6x for memory and can use 4x the
   CPU. `rer deploy --demo --dry-run` prints the type it plans. Rates are on
   Cloudflare's Containers pricing page.
2. **The signed owner claim.** The front signs the owner in with a
   five-minute claim to `/auth/owner-claim`, signed by a key pair made for
   that one container. The seed serves `modules/owner-claim`'s
   `createOwnerClaimHandler` there when `RER_OWNER_CLAIM_PUBLIC_KEYS` is set,
   with `RER_OWNER_CLAIM_ISSUER`, `RER_OWNER_CLAIM_INSTALLATION_ID`, its
   origin and `OWNER_EMAIL` (Base's default seed:
   `src/core/platform/auth/dependencies.server.ts`).
3. **The workflow.** Copy Base's `export/run-demo.yml` to
   `.github/workflows/run-demo.yml`. It deploys on each push to `main` only
   when the repository variable `RUN_DEMO_DEPLOY` is `true`, and whenever it
   is run by hand. Run by hand with `test_only`, it deploys a separate test
   host instead: environment `demo-test` at `demo.test.<domain>`, with
   Cloudflare's Turnstile test keys, which let every visitor start a demo
   (the 10-demo cap and the rate limit still apply). After a deploy it waits
   for the new hostname to resolve in public DNS (10 minutes at most) and for
   the start page to answer 200 (5 minutes more), then checks it sets no
   cookie; either wait ends with an error naming what did not happen.

`rer deploy --demo --dry-run` builds everything into `.rer/demo-host/` (add it
to `.gitignore`) with no provider request. To try it locally with Docker, add
Cloudflare's always-passing Turnstile test secret to `.rer/demo-host/.dev.vars`
(`TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA`) and run, in that
folder, `wrangler dev --local-protocol https --var TURNSTILE_SITE_KEY:1x00000000000000000000AA`.
Wrangler serves the Worker as it is routed, so the Worker sees
`https://demo.<domain>`: point that name at `127.0.0.1` (for example in
`/etc/hosts`) and open `https://demo.<domain>:8787/`.

### Removing a hosted demo

```sh
rer deploy --demo --remove --yes                          # demo.<domain>
rer deploy --demo --remove --yes --environment demo-test  # with deploy-demo.json's domain set to test.<domain>
```

or run the workflow by hand with `remove` (and `test_only` for the test
host). It needs only `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`, the
deploy's token. It deletes what the demo's deploy made, each by its exact
provider id: the Custom Domain `demo.<domain>` (Cloudflare removes the DNS
record it added with it), the Container application `wrangler deploy` created
for the demo Worker's Durable Object namespace, and the front Worker, whose
Durable Objects go with it. The demo makes no D1, KV, R2 or queue. Then it
reads back that each is gone.

The deploy leaves its record on the provider, as the message of the Worker
version it uploads (`rer-demo:<hash>` of the Worker, hostname and container
names), so a fresh checkout or CI runner can remove it. Removal refuses before
any delete when the Worker of that name serves no such version, the hostname
routes to another Worker, a Container application of that name belongs to
another namespace, or another hostname is attached to the demo Worker; it
touches nothing else in the account. The Worker goes last, so a run that stops
part way leaves the record for the next run. Once the demo is gone, another
run finds nothing and changes nothing. A demo deployed by rer before 0.2.12
carries no record: deploy it once with this rer, then remove it.

### Owner steps

1. **Workers Paid** on the Cloudflare account that holds the run site
   (Containers are included; a visitor-hour on `basic` costs about one cent).
2. **A Turnstile widget** for `demo.<domain>` (managed mode). In the seed
   repository's `run-demo` GitHub environment, set the variable
   `TURNSTILE_SITE_KEY` and the secret `TURNSTILE_SECRET_KEY` from it, plus
   the variable `CLOUDFLARE_ACCOUNT_ID` and the secret `CLOUDFLARE_API_TOKEN`.
3. **The deploy token**: the run site's token (Workers Scripts: Edit; Zone:
   Read and Workers Routes: Edit on the run site zone) plus **Containers:
   Edit** on the account.
4. **`RUN_DEMO_DEPLOY=true`** as a repository variable when the demo should go
   live. Until then nothing deploys.
