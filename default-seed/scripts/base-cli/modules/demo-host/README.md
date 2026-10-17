# Native hosted demos

`rer deploy --demo` builds the seed's production Worker for a Worker Loader
host. See [adoption and deployment](../../export/DEMO.md#hosting-the-demo).

- `build.mjs`: ordinary Vite output, declared SQL and public configuration,
  using the shared container migration-inventory and image-variable checks.
- `native/`: bundle preparation, per-visitor D1/seed-DO facets, R2 in the
  visitor's own storage (`r2.mjs` semantics, `r2-store.mjs` rows and chunks),
  durable queue delivery, seed-DO alarms and declared UTC crons.
  A narrow bridge exposes only visitor resource operations to the seed; own-host
  outbound requests return to the same visitor, including declared secondary hosts.
- `worker.mjs`, `pages.mjs`, `start-script.mjs`: Turnstile start, progress,
  cancellation and visitor routing. Static assets are served at the edge.
- `native/warm.mjs`: the start page's prefetch list, built from `dist/client`
  and TanStack Start's route manifest, the console's views first, capped by
  compressed size.
- `capacity.mjs`: concurrent visitor admission and operator diagnostics. This
  is used by the native host as well as retained during legacy upgrades.
- `upgrade.mjs`: verifies ownership, removes the old Container application and
  derives the class migration from deployed namespaces and migration tag.
- `remove.mjs`: exact-id teardown, ownership collision checks and absence reads.

The historical resource-name hash remains stable so released container demos
can upgrade and be removed from a fresh checkout. Portable container hosting
remains separate from the native hosted-demo runtime.
`rer demo` remains the local Vite/Workers demo, with its own temporary state.
