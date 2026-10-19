import { test } from 'node:test'
import assert from 'node:assert/strict'
import { emittedRuntime, setupToken } from './emitted-runtime.mjs'

test('cron failure isolation: a broken policy cannot strand a pending person erasure or later policies', async () => {
  const r = await emittedRuntime({ files: true })
  try {
    const claimed = await r.call('/auth/bootstrap', { method: 'POST', input: { token: setupToken, displayName: 'Rivera Lee' } })
    assert.equal(claimed.status, 303)
    const cookie = claimed.headers.get('set-cookie').split(';')[0]
    const created = await r.call('/api/people', { method: 'POST', input: { name: 'Morgan Chen', email: 'morgan@example.test' }, cookie })
    assert.equal(created.status, 201)
    const { id } = await created.json()
    // Interrupt the real erasure after its request is durable, as a failed or
    // lost continuation would. The next scheduled sweep must finish it.
    await r.db.prepare("CREATE TRIGGER interrupt_erasure BEFORE DELETE ON people BEGIN SELECT RAISE(ABORT,'interrupted_erasure'); END").run()
    const interrupted = await r.call(`/api/people/${id}/erasure`, { method: 'POST', input: { confirmation: `erase ${id}` }, cookie })
    assert.equal(interrupted.status, 503)
    assert.deepEqual(await interrupted.json(), { error: 'service_unavailable' })
    assert.ok(await r.db.prepare('SELECT 1 FROM person_erasure_redactions WHERE person_id=?').bind(id).first())
    await r.db.exec('DROP TRIGGER interrupt_erasure')
    // Two real declarations exercise the per-policy boundary too.
    await r.redeploy(source => source.replace(/(var policyDefinitions = \(\) => )(\[\{[\s\S]*?\}\]);/, '$1$2.concat($2.map(policy => ({...policy,id:"later-policy"})));'))
    await r.db.prepare("CREATE TRIGGER break_policy BEFORE INSERT ON oa_policy_runs WHEN NEW.policy_id='inactive-members' BEGIN SELECT RAISE(ABORT,'broken_policy_store'); END").run()
    const outcome = await (await r.mf.getWorker()).scheduled({ cron: '*/10 * * * *' })
    assert.equal(outcome.outcome, 'exception')
    assert.ok(await r.db.prepare("SELECT 1 FROM oa_policy_runs WHERE policy_id='later-policy' AND error='policy_approval_required'").first(), 'later policies still run')
    assert.equal(await r.db.prepare('SELECT 1 FROM people WHERE id=?').bind(id).first(), null, 'the pending erasure completes despite policy failure')
    assert.equal(await r.db.prepare('SELECT 1 FROM person_erasure_redactions WHERE person_id=?').bind(id).first(), null)
    const receipt = await r.db.prepare("SELECT phase FROM rer_erasure_operations WHERE phase='complete'").first()
    assert.ok(receipt)
  } finally { await r.close() }
})
