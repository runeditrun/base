import { runRows } from '../rows.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { emittedRuntime, setupToken, owner } from './emitted-runtime.mjs'
import { scheduledHarness, definition } from './scheduled-harness.mjs'

const policyRows = []

const cookieOf = response => { assert.equal(response.status, 303); return response.headers.get('set-cookie').split(';')[0] }

policyRows.push(['scheduled approval refuses a definition whose snapshotted id differs from the requested policy', {}, async () => {
  let changingId = false
  const h = await scheduledHarness({ definitions: () => {
    if (!changingId) return [definition({ id: 'other-policy' })]
    let reads = 0
    return [{
      ...definition(),
      // Selection sees the requested id; canonicalization sees another policy.
      get id() { return ++reads <= 2 ? 'inactive-members' : 'other-policy' },
    }]
  } })
  try {
    const owner = await h.person('owner@example.test', 'owner', { sessionDaysAgo: 0 })
    const listing = await h.json(await h.call('/auth/policies', { cookie: owner.cookie }))
    changingId = true
    const response = await h.post('/auth/policy/approve', {
      policyId: 'inactive-members', versionHash: listing.policies[0].versionHash,
    }, owner.cookie)
    assert.equal(response.status, 503, await response.clone().text())
    assert.equal((await response.json()).error, 'invalid_policy')
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM oa_policy_approvals').first()).count, 0)
    let entered = false
    const run = await h.runWith(async () => { entered = true })
    assert.deepEqual([run.status, run.error], ['refused', 'invalid_policy'])
    assert.equal(entered, false)
  } finally { await h.close() }
}])

policyRows.push(['scheduled Worker door: exact owner approval bounds actions, audits runs, and stops on edits, revocation or owner demotion', {}, async () => {
  const r = await emittedRuntime()
  const post = (path, input, cookie, headers) => r.call(path, { method: 'POST', input, cookie, headers })
  const confirm = async () => cookieOf(await post('/auth/confirm', { token: new URL(r.mails.at(-1).text.match(/https?:\/\/[^\s]+/)[0]).searchParams.get('token') }))
  const session = cookie => r.call('/auth/session', { cookie }).then(response => response.json())
  const list = cookie => r.call('/auth/policies', { cookie }).then(response => response.json())
  const lastRun = async () => (await r.db.prepare('SELECT * FROM oa_policy_runs ORDER BY rowid DESC LIMIT 1').first())
  let attempts = 0
  const tick = async () => {
    // These are separate cron intervals; refusal cases test immediate replay.
    await r.db.prepare('UPDATE oa_policy_runs SET finished_at=? WHERE admitted=1 AND finished_at IS NOT NULL').bind(Date.now()-11*60000).run()
    attempts++; await (await r.mf.getWorker()).scheduled({ cron: '*/10 * * * *' }); return lastRun() }
  try {
    let ownerCookie = cookieOf(await post('/auth/bootstrap', { token: setupToken, displayName: 'Rivera Lee' }))
    await post('/auth/magic-link', { email: owner }); ownerCookie = await confirm()
    const approvingOwner = (await session(ownerCookie)).operator
    const join = async (email, role) => {
      assert.equal((await post('/auth/invite', { email, displayName: email.split('@')[0], role }, ownerCookie)).status, 202)
      const cookie = await confirm()
      return { cookie, operator: (await session(cookie)).operator }
    }
    const member = await join('dormant-member@example.test', 'member')
    const recent = await join('recent-member@example.test', 'member')
    const coowner = await join('coowner@example.test', 'owner')
    const aged = Date.now() - 180 * 86400000
    await r.db.prepare('UPDATE oa_operators SET created_at=? WHERE id=?').bind(aged, member.operator.id).run()
    await r.db.prepare('UPDATE oa_sessions SET created_at=? WHERE operator_id=?').bind(aged, member.operator.id).run()
    await r.db.prepare('UPDATE oa_operators SET last_signin_at=? WHERE id=?').bind(aged, member.operator.id).run()
    const status = async id => (await r.db.prepare('SELECT status FROM oa_operators WHERE id=?').bind(id).first()).status
    assert.equal((await tick()).error, 'policy_approval_required')
    let policy = (await list(ownerCookie)).policies[0]
    const approve = async () => {
      policy = (await list(ownerCookie)).policies[0]
      const response = await post('/auth/policy/approve', { policyId: policy.definition.id, versionHash: policy.versionHash }, ownerCookie)
      assert.equal(response.status, 200, await response.clone().text())
      return response.json()
    }
    assert.equal((await post('/auth/policy/approve', { policyId: policy.definition.id, versionHash: policy.versionHash }, member.cookie)).status, 403)
    assert.equal((await r.call('/auth/policy-runs', { cookie: member.cookie })).status, 403)
    assert.equal((await post('/auth/policy/approve', { policyId: policy.definition.id, versionHash: policy.versionHash }, ownerCookie, { origin: 'https://attacker.test' })).status, 403)
    assert.equal((await post('/auth/policy/approve', { policyId: policy.definition.id, versionHash: 'stale-version' }, ownerCookie)).status, 409)
    let approval = await approve()
    assert.equal((await list(ownerCookie)).policies[0].state, 'approved')
    const completed = await tick()
    assert.equal(completed.status, 'completed')
    assert.equal(await status(member.operator.id), 'inactive')
    assert.equal(await status(recent.operator.id), 'active')
    assert.equal((await r.call('/auth/session', { cookie: member.cookie })).status, 401)
    const audit = await r.db.prepare("SELECT * FROM oa_auth_audit WHERE action='operators:deactivate'").first()
    assert.equal(audit.actor_id, `policy:${policy.definition.id}@${policy.versionHash}`)
    assert.deepEqual(JSON.parse(audit.value), { policyId: policy.definition.id, versionHash: policy.versionHash, approvalId: approval.id, approvedBy: approvingOwner.id, runId: completed.id, operatorId: member.operator.id })
    // Human administration keeps its original session door and revocation rules.
    assert.equal((await post('/auth/operator/status', { operatorId: member.operator.id, status: 'active' }, ownerCookie)).status, 200)
    assert.equal((await post('/auth/operator/status', { operatorId: member.operator.id, status: 'inactive' })).status, 401)
    const oldHash = policy.versionHash
    await r.redeploy(source => source.replaceAll('inactiveDays: 90', 'inactiveDays: 120'))
    assert.equal((await tick()).error, 'policy_changed')
    assert.equal((await list(ownerCookie)).policies[0].state, 'policy_revoked')
    assert.equal(await status(member.operator.id), 'active')
    assert.equal((await post('/auth/policy/approve', { policyId: policy.definition.id, versionHash: oldHash }, ownerCookie)).status, 409)
    approval = await approve()
    assert.notEqual(policy.versionHash, oldHash)
    assert.equal((await tick()).status, 'completed')
    assert.equal(await status(member.operator.id), 'inactive')
    assert.equal((await post('/auth/policy/revoke', { approvalId: approval.id }, ownerCookie)).status, 200)
    assert.equal((await tick()).error, 'policy_revoked')
    assert.equal((await list(ownerCookie)).policies[0].state, 'policy_revoked')
    assert.equal((await post('/auth/operator/status', { operatorId: member.operator.id, status: 'active' }, ownerCookie)).status, 200)
    await r.redeploy()
    approval = await approve()
    await r.redeploy((source, path) => path.includes('scheduled.server-') ? source.replace('run.execute("operators:deactivate"', 'run.execute("operators:reactivate"') : source)
    assert.equal((await tick()).error, 'policy_action_denied')
    assert.equal(await status(member.operator.id), 'active')
    // A buggy selector cannot act outside the declared inactivity/role/id scope.
    await r.redeploy((source, path) => path.includes('scheduled.server-') ? source.replace('candidate.id)', `${JSON.stringify(recent.operator.id)})`) : source)
    assert.equal((await tick()).error, 'authority_changed')
    assert.equal(await status(recent.operator.id), 'active')
    await r.redeploy((source, path) => path.includes('scheduled.server-') ? source.replace('candidate.id)', `${JSON.stringify(approvingOwner.id)})`) : source)
    assert.equal((await tick()).error, 'authority_changed')
    assert.equal(await status(approvingOwner.id), 'active')
    await r.redeploy()
    // An audit failure must roll the authority change back, then log the run.
    await r.db.prepare("CREATE TRIGGER reject_policy_audit BEFORE INSERT ON oa_auth_audit WHEN NEW.action='operators:deactivate' BEGIN SELECT RAISE(ABORT,'test_audit_failure'); END").run()
    assert.equal((await tick()).status, 'failed')
    assert.equal((await lastRun()).error, 'policy_failed')
    assert.equal(await status(member.operator.id), 'active')
    await r.db.exec('DROP TRIGGER reject_policy_audit')
    // Revocation after run admission also stops its next action.
    await r.redeploy((source, path) => path.includes('scheduled.server-') ? source.replace('const days =', `await bindings.DB.prepare("UPDATE oa_policy_approvals SET revoked_at=? WHERE id=?").bind(Date.now(), ${JSON.stringify(approval.id)}).run(); const days =`) : source)
    assert.equal((await tick()).error, 'policy_revoked')
    assert.equal(await status(member.operator.id), 'active')
    await r.redeploy()
    await approve()
    assert.equal((await post('/auth/operator/role', { operatorId: approvingOwner.id, role: 'admin' }, coowner.cookie)).status, 200)
    assert.equal((await tick()).error, 'policy_owner_changed')
    assert.equal(await status(member.operator.id), 'active')
    const runs = await r.call('/auth/policy-runs', { cookie: coowner.cookie }).then(response => response.json())
    assert.equal(runs.runs.length, attempts)
    assert.ok(runs.runs.every(run => run.finishedAt !== null && run.id))
    assert.ok((await list(coowner.cookie)).approvals.length >= 3)
  } finally { await r.close() }
}])

test("scheduled owner approval binds the exact definition and controls Worker actions", async t => {
  await runRows(t, policyRows)
})
