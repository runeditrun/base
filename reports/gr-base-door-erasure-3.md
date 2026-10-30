# BLOCKED: legacy personal replay identity

30 October 2026. Diagnostic for the ct ruling of 29 October 2026 23:25Z,
amended 23:58Z. No runtime, adoption policy, clause status or version changes.

Inputs inspected from fresh shallow checkouts:

- Base main: `e881e6f66ce7cd737d17dbeb945995aab83c30d8`.
- Scratch Penny `cloud/sd-door-adopt-penny-1`:
  `81ef6148d504a8c55d447800002be64537f0e3dd`. No Penny push.

## Conflict requiring a retention decision

Ruling 2 removes personal keys and every payload-confirming hash/digest, and
permits exactly its value-free retained fields. Ruling 3a requires replacement
of each personal legacy key by an opaque identity derived from the call row id,
while a retry carrying the old key must find a value-free tombstone and never
repeat the effect. The replacement does not retain the association from an
arbitrary old key to that opaque row identity.

The existing public protocol supplies no independent opaque call identity on an
ordinary retry:

- `modules/agent-door/schema/agent-door.sql`: calls have composite primary key
  `(agent,key)` and independent `decision_id`; no separate call `id` column.
- `modules/agent-door/registry.ts`: public mutation keys are arbitrary nonempty
  strings up to 200 characters.
- `modules/agent-door/pipeline.ts`: an ordinary call uses the literal public
  key as `claimKey` and looks up only `(agent,key)`. The request digest also
  includes the key and personal arguments. Both the saved key and that digest
  must go under the ruling.
- `modules/agent-door/operation.ts`: explicit native continuations have a
  composite operation identity; this does not change ordinary MCP retry input.
- Penny `src/core/features/agent-door/definition.ts`: strips the public key
  before native service execution. There is no native alias for that key.

Two histories can have the same call row id, agent, tool, outcome, timestamps
and erasure marker but different arbitrary personal legacy keys. After the
ruled replacement and redaction their entire retained agent-door states are
identical. An incoming key can have belonged to the erased call in one history
and have never been used in the other. No lookup over this retained state can
recover which history occurred.

Keeping a plaintext alias, reversible ciphertext, a personal-key hash or a
secret-keyed alias would add retained information beyond the permitted fields.
Refusing every unknown key after any erasure would also refuse unrelated new
calls using the supported arbitrary-key protocol. Requiring old callers to
supply an additional opaque row id cannot repair already-issued legacy keys.
The brief does not authorize any of these changes.

BASE-DATA-003 is not a missing mechanism: `modules/erasure` already supplies
native graph custody, policy holds, and atomic portability invalidation.
`modules/portability/journal.mjs` hashes source/table/primary-key tuples for
restore tombstones. Reusing a tombstone over the old `(agent,key)` would retain
a digest that confirms guesses of a personal key; hashing the replacement
opaque identity instead still cannot locate an old-key replay. Audit has no
hash chain; the amendment removes that earlier obstacle, and none is proposed.

## One-off diagnostic run

Node 26's real in-memory SQLite loaded the shipped agent-door schema. The
diagnostic extracted and executed the production ordinary-call lookup, seeded
two synthetic legacy-key histories, replaced their keys using the same opaque
call identity, removed the personal payload and digest, and compared every
agent-door table. This is SQL identity evidence, not a native-erasure adapter.

```text
PASS: both legacy personal keys are initially found by the production lookup
PASS: replacing each legacy key by its opaque row-id-derived identity removes the old-key lookup
PASS: audit sequence and erasure marker survive; personal key and payload digest do not
PASS: other agent/subject record is byte-unchanged
PASS: different legacy-key histories produce identical retained agent-door state
BLOCKED: retained state cannot distinguish an erased legacy key from a never-used key
```

The probe and its output are returned under the run's `reports/probes/` and
`evidence/gr-base-door-erasure-3/`. No dependencies, servers or browsers were
started. No permanent tests, generated copies or product screens changed.

## Recommended decision

Authorize an explicit, narrowly scoped exception for a secret-keyed legacy
replay alias, outside the value-free decision record. Bind the alias to the
original agent/client identity; retain no plaintext legacy key or payload;
keep the secret outside the database and archives; expose only the value-free
tombstone to an authorized retry. Define its retention and restore custody in
the ruling. This is additional retained information and needs ct/owner approval;
it has not been implemented or silently treated as allowed. A future protocol
can require an opaque server-issued call identity before first execution, but
that alone cannot migrate arbitrary existing legacy keys.

## Requested end states

- **A: not established.** No native erasure/public-door adapter was shipped;
  no claim of tombstone response, unchanged effect count, concurrent 409 or
  all-column Penny erasure proof. The SQL probe establishes only the identity
  conflict above.
- **B: not established.** Penny's native erasure/restore fence remains. No
  adoptable subject map is issued to sd while replay custody is unresolved.
- **C: implementation withheld.** No core-flow tests were added or weakened;
  typechecks and `rer check` were not run for this diagnostic-only change. No
  generated copies were touched. Verify on this report branch cannot qualify
  agent-door erasure.

Stop under the brief's blocked-exit rule: satisfying legacy replay would need
an additional retained field/alias or a changed public retry contract.
