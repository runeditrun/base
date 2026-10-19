import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scheduledHarness, definition } from './scheduled-harness.mjs'

test('scheduled approval hashes and executes the same validated getter snapshot; unknown actions refuse', async () => {
  let getters = false
  const definitions = () => {
    let reads = 0
    return [definition({ actions: [{
      get action() { return !getters || ++reads === 1 ? 'operators:deactivate' : 'operators:role' },
      scope: { roles: ['member'], inactiveDays: 90 },
    }] })]
  }
  const h = await scheduledHarness({ definitions })
  try {
    const owner = await h.person('owner@example.test', 'owner', { sessionDaysAgo: 0 })
    const member = await h.person('dormant@example.test', 'member', { sessionDaysAgo: 120 })
    const list = async () => (await h.json(await h.call('/auth/policies', { cookie: owner.cookie }))).policies[0]
    const expected = await list()
    getters = true
    const snapshot = await list()
    assert.deepEqual(snapshot.definition, expected.definition)
    assert.equal(snapshot.versionHash, expected.versionHash)
    await h.json(await h.post('/auth/policy/approve', { policyId: expected.definition.id, versionHash: expected.versionHash }, owner.cookie))
    const completed = await h.runWith(run => run.execute('operators:deactivate', member.id))
    assert.equal(completed.status, 'completed')
    assert.equal(await h.status(member.id), 'inactive')
    h.advance(11 * 60000)
    const refused = await h.runWith(run => run.execute('operators:role', member.id))
    assert.deepEqual([refused.status, refused.error], ['refused', 'policy_action_denied'])
    assert.equal(await h.status(member.id), 'inactive')
    const visible = (await h.history(owner.cookie)).runs.find(run => run.id === refused.id)
    assert.equal(visible.actions[0].value.attemptedAction, 'operators:role')
  } finally { await h.close() }
})

test('the scheduled action cap includes every audit action linked to the run', async () => {
  const h = await scheduledHarness({ definitions: () => [definition({ maxActionsPerRun: 1 })] })
  try {
    const owner = await h.person('owner@example.test', 'owner', { sessionDaysAgo: 0 })
    const member = await h.person('dormant@example.test', 'member', { sessionDaysAgo: 120 })
    await h.approveAs(owner.cookie)
    const refused = await h.runWith(async run => {
      // Model an already durable policy action outside today's two status actions.
      await h.db.prepare('INSERT INTO oa_auth_audit(id,actor_id,action,value,created_at) VALUES(?,?,?,?,?)')
        .bind(crypto.randomUUID(), run.actor, 'operators:role', JSON.stringify({ runId: run.id, operatorId: member.id }), h.clock()).run()
      await run.execute('operators:deactivate', member.id)
    })
    assert.equal(refused.status, 'refused')
    assert.equal(await h.status(member.id), 'active')
    assert.equal((await h.history(owner.cookie)).runs[0].actions.length, 2)
  } finally { await h.close() }
})

test('a live admitted scheduled run blocks overlap; a crash beyond the handler limit expires with owner-readable audit', async () => {
  const h = await scheduledHarness()
  try {
    const owner = await h.person('owner@example.test', 'owner', { sessionDaysAgo: 0 })
    const member = await h.person('dormant@example.test', 'member', { sessionDaysAgo: 120 })
    const approval = await h.approveAs(owner.cookie)
    let release, enter, capability
    const held = new Promise(resolve => { release = resolve })
    const entered = new Promise(resolve => { enter = resolve })
    const running = h.auth.scheduledPolicies.run('inactive-members', async run => { capability = run; enter(); await held })
    await entered
    try {
      const original = await h.lastRun()
      assert.deepEqual([original.status, original.admitted], ['running', 1])
      h.advance(14 * 60000)
      let invoked = false
      assert.equal((await h.runWith(async () => { invoked = true })).error, 'policy_interval')
      assert.equal(invoked, false)
      assert.equal((await h.history(owner.cookie)).runs.find(run => run.id === original.id).status, 'running')
      h.advance(60000 + 1)
      const recovered = await h.runWith(run => run.execute('operators:deactivate', member.id))
      assert.equal(recovered.status, 'completed')
      assert.equal(await h.status(member.id), 'inactive')
      const expired = (await h.history(owner.cookie)).runs.find(run => run.id === original.id)
      assert.deepEqual([expired.status, expired.error, expired.finishedAt], ['failed', 'policy_expired', h.clock()])
      const audit = expired.actions.find(action => action.action === 'policy:expired')
      assert.equal(audit.actor, `policy:inactive-members@${approval.versionHash}`)
      assert.deepEqual(audit.value, { policyId: 'inactive-members', versionHash: approval.versionHash,
        approvalId: approval.id, approvedBy: owner.id, runId: original.id, error: 'policy_expired' })
      assert.notEqual(await h.code(capability.execute('operators:deactivate', member.id)), 'ok')
    } finally { release(); await h.code(running) }
    // A late continuation cannot overwrite the recorded expiry.
    const history = await h.history(owner.cookie)
    assert.equal(history.runs.find(run => run.id === capability.id).error, 'policy_expired')
    assert.equal((await h.runWith(async () => {})).error, 'policy_interval')
  } finally { await h.close() }
})
