# Native hosted demos

`rer deploy --demo` builds the seed's production Worker for a Worker Loader
host. See [adoption and deployment](https://github.com/runeditrun/base/blob/main/export/DEMO.md#hosting-the-demo).

- `build.mjs`: ordinary Vite output, declared SQL and public configuration,
  using the shared container migration-inventory and image-variable checks.
- `native/`: bundle preparation, per-visitor D1/seed-DO facets, R2 in the
  visitor's own storage (`r2.mjs` semantics, `r2-store.mjs` rows and chunks),
  durable queue delivery, seed-DO alarms and declared UTC crons.
  A narrow bridge exposes only visitor resource operations to the seed; own-host
  outbound requests return to the same visitor, including declared secondary hosts.
- `worker.mjs`, `pages.mjs`, `start-script.mjs`: Turnstile start, progress,
  cancellation and visitor routing. Static assets are served at the edge.
- `theme.mjs`, `page-style.mjs`, `theme-script.mjs`: the start and ended pages
  inline the seed's built `rer-theme.css`, fonts CSS and imports in the same
  cascade as the Lobby. Their colours, type and mark follow its `--rer-*` tokens,
  including media rules. Font faces use swap or optional display, so neither
  CSS fetches nor fonts hold first paint. Disabled buttons use the surface,
  border and muted-text tokens; only actionable buttons use the accent fill.
  `theme-script.mjs` sets the page and Turnstile scheme from the painted card's
  background and text before the widget renders, and updates on preference changes.
  The maintained default seed's theme assets supply missing tokens or an
  absent theme, under `/__demo/theme/`, except the link colour: a seed theme
  without `--rer-link` links in its own `--rer-text`, as the theme grammar reads
  it. Styles, fonts and marks stay same-origin; a missing mark leaves the
  product name visible.
- `native/warm.mjs`: the start page's prefetch list, built from `dist/client`
  (the Vite manifest if the build wrote one, else the build's `assetsDir`, else
  `assets`) and TanStack Start's route manifest, the console's views first,
  capped by compressed size. The same built chunks (`bundle.immutable`) are
  what `native/worker.mjs` serves with an immutable `cache-control`, besides
  hashed files under `/assets/`.
- `capacity.mjs`: concurrent visitor admission and operator diagnostics. This
  is used by the native host as well as retained during legacy upgrades.
- `upgrade.mjs`: verifies ownership, removes the old Container application and
  derives the class migration from deployed namespaces and migration tag.
- `remove.mjs`: exact-id teardown, ownership collision checks and absence reads.
- `ownership.mjs`: read-only recovery when secret PUT removed the version message.
  The served version must be newest, with a contiguous secret-triggered history
  back to this demo's rer record and identical script ETag, runtime and bindings
  (including secret names and bound resource IDs). Only upload-tool provenance may
  differ. Missing history, changed resources or a foreign message refuses before
  writes. The next ordinary deploy writes the annotation again.

The historical resource-name hash remains stable so released container demos
can upgrade and be removed from a fresh checkout. Portable container hosting
remains separate from the native hosted-demo runtime.
`rer demo` remains the local Vite/Workers demo, with its own temporary state.
