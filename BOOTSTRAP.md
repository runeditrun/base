# BOOTSTRAP.md — define an edition before building it

Read `AGENTS.md`, `BASELINE.md`, the relevant product research and `HANDOVER.md`.
This stage turns an intended edition and its UI into a clear build brief; it does
not claim that the backend or release tooling already exists.

The edition owns its complete source, selected graph, integration and finished
UI. Base and headless families supply reusable implementations. Modules may
include substantial backend, frontend, migrations and tests, and may live in an
edition, family, Base or independent repository. Maintain a complete tested path
that saves implementation and adaptation work; owners may change any source,
core schema, UI, framework or infrastructure. All layers are MIT.

Lily, Orbit, Lamp and Ferry use [edition-owned authoring](edition-authoring/README.md).
Beacon, Brook and HappyToHelp retain the Support legacy family exporter until
separately converted. Never regenerate converted editions from family source.

## Understand and make the product visible

Inspect the relevant prototype, research and recorded decisions; run the
prototype where possible. Identify who the edition serves, its useful outcome,
public and operator surfaces, entities, lifecycles, defaults and failure states.
Preserve accepted design decisions and owner intent. A prototype's code can be
replaced; its fabricated behaviour is not proof of a working capability.

Use relevant incumbent research to discover workflows and refinements. Do not
require reports on every incumbent, a family-wide superset, or incumbent parity
before one useful edition can proceed. Existing family synthesis and edition
deltas are inputs, not instructions to turn the family into one complete app.
Keep requirements that belong to other editions visible in their plans.

Work through the edition's journeys and UI before implementation. Use the
applicable UI design workflow to make missing surfaces tangible. Decide the
family domain and selected modules from what the edition needs; do not invent
abstractions or extension quotas ahead of that evidence. Optimise total agent
work, elapsed time and owner effort to an accepted product, including rework.

## Write the contract and composition

Write `CONTRACT.md` with a short scope and observable clauses grouped by area,
using stable IDs and one testable behaviour per clause. `CONTRACT.example.md`
illustrates the standard, not required features. Cover failures, provider
outages, authorization, externally triggered idempotency and recovery as well
as successful journeys. State non-goals. Mark useful supported policies with
versioned IDs, without making every decision an extension point.

Distinguish necessary family guarantees, selected module guarantees and edition
journeys/defaults/UI in the brief. Preserve applicable stable IDs and make their
test ownership clear; the edition must verify its integrated behaviour. Use the edition’s actual authoring recipe and retained source lock. The
[exporter guide](composition/README.md) applies to remaining legacy editions.

Ship coherent baseline requirements and evidence. Owners may edit `BASELINE.md`
and related source when deliberately changing requirements: identify affected
`BASE-` IDs, record the reason and owner-authorized requirement change, and supply
replacement requirements and tests. Use reporting supported by the edition;
record missing reporting honestly rather than requiring an unimplemented registry.
Reserve `BASE-` for the baseline. Published IDs are never reused.
Give the draft a focused adversarial review for contradictions, ambiguity,
untestable promises and missing failure behaviour.

## Use the tooling that exists

Draft `seed.json` against the actual schema and validator in base. The
current SEED schema retains legacy `spine` and accepts optional
`composition: {base, family, edition, modules}`. Edition-owned authoring uses `edition.json` and `sources.lock.json`; legacy
family trees use `family.json` and COMPOSITION v2 source maps. Map
capabilities to clauses, declare externals and their reasons, environment,
health/public paths and supported extension points. Distinguish estimates from
measured limits; do not put invented measurements into validated fields.

Inspect available contract helpers, baseline reporting and package scripts
before adding anything. Reuse the real helpers. `pnpm verify` must run actual
checks and report uncovered guarantees honestly; a named test or a planned
inventory is not satisfied coverage. Use pnpm and remove obsolete lockfiles
when changing package managers. Do not scaffold empty architecture folders.

## Handoff

Leave a concise `HANDOVER.md` stating the edition outcome, accepted UI, selected
capabilities, what works, what remains and the next useful implementation slice.
Record substantive departures from shared guidance with their reasons in
`DIVERGENCE.md`; do not weaken baseline guarantees silently. Remove the example
contract once the real contract replaces it. A completed bootstrap is a reviewed
product brief and honest manifest/status, not a released edition. Commit or
publish only within the session's authorization.

Feed useful discoveries and regression tests back into maintained shared source,
then verify adoption in other editions with their own requirements. Hooks and
configuration are conveniences; deep divergence remains eligible for later fixes.
