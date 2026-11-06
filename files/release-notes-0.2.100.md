## 0.2.100

### Acquiring a Zendesk snapshot

- `rer business vendor-key add zendesk` stores the owner's read-only OAuth client in OS credential storage. The CLI mints short-lived tokens, checks their scopes and uses GET for data requests; it never changes Zendesk. Snapshot acquisition retains private pages, attachment blobs, provenance and checkpoints locally, verifies them on resume, and can sweep from the retained high water into another complete snapshot. Census output and retire acknowledgement still need Business adoption.
- Delivery preserves private comments, reply-routing and restriction fields, census tombstones and Guide sidecars, while removing credential-shaped content and attachment access URLs from the delivered copy. Small complete snapshots use the existing v1 bundle; larger ones use logical packages. An unsupported destination receives no segments and the complete local snapshot stays available. This is shared acquisition and transport support, not HappyToHelp native adoption, real-account parity, a completed import or a cutover. Recipe: `cli/README.md`, "Zendesk offline snapshots".

### Sending a complete legacy package

- `rer business legacy-package add DIR` verifies and privately registers a prepared HappyToHelp legacy export without a vendor key or a live-account request. A leased task verifies its sizes, hashes, row/context and per-table counts, objects and attachment counts again before sending the exact files. Removing registration leaves the source directory intact.
- Logical packages cross ordinary upload grants with a manifest probe, digest-bound segments, durable upload inventories and fresh single-use grants. An aware destination must supply the reader for the complete snapshot; segment transport does not increase record authority. Ordinary planning still counts the entire returned snapshot against the plan grant and refuses an oversized aggregate. Refused plans withdraw equivalent segment custody. Edition reader semantics, capacity and original custody remain adoption responsibilities. Recipe: `modules/import-kit/src/door/ADOPTING.md`, "Package-aware sources".

### Reviewing and completing bounded imports

- Opt-in complete-parent imports prepare and seal a complete census, ordered children and their source/native membership before approval. Business supplies the destination, fresh action grants and exact parent and child approvals; the CLI cannot manufacture them. A parent approval alone cannot apply a child, and a successful child never reports aggregate success. Ordinary imports and their quotas keep their existing path.
- Only finalization with all exact children, current approvals, readable custody, complete totals and native/provenance reconciliation advances the complete head. Catch-ups keep the strict under-five-percent rule and existing exclusions. Reversal checks conflicts, handles dependants first and resumes through ordinary strict Undo or partial-job rollback; it is not whole-database atomicity. Concurrent preparation cannot race that reversal, and unchanged catch-up dispositions retain their original ownership.
- Adopters need the typed bounded source/native adapter, Business approval and grant integration, and a new additive migration (the reference supplies `0042_import_bounded_waves.sql`). HappyToHelp reader/grouping adoption and production-sized qualification remain separate; the shared protocol and its bounded proofs do not establish either. Recipe: `modules/import-kit/src/door/waves/README.md`.

### Starting an app and resuming an approved agent read

- Setup and dev let the managed Vite listener use its finite startup budget instead of stopping at 60 seconds. Custom start targets retain their declared deadlines; a missing listener announcement reports elapsed and allowed time with startup-log guidance.
- Legacy MCP tool calls held for approval now return their generated `requestState` alongside `approval_required`, so retrying an approved read resumes the original operation without asking for a second approval.

### Deploying a run site

- `rer deploy --site` now retries a changing or partial Cloudflare list from page one up to three times, waiting 20 seconds between failed reads. It discards incomplete snapshots, never replays deploy writes, preserves other refusals and stops waiting on cancellation.

### Diagnosing publication refusals

- An incomplete publication scan retains bounded, value-free worker, process and output-read diagnostics, including when version stamping fails. Scratch cleanup failure still refuses publication; diagnostics do not turn an incomplete scan into a pass.
