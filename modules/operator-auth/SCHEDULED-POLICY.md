# Owner-approved scheduled policies

Design · 19 October 2026

A seed declares trusted server-side policy definitions through the
`scheduledPolicies: () => definitions` option of OA `createOperatorAuth`.
There is no HTTP run endpoint and no request header, token, session kind or
caller-supplied actor that grants scheduled authority. Native-account adapters
must implement their own equivalent transaction fence before adopting this door.

## Definition and approval

Each definition contains an id, job kind, JSON parameters and an explicit list
of allowed actions with their target scopes. The initial supported actions are
`operators:deactivate` and `operators:reactivate`; neither may target an owner or
an invitation. Scopes require non-owner roles and may restrict exact operator
ids and require no sign-in within `inactiveDays`. Inactivity here means no OA
session created since the cutoff (or account creation for someone never signed
in), not a claim to measure a seed's domain activity. Seeds needing domain
activity must first add an enforceable scoped action for their own store.

Canonical JSON sorts object keys, preserves array order and rejects non-JSON
values. SHA-256 covers the entire definition, including id, kind, parameters,
actions and scopes. Changing any field needs fresh approval. The signed-in
owner submits the hash they reviewed; the server reads the current definition
again and refuses a stale hash. Approval stores the exact definition and action
set, hash, owner id and authority version, approval time and revocation time.
Approval/revocation require the existing origin, session and transaction fence.
Reapproval creates a new approval record and revokes its predecessor atomically.

## Scheduled authority

A trusted Worker scheduled handler calls `auth.scheduledPolicies.run(policyId,
async run => { await run.execute('operators:deactivate', operatorId) })`. The
callback receives a bounded capability, never a simulated owner request or a
session. The door reads the current definition at admission and before each
action, checks its hash against the live approval, and creates a unique run id.
Every attempt is recorded, including missing, edited, revoked or invalid-owner
approvals. Errors propagate to the scheduled handler after the run is logged.

The existing store actor fence gains an internal, unforgeable policy-actor
branch. It rechecks the exact approval id/hash/action set, revocation, active
owner role and authority version, live run, action and target scope inside the
same D1 transaction as the status mutation and audit event. The ordinary session
branch is unchanged. Owner targets, invitations and actions outside the approved
set fail closed. A completed/failed run capability cannot act again. Revocation
stops future runs and subsequent writes of an already executing run immediately
at the transaction boundary. It cannot undo an action already committed.
The final-owner and invitation/version database triggers continue to apply.

Audit entries record `policy:<id>@<sha256>`, `approvedBy`, approval id, run id,
action and target. Runs retain started/finished times, outcome and refusal code;
approval and revocation are audited as the signed-in owner. Partial runs retain
every committed action audit even if a later action fails. Worker code and its
DB binding are trusted: this door bounds authority granted through operator-auth,
not arbitrary SQL written by a compromised seed deployment. Version a job kind
when changing its semantics; all security-relevant bounds belong in the hashed
definition and must be enforced by the action implementation.

## Adoption and owner flow

Apply `accounts/schema/scheduled-policy.sql` as a new numbered migration on an
existing OA store. Fresh OA schemas include the same tables. Declare policies in
trusted source, not HTTP input; wire cron to `run`. Refusals remain recorded; a handler may continue unrelated
maintenance but must never rewrite a refused run as success. Select candidates using real seed data, then call `run.execute` for each;
the fence repeats the approved bounds even if selection is stale or overbroad.

The owner screen must show kind, parameters, complete actions/scopes and current
hash, the approving owner/time, approval status and run history. Submit that exact
hash on approval, expose revoke, and explain that edits require approval again.
Base's default seed supplies `/app/policies` and a conservative inactive-member
example. It starts unapproved. Owners list definitions/approvals and runs through
`GET /auth/policies` and `GET /auth/policy-runs`; POST `/auth/policy/approve` takes
`{policyId, versionHash}`, POST `/auth/policy/revoke` takes `{approvalId}`.
The reference uses Base's existing theme and native forms.

Tests use the existing emitted Worker harness's `worker.scheduled()` door, real
D1 migrations and signed-in approval APIs. They cover success/audit, an edited
policy and reapproval, revocation, disallowed action/scope, non-owner approval,
owner demotion and unchanged signed-in status administration.


```ts
const definitions = () => [{
  id: 'inactive-members', kind: 'deactivate-members-without-recent-signin.v1',
  parameters: { inactiveDays: 90 },
  actions: [{ action: 'operators:deactivate',
    scope: { roles: ['member'], inactiveDays: 90 } }],
}];
const auth = createOperatorAuth({ ...authOptions, scheduledPolicies: definitions });
// Inside Worker.scheduled; candidates come from the seed's real database.
await auth.scheduledPolicies.run('inactive-members', async run => {
  for (const candidate of candidates) {
    await run.execute('operators:deactivate', candidate.id);
  }
});
```

`list` returns all approval history and each current declaration's approval
state; `runs` returns the latest 100 attempts. Keep the full `oa_policy_runs` and
`oa_auth_audit` records for longer history. Approvals survive sign-out/session
expiry: they are an explicit delegation, not a persisted session. Authority
version changes invalidate them, including demotion followed by promotion.
