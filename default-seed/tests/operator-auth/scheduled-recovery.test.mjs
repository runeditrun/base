import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scheduledHarness, definition } from './scheduled-harness.mjs'
import { emittedRuntime, setupToken } from './emitted-runtime.mjs'
import { AuthError } from '../../../modules/operator-auth/errors.mjs'

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


test('refused and expired audit events leave the scheduled action budget available', async () => {
  const h = await scheduledHarness({ definitions: () => [definition({ maxActionsPerRun: 1 })] })
  try {
    const owner = await h.person('owner@example.test', 'owner', { sessionDaysAgo: 0 })
    const recent = await h.person('recent@example.test', 'member', { sessionDaysAgo: 1 })
    const dormant = await h.person('dormant@example.test', 'member', { sessionDaysAgo: 120 })
    await h.approveAs(owner.cookie)
    const result = await h.runWith(async run => {
      assert.equal(await h.code(run.execute('operators:deactivate', recent.id)), 'authority_changed')
      // Exercise both diagnostic event types in the durable SQL count.
      await h.db.prepare('INSERT INTO oa_auth_audit(id,actor_id,action,value,created_at) VALUES(?,?,?,?,?)')
        .bind(crypto.randomUUID(), run.actor, 'policy:expired', JSON.stringify({ runId: run.id }), h.clock()).run()
      assert.equal(await h.code(run.execute('operators:deactivate', dormant.id)), 'ok')
    })
    assert.deepEqual([result.status, result.error], ['refused', 'authority_changed'])
    assert.equal(await h.status(recent.id), 'active')
    assert.equal(await h.status(dormant.id), 'inactive')
    const visible = (await h.history(owner.cookie)).runs.find(run => run.id === result.id)
    assert.deepEqual(visible.actions.map(action => action.action), ['policy:refused', 'policy:expired', 'operators:deactivate'])
  } finally { await h.close() }
})

test('a callback cannot claim expiry or bypass the interval with a forged expiry code', async () => {
  const h = await scheduledHarness()
  try {
    const owner = await h.person('owner@example.test', 'owner', { sessionDaysAgo: 0 })
    await h.approveAs(owner.cookie)
    const forged = await h.runWith(async () => {
      h.advance(11 * 60000)
      throw new AuthError('policy_expired', 409)
    })
    assert.deepEqual([forged.status, forged.error], ['failed', 'policy_failed'])
    assert.deepEqual((await h.history(owner.cookie)).runs.find(run => run.id === forged.id).actions, [])
    // An older installation may already contain a forged result. Its error
    // string alone must not grant the start-based recovery interval either.
    await h.db.prepare('UPDATE oa_policy_runs SET error=? WHERE id=?').bind('policy_expired', forged.id).run()
    let invoked = false
    const early = await h.runWith(async () => { invoked = true })
    assert.equal(early.error, 'policy_interval')
    assert.equal(invoked, false)
    h.advance(definition().minIntervalMinutes * 60000 + 1)
    assert.equal((await h.runWith(async () => {})).status, 'completed')
  } finally { await h.close() }
})

test('owner history presents an expired scheduled run as expiry rather than a committed action', async () => {
  const r = await emittedRuntime()
  try {
    const claimed = await r.call('/auth/bootstrap', { method: 'POST', input: { token: setupToken, displayName: 'Rivera Lee' } })
    assert.equal(claimed.status, 303)
    await r.call('/auth/magic-link', { method: 'POST', input: { email: 'owner@example.test' } })
    const token = new URL(r.mails.at(-1).text.match(/https?:\/\/\S+/)[0]).searchParams.get('token')
    const confirmed = await r.call('/auth/confirm', { method: 'POST', input: { token } })
    assert.equal(confirmed.status, 303)
    const cookie = confirmed.headers.get('set-cookie').split(';')[0]
    const setup = await r.call('/setup', { method: 'POST', cookie, body: 'confirm=yes',
      headers: { 'content-type': 'application/x-www-form-urlencoded' } })
    assert.equal(setup.status, 303)
    const listing = await (await r.call('/auth/policies', { cookie })).json()
    const policy = listing.policies[0]
    const approved = await r.call('/auth/policy/approve', { method: 'POST', cookie,
      input: { policyId: policy.definition.id, versionHash: policy.versionHash } })
    assert.equal(approved.status, 200)
    const approval = await approved.json()
    const id = crypto.randomUUID()
    await r.db.prepare("INSERT INTO oa_policy_runs(id,policy_id,version_hash,approval_id,approved_by,started_at,status,admitted) VALUES(?,?,?,?,?,?,'running',1)")
      .bind(id, policy.definition.id, policy.versionHash, approval.id, approval.ownerId, Date.now() - 16 * 60000).run()
    await (await r.mf.getWorker()).scheduled({ cron: '*/10 * * * *' })
    const page = await r.call('/app/policies', { cookie })
    assert.equal(page.status, 200)
    const html = await page.text()
    const event = html.match(/<li><p>[^<]*<\/p><dl>(?:(?!<\/li>)[\s\S])*?<dd>policy:expired<\/dd>(?:(?!<\/li>)[\s\S])*?<\/li>/)?.[0]
    assert.ok(event, 'the original expiry audit must be visible')
    assert.match(event, /<p>[^<]*[Ee]xpired[^<]*<\/p>/)
    assert.doesNotMatch(event, /Committed action/)
    assert.match(event, /policy_expired/)
    assert.ok(event.includes(id), 'expiry keeps the original run id')
  } finally { await r.close() }
})

test('crashed unadmitted ticks expire atomically with their original ids even before approval', async () => {
  const h = await scheduledHarness()
  try {
    const owner = await h.person('owner@example.test', 'owner', { sessionDaysAgo: 0 })
    const id = crypto.randomUUID(), startedAt = h.clock()
    // A crash immediately after the runner inserts its row has no version or
    // approval metadata. It must still have a durable, attributable expiry.
    await h.db.prepare("INSERT INTO oa_policy_runs(id,policy_id,started_at,status) VALUES(?,?,?,'running')")
      .bind(id, 'inactive-members', startedAt).run()
    h.advance(16 * 60000)
    await h.db.prepare("CREATE TRIGGER interrupt_expiry BEFORE UPDATE OF status ON oa_policy_runs WHEN NEW.error='policy_expired' BEGIN SELECT RAISE(ABORT,'interrupted_expiry'); END").run()
    await assert.rejects(h.runWith(async () => {}), /interrupted_expiry/)
    assert.equal((await h.db.prepare('SELECT status FROM oa_policy_runs WHERE id=?').bind(id).first()).status, 'running')
    assert.equal((await h.db.prepare("SELECT COUNT(*) AS n FROM oa_auth_audit WHERE action='policy:expired'").first()).n, 0)
    await h.db.exec('DROP TRIGGER interrupt_expiry')
    assert.equal((await h.runWith(async () => assert.fail('unapproved callback'))).error, 'policy_approval_required')
    const expired = (await h.history(owner.cookie)).runs.find(run => run.id === id)
    assert.deepEqual([expired.status, expired.error, expired.startedAt, expired.finishedAt], ['failed', 'policy_expired', startedAt, h.clock()])
    assert.equal(expired.actions.length, 1)
    const audit = expired.actions[0]
    assert.equal(audit.action, 'policy:expired')
    assert.equal(audit.actor, 'policy:inactive-members')
    assert.deepEqual(audit.value, { policyId: 'inactive-members', versionHash: null, approvalId: null,
      approvedBy: null, runId: id, error: 'policy_expired' })
    // Repeated sweeps cannot duplicate the audit or erase the original row.
    await h.runWith(async () => {})
    const again = (await h.history(owner.cookie)).runs.find(run => run.id === id)
    assert.deepEqual(again, expired)
    await h.approveAs((await h.sessionFor(owner)).cookie)
    assert.equal((await h.runWith(async () => {})).status, 'completed')
  } finally { await h.close() }
})
