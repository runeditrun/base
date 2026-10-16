# Native hosted demos

`rer deploy --demo` builds the seed's production Worker for a Worker Loader
host. See [adoption and deployment](../../export/DEMO.md#hosting-the-demo).

- `build.mjs`, `migration-inventory.mjs`, `build-variables.mjs`: ordinary Vite
  output, declared SQL and public configuration, excluding local private input.
- `native/`: bundle preparation, per-visitor isolate and SQLite storage facade.
- `worker.mjs`, `pages.mjs`, `start-script.mjs`: Turnstile start, progress,
  cancellation and visitor routing. Static assets are served at the edge.
- `capacity.mjs`: concurrent visitor admission and operator diagnostics. This
  is used by the native host as well as retained during legacy upgrades.
- `upgrade.mjs`: verifies ownership, removes the old Container application and
  derives the class migration from deployed namespaces and migration tag.
- `remove.mjs`: exact-id teardown, ownership collision checks and absence reads.

The historical resource-name hash remains stable so released container demos
can upgrade and be removed from a fresh checkout. No container code is shipped.
`rer demo` remains the local Vite/Workers demo, with its own temporary state.
