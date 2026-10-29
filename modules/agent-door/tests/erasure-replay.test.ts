import test from 'node:test'
import assert from 'node:assert/strict'
import { erasureFenceStatements as fence } from '../index.ts'
import { runtime } from './runtime.mjs'
import { autonomousPolicy } from '../conformance/crypto.mjs'

const code = (reply: any) => reply.result?._meta?.['com.runeditrun/error']?.code ?? reply.error?.data?.code

for (const approved of [false, true]) test(`${approved ? 'executed approval' : 'direct mutation'} replay is fenced atomically with native erasure`, async t => {
  const r = await runtime({ nativeTargets: true })
  try {
    const policy = autonomousPolicy()
    if (approved) policy.rules = [{ id: 'all', class: '*', do: 'approval', approver: ['sponsor'], wait: 'PT1H' }]
    await r.adopt(policy)
    const value = crypto.randomUUID(), args = { id: 'subject-a', value, idempotency_key: crypto.randomUUID() }
    let first = await r.tool('records.write', args)
    if (approved) {
      const id = first.result._meta['com.runeditrun/approval'].id
      const view = (await r.person(`/agents/api/approvals/${id}`)).body.approval
      assert.equal((await r.person(`/agents/api/approvals/${id}/approve`, { revision: view.revision, summary_sha256: view.summary_sha256 })).body.approval.state, 'executed')
      first = await r.tool('records.write', args)
    }
    assert.equal(first.result.structuredContent.value, value)
    const before = (await r.db.prepare('SELECT * FROM test_records').all()).results
    assert.deepEqual((await r.tool('records.write', args)).result.structuredContent, first.result.structuredContent)
    assert.deepEqual((await r.db.prepare('SELECT * FROM test_records').all()).results, before)
    const call = await r.db.prepare('SELECT decision_id FROM agent_door_calls WHERE key=?').bind(args.idempotency_key).first()
    // Exercise both independent mappings: the recorded native target and a result URI.
    const subject = approved ? { uris: [`synthetic://record/${args.id}`] } : { targets: [{ kind: 'record', id: `redacted:${args.id}` }] }
    await r.db.batch([...fence(r.db, subject), r.db.prepare('DELETE FROM test_records WHERE id=?').bind(args.id)])
    const after = await r.tool('records.write', args)
    t.diagnostic(`before=${JSON.stringify(first.result)}; after=${JSON.stringify(after.result ?? after.error)}`)
    assert.equal(code(after), 'target_erased')
    assert.equal(after.result?.structuredContent, undefined)
    assert.ok(!(after.result?.content ?? []).some((item: any) => item.type === 'resource_link'))
    assert.ok(!JSON.stringify(after).includes(value))
    for (const table of ['agent_door_calls', 'agent_door_approvals']) assert.ok(!JSON.stringify((await r.db.prepare(`SELECT * FROM ${table}`).all()).results).includes(value), `${table} retains no erased value`)
    const audit = (await r.person('/agents/api/audit')).body.rows.at(-1)
    assert.equal(audit.outcome, 'refused'); assert.equal(audit.code, 'target_erased'); assert.equal(audit.replay_of, call.decision_id)
    assert.equal((await r.db.prepare('SELECT COUNT(*) AS n FROM test_records').first()).n, 0)
    assert.equal((await r.db.prepare("SELECT COUNT(*) AS n FROM test_contexts WHERE kind='run'").first()).n, 1)

    // Admission retains precedence even when a matching tombstone exists.
    await r.db.prepare('INSERT INTO test_grants VALUES(?,?)').bind(r.c.agentId, JSON.stringify(['records:read'])).run()
    assert.equal(code(await r.tool('records.write', args)), 'insufficient_scope')
    await r.db.prepare('DELETE FROM test_grants').run()
    await r.db.prepare('UPDATE agent_door_agents SET revoked=1 WHERE id=?').bind(r.c.agentId).run()
    assert.equal(code(await r.tool('records.write', args)), 'unauthenticated')
    await r.db.prepare('UPDATE agent_door_agents SET revoked=0 WHERE id=?').bind(r.c.agentId).run()
    await r.adopt(policy, { revoked: { consents: [r.c.consent], agents: [] } })
    assert.equal(code(await r.tool('records.write', args)), 'unauthenticated')
  } finally { await r.close() }
})

test('fencing A preserves B byte for byte and an unfenced native deletion retains main behavior', async () => {
  const r = await runtime({ nativeTargets: true })
  try {
    await r.adopt()
    const a = { id: 'subject-a', value: crypto.randomUUID(), idempotency_key: crypto.randomUUID() }
    const b = { id: 'subject-b', value: crypto.randomUUID(), idempotency_key: crypto.randomUUID() }
    await r.tool('records.write', a)
    const first = await r.tool('records.write', b)
    const retained = await r.db.prepare('SELECT outcome FROM agent_door_calls WHERE key=?').bind(b.idempotency_key).first()
    await r.db.batch([...fence(r.db, { uris: [`synthetic://record/${a.id}`] }), r.db.prepare('DELETE FROM test_records WHERE id=?').bind(a.id)])
    assert.deepEqual(await r.db.prepare('SELECT outcome FROM agent_door_calls WHERE key=?').bind(b.idempotency_key).first(), retained)
    assert.equal(JSON.stringify((await r.tool('records.write', b)).result.structuredContent), JSON.stringify(first.result.structuredContent))
    await r.db.prepare('DELETE FROM test_records WHERE id=?').bind(b.id).run()
    assert.deepEqual((await r.tool('records.write', b)).result.structuredContent, first.result.structuredContent)
    assert.equal((await r.db.prepare('SELECT COUNT(*) AS n FROM test_records').first()).n, 0)
  } finally { await r.close() }
})
