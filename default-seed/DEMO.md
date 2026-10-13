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
and is listed in the bar by method and host. Mail stays in the development
outbox and is listed too. `rer deploy` refuses a deploy declaration or
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
3. **Two `vite.config` lines.** The dev persistence path reads `RER_STATE_DIR`,
   and the demo switches reach the dev entry's vars:

   ```ts
   persistState: { path: process.env.RER_STATE_DIR ?? '.wrangler/state' },
   const serve = { main: './src/server.dev.ts', vars: { /* ... */ ...local('RER_DEMO'), ...local('RER_DEMO_EXPIRES') } }
   ```

Add `.rer/demo/` to `.gitignore`. Then run `rer setup` (once), `rer demo`, open
`RER_OPEN`, and check the bar, the data, and a send the seed makes (it must
appear under "Blocked sends").
