# Optional persistent sales refresh

The maintained reference registers `reference.sales.refresh` only when
`DURABLE_JOBS_REFERENCE=true` and `RER_INSTALLATION_ID` identifies this installation.
The deployment declaration leaves the flag false. Enabling it creates no sales,
tenant memberships, source credentials or provider resources.

Trusted server code uses `createSalesRepository(database, installationId)` to
establish tenant ownership and explicit memberships, then ingest actual USD sales
in batches of at most 100 rows into a draft source revision. `publishRevision`
seals that revision and updates the current source pointer. Ready rows cannot be
modified; `eraseSource` retires the source and deletes its retained domain output.
Operators and the tenant owner must also remain active in native Auth.

The job intent has namespace `reference.sales`, kind `reference.sales.refresh`,
input `{sourceId}`, and requested revision `{sourceRevision}`. The handler copies
bounded pages into per-job persistent rows, then prepares an aggregate receipt.
A separate final unit verifies that retained receipt before admitting a result.
Rows, cumulative totals, source revision and cursor are guarded inside the same
installation transaction. A lost response resumes from that committed cursor.

`/api/rer/jobs` mounts the shared create/list/inspect/cancel/resume/status door.
Authentication uses the native session and existing exact-origin admission;
mutations additionally require the matching Origin and reject cross-site requests.
`x-rer-sales-tenant` selects a tenant lookup, with an absent header selecting
installation-wide work. The server resolves principal, owner and current tenant
membership. Ownership fields cannot be supplied in the intent. Revision changes
hold execution while authorized metadata inspection and cancellation remain
available; erased output is marked unavailable.

`rer dev` and `rer preview` use the declared native lifecycle adapter. Startup
records the CLI process custody, replacing an earlier holder only after its exact
PID/start identity is proved absent or changed, then resumes one bounded safe
unit. The existing scheduled trigger
runs bounded ticks. Shutdown quiesces that exact holder and fences pending units.
Native inspection opens the existing canonical installation database read-only,
resolves its current owner and memberships, and returns the shared safe projection.
It never starts work. Native status refuses installations over its bounded scope
limit instead of silently omitting tenants.

This round supplies native scheduling. A hosted Worker with the flag enabled
still requires a supported hosted scheduler activation adapter: its scheduled
wake-up reports `scheduler_unconfigured` while inactive. A cron never grants
execution authority or reverses quiescence. External compute, outbound effects,
and hosted/Managed lifecycle integration remain later-round work.
