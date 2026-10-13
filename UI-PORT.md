# UI-PORT.md — build the edition's interface on real behaviour

Read `AGENTS.md`, `CONTRACT.md` and `HANDOVER.md`. This stage ports an accepted
edition UI onto the common stack and implements the real behaviour needed by
that slice. It is not evidence that every contracted capability is complete.

The edition owns its complete source, selected graph, integration and finished
UI. Base and headless families supply reusable implementations. Modules may
include substantial backend, frontend, migrations and tests, and may live in an
edition, family, Base or independent repository. Maintain a complete tested path
that saves implementation and adaptation work; owners may change any source,
core schema, UI, framework or infrastructure. All layers are MIT.

Lily, Orbit, Lamp and Ferry use [edition-owned authoring](edition-authoring/README.md).
Beacon, Brook and HappyToHelp retain the Support legacy family exporter until
separately converted. Never regenerate converted editions from family source.

Use the accepted edition design as the visual reference. Preserve its states,
flows, spacing and copy; replace throwaway implementation and fabricated
behaviour. Other prototypes and incumbent research can inform decisions without
forcing their screens into this edition. Design missing surfaces through the
applicable UI design workflow before implementing them. Record meaningful new
decisions and preserve requirements intended for later editions.

## The application

The standard deployment has `/` as the owner's front door, `/app` as the operator
application behind a native session, and `/signin` for sign-in. Declare every
sessionless path in `seed.json → deploy.publicPaths`.

Where the product has a public surface, make the landing that surface: a status
page, booking page, portal or other contracted journey. For an internal tool,
use the owner's identity, a configurable description and sign-in. Avoid vendor
pricing, invented testimonials or metrics. Make owner content and branding real
configuration; `src/ext/config.ts` is an existing useful convention, not the
only permissible location. A product credit, if included, is a removable static
link and never phones home. Add or update clauses for new observable behaviour.

## Implement the selected slice

The maintained starting path uses TypeScript, Vite + React + TanStack Start with TanStack Router, shadcn/ui +
Tailwind, Hono and Drizzle on D1 in the existing Cloudflare Worker. Follow
[TANSTACK-START-MIGRATION.md](TANSTACK-START-MIGRATION.md) for an existing app's
rendering migration. Keep files split by responsibility; let real code establish
the layout. Edit the edition’s authoritative source or selected shared implementation and
use its actual authoring workflow. Verify the integrated product. Agents choose
any method to integrate upstream changes while preserving owner requirements
and applied migration history.

Start renders React documents. Use server-function-backed loaders for current
bound data and prerender only deployment-invariant pages. Return meaningful
first-response HTML, metadata and real status. Existing contract-owned Hono/R2
pages, feeds, widgets, APIs and native auth retain ownership; dispatch known Hono
surfaces before Start. Check native sessions before `/app` private loader data
and inside every private server function. Preserve event exports. Unknown
documents and missing assets return real 404s.

Build real schema, repositories and services for the workflows being ported,
using local Cloudflare bindings. No fixture arrays in application components,
mock services, fake fetch handlers or semantic fallbacks. Demo content belongs in
`sample-data/` and enters through real code paths; mocks belong only in tests.
When a provider is unconfigured, expose the actual contract-defined unconfigured
state. That does not establish the missing configured behaviour as implemented.

Owners may edit core or any other code. Supported extension seams and owner-local
paths can reduce repeated work; do not impose them where a coherent core change
is better. Keep server-only dependencies and credentials out of browser bundles,
and preserve native authorization and trust-boundary validation.

## Verify and hand off

Coordinate file ownership when parallelising independent work. Use actual package
scripts and the implemented product and composition schemas. Preserve the
assembly lock identifying source repositories, commits and file provenance. Run real verification and applicable registered contract/baseline tests.
Keep coverage gaps explicit; a partial port cannot report the whole contract
satisfied. Estimate operating cost from current provider terms and measured
requirements when updating cost claims; do not copy old pricing assumptions.

A clean clone must run the implemented journeys with real local data. Exercise
the emitted Worker and hydrated browser: meaningful SSR or allowed prerendered
HTML and metadata, native session protection, genuine 404s and internal React
navigation without another document request or browser errors. Apply the full
migration acceptance matrix where that migration is in scope, including direct
private server-function transport and preserved Hono behavior.

Capture current key screens in `visual/`. Update `HANDOVER.md` with what was
ported, designed, implemented and verified, plus remaining edition work and
coverage. Record deliberate requirement changes by affected clause ID, with
reasons, owner-authorized replacement requirements and appropriate verification.
Baseline files remain editable; keep their requirements and evidence coherent
with recorded owner intent. This stage is complete when its defined slice works and
is verified. An edition is installable only when its full declared product and
release requirements are met. Commit or publish within session authorization.

Feed useful discoveries and regression tests back into maintained shared source,
then verify adoption in other editions with their own requirements. Hooks and
configuration are conveniences; deep divergence remains eligible for later fixes.
