# Durable installation jobs

Optional source for durable local work: immutable intent, exact requested
revisions, checkpoints, attempts, fenced claims and atomic domain writes.
`job-queue` still owns development-command admission; import-kit still
owns reviewed imports, provenance and reversal. Neither is replaced or migrated.

Round 1 supports bounded local handlers only. External compute, delivery and
other effects cannot register as executable capabilities. Qualified container
job restore and Managed leave remain later work; no new UI is supplied.

Copy `index.ts`, `src/`, `native.mjs`, `native.d.mts` and `schema/` from one
immutable Base revision. Worker code imports the TypeScript entry and D1
adapter. Native code imports `nativeDatabase` from `native.mjs`; that separate
entry uses Node SQLite and must stay outside the Worker import graph. The
module has no external package dependencies. See `src/types.ts` for the full
handler, policy, database and limit contracts.

The seed supplies registered versioned handlers, authenticated current scope,
current-authority/revision/erasure predicates in the installation database,
checkpoint decoding, bounded units and result verification. Every domain unit
and its receipt/checkpoint commit in one atomic database operation. A seed
must declare a bounded native tick adapter or explicitly choose manual
execution; inspection does not install a daemon. Client input never selects
SQL, handler source or a policy callback.

`policy.authorizeScope` resolves current read scope without scanning job
payloads; `authorize` and nonempty `commitGuards` protect individual boundaries.
`resultAvailable` can withdraw erased result data while retaining redacted job
history. Defaults bound installation/tenant/kind/source concurrency, queued
intent, starts/failure retries, units, rows/bytes/statements per unit, wall time,
lease/deadline, metadata and list pages. Lifecycle requests retain at most 64
operation receipts per job and refuse further keys rather than forgetting an
idempotency fence. No history or intent identity is automatically pruned.

Apply `schema/0001-durable-jobs.sql` before enabling the runtime. In Base's
reference its exact bytes are `migrations/core/0034_durable_jobs.sql`; migration
numbers belong to the adopting seed. Retain that source origin and checksum.
Preserve applied migrations and released origins; later changes require a new
migration. The runtime refuses unknown, partial or incompatible schema before
job writes. `module.json` inventories all six tables and their archive custody.

Current edition authoring selects this as a separate `role: "module"`
component, with source provenance rather than runtime settings in `edition.json`:

```json
{
  "id": "runeditrun/durable-jobs",
  "role": "module",
  "source": {
    "kind": "local",
    "paths": ["src/modules/durable-jobs", "migrations/core/0034_durable_jobs.sql"],
    "origin": {
      "repository": "runeditrun/base",
      "revision": "FULL_40_HEX_BASE_COMMIT",
      "paths": ["modules/durable-jobs"]
    },
    "mappings": [
      {"path": "src/modules/durable-jobs", "originPath": "modules/durable-jobs"},
      {"path": "migrations/core/0034_durable_jobs.sql", "originPath": "modules/durable-jobs/schema/0001-durable-jobs.sql"}
    ]
  }
}
```

Replace the revision with the adopted full commit and remove these paths from
any overlapping component selection. Stage the copied source and migration,
then use the existing edition-authoring `lock` and `check` commands. Commit
`edition.json`, `sources.lock.json` and retained `.edition/sources/` together.
The lock binds runtime bytes, the independently numbered migration and the
immutable comparison baseline. A migration mapping does not authorize rewriting
an applied migration. Runtime identity, limits and scheduling remain seed-owned
configuration outside that recipe.

Legacy family composition adds `durable-jobs` to the selected modules and
copies `./modules/durable-jobs` to `src/modules/durable-jobs`, plus
`./modules/durable-jobs/schema/0001-durable-jobs.sql` to the seed's next numbered
migration. Both copies have `component: "durable-jobs"` and the same repository
origin. The ordinary `composition.lock.json` records committed source paths,
full repository commits and hashes. Merely shipping CLI source does not enable
job execution in the application.

Archives preserve `rer_job_jobs`, `rer_job_units` and `rer_job_attempts` as
intent/history. `rer_job_leases`, `rer_job_control` and `rer_job_activations`
are mandatory exclusions, including case variants and explicit include requests.
They contain local claims, execution epoch and authority. Every execution needs
a current local activation; missing activation exposes a saved nonterminal job
as `waiting:restored_requires_reauthorization`. An ordinary process restart
retains its database authority; archive restore does not.

Serializable table exclusions ensure inertness, but are not a staged reference
validator or state normalizer. `importSafety` requires executable `importRow`;
a finite safe-value declaration alone cannot perform normalization. Container
imports carrying job history refuse before migrations or destination apply with
`durable_jobs_restore_validator_required`. Keep the archive and source; upgrade
to a release with the destination-owned inactive job restore validator before
restoring into a container. A native adopter supporting executable archive
policy still owns complete staged custody validation and explicit reauthorization;
this round does not qualify the round-3 restore or Managed leave contract.
