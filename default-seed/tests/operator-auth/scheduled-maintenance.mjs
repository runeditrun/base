import assert from 'node:assert/strict'
import { emittedRuntime, setupToken } from './emitted-runtime.mjs'

export const maintenanceRows = []


maintenanceRows.push(['cron failure isolation: a broken policy cannot strand a pending person erasure or later policies', {}, async () => {
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
    const state = {
      laterPolicyRan: Boolean(await r.db.prepare("SELECT 1 FROM oa_policy_runs WHERE policy_id='later-policy' AND error='policy_approval_required'").first()),
      personRemains: Boolean(await r.db.prepare('SELECT 1 FROM people WHERE id=?').bind(id).first()),
      pendingRequest: Boolean(await r.db.prepare('SELECT 1 FROM person_erasure_redactions WHERE person_id=?').bind(id).first()),
      erasureComplete: Boolean(await r.db.prepare("SELECT 1 FROM rer_erasure_operations WHERE phase='complete'").first()),
    }
    assert.deepEqual(state, { laterPolicyRan: true, personRemains: false, pendingRequest: false, erasureComplete: true })
  } finally { await r.close() }
}])

maintenanceRows.push(['erasure preview changes nothing, and an explicit resume finishes an interrupted erasure while an unrelated person is untouched', {}, async () => {
  const r = await emittedRuntime({ files: true })
  try {
    const claimed = await r.call('/auth/bootstrap', { method: 'POST', input: { token: setupToken, displayName: 'Rivera Lee' } })
    const cookie = claimed.headers.get('set-cookie').split(';')[0]
    const create = async (name, email) => (await (await r.call('/api/people', { method: 'POST', input: { name, email }, cookie })).json()).id
    const id = await create('Morgan Chen', 'morgan@example.test'), peer = await create('Peer Person', 'peer@example.test')
    assert.equal((await r.call(`/api/people/${id}/notes`, { method: 'POST', input: { body: 'About Morgan' }, cookie })).status, 201)
    const rows = async () => ({ people: (await r.db.prepare('SELECT count(*) AS n FROM people').first()).n, notes: (await r.db.prepare('SELECT count(*) AS n FROM person_notes').first()).n,
      operations: (await r.db.prepare('SELECT count(*) AS n FROM rer_erasure_operations').first()).n })
    const peerExport = await (await r.call(`/api/people/${peer}/export`, { cookie })).json()

    const before = await rows()
    const preview = await r.call(`/api/people/${id}/erasure`, { cookie })
    assert.equal(preview.status, 200)
    assert.deepEqual((await preview.json()).deleted, { people: 1, person_notes: 1 })
    assert.deepEqual(await rows(), before, 'a preview deletes nothing and opens no erasure')
    assert.equal((await r.call('/api/erasures/anything/resume', { method: 'POST', input: {} })).status, 401, 'resume needs a signed-in operator')

    await r.db.prepare("CREATE TRIGGER interrupt_erasure BEFORE DELETE ON people BEGIN SELECT RAISE(ABORT,'interrupted_erasure'); END").run()
    assert.equal((await r.call(`/api/people/${id}/erasure`, { method: 'POST', input: { confirmation: `erase ${id}` }, cookie })).status, 503)
    await r.db.exec('DROP TRIGGER interrupt_erasure')
    const { id: operation } = await r.db.prepare('SELECT id FROM rer_erasure_operations').first()
    assert.equal((await (await r.call(`/api/erasures/${operation}`, { cookie })).json()).receipt.phase, 'deleting')

    const resumed = await r.call(`/api/erasures/${operation}/resume`, { method: 'POST', input: {}, cookie })
    assert.equal(resumed.status, 200)
    const { receipt } = await resumed.json()
    assert.equal(receipt.phase, 'complete')
    assert.deepEqual(receipt.deleted, { people: 1, person_erasure_redactions: 1, person_notes: 1 })
    assert.equal((await r.call(`/api/people/${id}/export`, { cookie })).status, 404)
    assert.deepEqual(await (await r.call(`/api/people/${peer}/export`, { cookie })).json(), peerExport, 'the unrelated person is preserved exactly')
  } finally { await r.close() }
}])
