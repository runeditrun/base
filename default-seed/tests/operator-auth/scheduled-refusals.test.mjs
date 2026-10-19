import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scheduledHarness, definition } from './scheduled-harness.mjs'

async function refused(response, error, status = 403) {
  assert.equal(response.status, status, await response.clone().text())
  assert.equal((await response.json()).error, error)
}

test('standing approval needs fresh native proof or session-bound step-up and rejects authenticated dev/review sessions', async () => {
  const h = await scheduledHarness()
  try {
    const owner = await h.person('owner@example.test', 'owner', { sessionDaysAgo: 6 })
    const input = await h.approvalInput()
    await refused(await h.post('/auth/policy/approve', input, owner.cookie), 'step_up_required')
    const unproved = await h.sessionFor(owner, { proof: false })
    await refused(await h.post('/auth/policy/approve', input, unproved.cookie), 'step_up_required')
    for (const sessionKind of ['dev', 'review']) {
      const session = await h.sessionFor(owner, { sessionKind })
      assert.equal((await h.json(await h.call('/auth/session', { cookie: session.cookie }))).kind, sessionKind)
      await refused(await h.post('/auth/policy/approve', input, session.cookie), 'policy_session_denied')
    }
    assert.equal((await h.post('/auth/step-up', { action: 'owner:transfer' }, owner.cookie)).status, 202)
    const token = new URL(h.mails.at(-1).text.match(/https?:\/\/\S+/)[0]).searchParams.get('token')
    assert.equal((await h.post('/auth/confirm', { token }, owner.cookie)).status, 303)
    const steppedUp = await h.approveAs(owner.cookie)
    assert.equal(steppedUp.sessionKind, 'native')
    const fresh = await h.sessionFor(owner)
    const signedIn = await h.approveAs(fresh.cookie)
    assert.notEqual(signedIn.id, steppedUp.id)
  } finally { await h.close() }
})

test('seed role policy gates every grant and target; caught scope/action refusals still leave the run refused', async () => {
  let denyReactivation = true, protectedId
  const rolePolicy = ({ actor, action, target }) => actor.status === 'active' && actor.role === 'owner'
    && !(denyReactivation && action === 'operators:reactivate')
    && !(action === 'operators:deactivate' && target?.id === protectedId)
  const policies = () => [definition({ actions: [...definition().actions,
    { action: 'operators:reactivate', scope: { roles: ['member'] } }] })]
  const h = await scheduledHarness({ rolePolicy, definitions: policies })
  try {
    const owner = await h.person('owner@example.test', 'owner', { sessionDaysAgo: 0 })
    const dormant = await h.person('dormant@example.test', 'member', { sessionDaysAgo: 120 })
    const recent = await h.person('recent@example.test', 'member', { sessionDaysAgo: 5 })
    const young = await h.person('young@example.test', 'member', { createdDaysAgo: 10 })
    const admin = await h.person('admin@example.test', 'admin', { sessionDaysAgo: 120 })
    const invited = await h.person('invited@example.test', 'member', { status: 'invited' })
    const billing = await h.person('billing@example.test', 'member', { sessionDaysAgo: 200 })
    protectedId = billing.id
    await refused(await h.post('/auth/policy/approve', await h.approvalInput(), owner.cookie), 'policy_action_denied')
    assert.equal((await h.json(await h.call('/auth/policies', { cookie: owner.cookie }))).approvals.length, 0)
    denyReactivation = false
    await h.approveAs(owner.cookie)
    await refused(await h.post('/auth/operator/status', { operatorId: billing.id, status: 'inactive' }, owner.cookie), 'forbidden')
    const attempts = [['billing', billing.id], ['owner', owner.id], ['recent', recent.id], ['young', young.id], ['admin', admin.id],
      ['invited', invited.id], ['wildcard', '%'], ['star', '*'], ['sqlish', `${dormant.id}' OR '1'='1`],
      ['role', dormant.id, 'operators:role'], ['dormant', dormant.id]]
    const results = {}
    const run = await h.runWith(async capability => {
      for (const [name, id, action = 'operators:deactivate'] of attempts) results[name] = await h.code(capability.execute(action, id))
    })
    assert.deepEqual(results, { billing: 'policy_action_denied', owner: 'authority_changed', recent: 'authority_changed', young: 'authority_changed',
      admin: 'authority_changed', invited: 'authority_changed', wildcard: 'operator_not_found', star: 'operator_not_found', sqlish: 'operator_not_found',
      role: 'policy_action_denied', dormant: 'ok' })
    assert.deepEqual([run.status, run.error], ['refused', 'policy_action_denied'])
    for (const person of [owner, recent, young, admin, billing]) assert.equal(await h.status(person.id), 'active')
    assert.equal(await h.status(invited.id), 'invited')
    assert.equal(await h.status(dormant.id), 'inactive')
  } finally { await h.close() }
})

test('a refused definition edit invalidates the approval even when the previous definition returns', async () => {
  let policies = [definition()]
  const h = await scheduledHarness({ definitions: () => policies })
  try {
    const owner = await h.person('owner@example.test', 'owner', { sessionDaysAgo: 0 })
    const member = await h.person('member@example.test', 'member', { sessionDaysAgo: 120 })
    const approval = await h.approveAs(owner.cookie)
    policies = [definition({ actions: [{ action: 'operators:deactivate', scope: { roles: ['member'], inactiveDays: 30 } }] })]
    assert.equal((await h.runWith(run => run.execute('operators:deactivate', member.id))).error, 'policy_changed')
    policies = [definition()]
    assert.equal((await h.runWith(run => run.execute('operators:deactivate', member.id))).error, 'policy_revoked')
    assert.equal(await h.status(member.id), 'active')
    const listing = await h.json(await h.call('/auth/policies', { cookie: owner.cookie }))
    assert.equal(listing.approvals.find(row => row.id === approval.id).revokeReason, 'superseded_by_change')
    await h.approveAs(owner.cookie)
    assert.equal((await h.runWith(run => run.execute('operators:deactivate', member.id))).status, 'completed')
    assert.equal(await h.status(member.id), 'inactive')
  } finally { await h.close() }
})

test('owner run history exposes committed and refused target evidence across pages and denies nonowners', async () => {
  const h = await scheduledHarness()
  try {
    const owner = await h.person('owner@example.test', 'owner', { sessionDaysAgo: 0 })
    const admin = await h.person('admin@example.test', 'admin', { sessionDaysAgo: 0 })
    const member = await h.person('member@example.test', 'member', { sessionDaysAgo: 0 })
    const dormant = await h.person('dormant@example.test', 'member', { sessionDaysAgo: 120 })
    const recent = await h.person('recent@example.test', 'member', { sessionDaysAgo: 1 })
    const approval = await h.approveAs(owner.cookie)
    const partial = await h.runWith(async run => {
      await run.execute('operators:deactivate', dormant.id)
      await run.execute('operators:deactivate', recent.id)
    })
    const visible = (await h.history(owner.cookie)).runs[0]
    assert.equal(visible.id, partial.id)
    assert.equal(visible.status, 'refused')
    assert.deepEqual(visible.actions.map(action => action.action), ['operators:deactivate', 'policy:refused'])
    const provenance = { policyId: 'inactive-members', versionHash: approval.versionHash, approvalId: approval.id, approvedBy: owner.id, runId: partial.id }
    assert.equal(visible.actions[0].actor, `policy:inactive-members@${approval.versionHash}`)
    assert.deepEqual(visible.actions[0].value, { ...provenance, operatorId: dormant.id })
    assert.deepEqual(visible.actions[1].value, { ...provenance, operatorId: recent.id, attemptedAction: 'operators:deactivate', error: 'authority_changed' })
    for (let i = 0; i < 25; i++) { h.advance(10 * 60000 + 1); assert.equal((await h.runWith(async () => {})).status, 'completed') }
    const first = await h.history(owner.cookie)
    assert.equal(first.runs.length, 25)
    assert.ok(first.nextCursor)
    const second = await h.history(owner.cookie, `?before=${first.nextCursor}`)
    assert.deepEqual(second.runs.map(run => run.id), [partial.id])
    assert.equal(second.nextCursor, null)
    assert.equal(new Set([...first.runs, ...second.runs].map(run => run.id)).size, 26)
    assert.deepEqual(second.runs[0].actions, visible.actions)
    for (const cookie of [admin.cookie, member.cookie]) await refused(await h.call('/auth/policy-runs', { cookie }), 'forbidden')
    await refused(await h.call('/auth/policy-runs'), 'unauthenticated', 401)
  } finally { await h.close() }
})

test('action volume and run interval are independently bounded while identical unadmitted ticks coalesce', async () => {
  const policy = definition({ maxActionsPerRun: 2 })
  const h = await scheduledHarness({ definitions: () => [policy] })
  try {
    const owner = await h.person('owner@example.test', 'owner', { sessionDaysAgo: 0 })
    const members = []
    for (let i = 0; i < 3; i++) members.push(await h.person(`member${i}@example.test`, 'member', { sessionDaysAgo: 120 }))
    let callbacks = 0
    const runNothing = () => h.runWith(async () => { callbacks++ })
    const unapprovedAt = h.clock()
    for (let i = 0; i < 3; i++) { assert.equal((await runNothing()).error, 'policy_approval_required'); h.advance(1) }
    const missing = await h.history(owner.cookie)
    assert.equal(callbacks, 0)
    assert.equal(missing.runs.length, 1)
    assert.equal(missing.runs[0].repeats, 3)
    assert.equal(missing.runs[0].startedAt, unapprovedAt)
    assert.equal(missing.runs[0].lastSeenAt, h.clock() - 1)
    await h.approveAs(owner.cookie)
    const capped = await h.runWith(async run => { for (const member of members) await run.execute('operators:deactivate', member.id) })
    assert.deepEqual([capped.status, capped.error], ['refused', 'policy_action_limit'])
    assert.deepEqual(await Promise.all(members.map(member => h.status(member.id))), ['inactive', 'inactive', 'active'])
    const cappedEvidence = (await h.history(owner.cookie)).runs.find(run => run.id === capped.id)
    assert.deepEqual(cappedEvidence.actions.map(action => action.action), ['operators:deactivate', 'operators:deactivate', 'policy:refused'])
    for (let i = 0; i < 3; i++) { h.advance(1); assert.equal((await runNothing()).error, 'policy_interval') }
    assert.equal(callbacks, 0)
    const interval = (await h.history(owner.cookie)).runs[0]
    assert.equal(interval.error, 'policy_interval')
    assert.equal(interval.repeats, 3)
    assert.equal(interval.lastSeenAt, h.clock())
    assert.deepEqual(interval.actions, [])
    h.advance(policy.minIntervalMinutes * 60000 + 1)
    assert.equal((await h.runWith(run => run.execute('operators:deactivate', members[2].id))).status, 'completed')
    assert.equal(await h.status(members[2].id), 'inactive')
  } finally { await h.close() }
})

test('inactivity refusals survive provider-session scrubbing after the next interval is admitted', async () => {
  const h = await scheduledHarness()
  try {
    const owner = await h.person('owner@example.test', 'owner', { sessionDaysAgo: 0 })
    const member = await h.person('sso@example.test', 'member', { sessionDaysAgo: 3, sessionKind: 'oidc' })
    await h.approveAs(owner.cookie)
    const before = await h.runWith(run => run.execute('operators:deactivate', member.id))
    assert.deepEqual([before.admitted, before.error], [1, 'authority_changed'])
    // Portability removes these transient credential rows. Admission history
    // must survive that filtering rather than turn a recent member dormant.
    await h.db.prepare("DELETE FROM oa_sessions WHERE kind='oidc'").run()
    h.advance(definition().minIntervalMinutes * 60000 + 1)
    const after = await h.runWith(run => run.execute('operators:deactivate', member.id))
    assert.deepEqual([after.admitted, after.status, after.error], [1, 'refused', 'authority_changed'])
    assert.equal(await h.status(member.id), 'active')
  } finally { await h.close() }
})
