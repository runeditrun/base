import test from 'node:test'
import assert from 'node:assert/strict'
import { runtime } from './runtime.mjs'
import { autonomousPolicy } from '../conformance/crypto.mjs'

const code = (reply: any) => reply.result?._meta?.['com.runeditrun/error']?.code ?? reply.error?.data?.code
const requestState = (reply: any) => reply.result.requestState
const approvalOf = (reply: any) => reply.result._meta['com.runeditrun/approval']

for (const required of [false, true]) test(`approved aggregate read replay rechecks the native client grant (${required ? 'refusal' : 'empty'})`, async t => {
  const r = await runtime({ aggregateRead: true })
  try {
    const clientId = 'service:aggregate', token = await r.token({ client_id: clientId })
    const grant = async (granted: boolean) => assert.equal((await r.person('/__client-grant', { clientId, granted })).status, 200)
    const read = (state?: string) => r.mcp('tools/call', { name: 'synthetic.context.read', arguments: { required }, ...(state ? { requestState: state } : {}) }, { token })
    const approve = async (pending: any) => {
      const id = approvalOf(pending).id, view = (await r.person(`/agents/api/approvals/${id}`)).body.approval
      assert.equal((await r.person(`/agents/api/approvals/${id}/approve`, { revision: view.revision, summary_sha256: view.summary_sha256 })).body.approval.state, 'executed')
    }
    await grant(true)
    for (const id of ['one', 'two', 'three']) await r.db.prepare('INSERT INTO test_records VALUES(?,?,1,?)').bind(id, id, clientId).run()
    await r.db.prepare('INSERT INTO test_records VALUES(?,?,1,?)').bind('neighbor', 'private', 'service:neighbor').run()
    const policy = autonomousPolicy(); policy.rules = [{ id: 'all', class: '*', do: 'approval', approver: ['sponsor'], wait: 'PT1H' }]
    assert.equal((await r.adopt(policy)).status, 200)
    const pending = await read(), state = requestState(pending)
    assert.equal(pending.result.resultType, 'input_required')
    assert.equal(requestState(await read(state)), state)
    await approve(pending)
    const first = await read(state)
    assert.equal(first.result.structuredContent.records.length, 3)
    const records = (await r.db.prepare('SELECT * FROM test_records ORDER BY id').all()).results
    assert.deepEqual((await read(state)).result.structuredContent, first.result.structuredContent)
    const receipt = first.result._meta['com.runeditrun/receipt']
    assert.deepEqual((await read(state)).result._meta['com.runeditrun/receipt'], receipt)
    await grant(false)
    // A newly approved fresh read is the native refusal/visibility oracle under the same policy.
    const freshPending = await read(), freshId = approvalOf(freshPending).id
    const view = (await r.person(`/agents/api/approvals/${freshId}`)).body.approval
    const freshApproval = (await r.person(`/agents/api/approvals/${freshId}/approve`, { revision: view.revision, summary_sha256: view.summary_sha256 })).body.approval
    assert.equal(freshApproval.state, required ? 'refused' : 'executed')
    const fresh = await read(requestState(freshPending)), replay = await read(state)
    t.diagnostic(`grant removed: fresh=${JSON.stringify(fresh.result?.structuredContent ?? code(fresh))}; replay=${JSON.stringify(replay.result?.structuredContent ?? code(replay))}`)
    assert.deepEqual(replay.result?.structuredContent, fresh.result?.structuredContent)
    assert.equal(code(replay), code(fresh))
    if (required) {
      assert.equal(code(replay), 'native_client_revoked')
      assert.equal(replay.result?.structuredContent, undefined)
      const audit = (await r.person('/agents/api/audit')).body.rows.at(-1)
      assert.equal(audit.outcome, 'refused'); assert.equal(audit.code, 'native_client_revoked')
    } else assert.deepEqual(replay.result.structuredContent, { records: [] })
    // The original approval is a durable receipt, never a replacement for current visibility.
    await grant(true)
    assert.deepEqual((await read(state)).result.structuredContent, first.result.structuredContent)
    assert.equal((await r.person(`/agents/api/approvals/${approvalOf(pending).id}`)).body.approval.state, 'executed')
    assert.deepEqual((await r.db.prepare('SELECT * FROM test_records ORDER BY id').all()).results, records)
    assert.equal((await r.person('/agents/api/audit')).body.differs_from_policy, 0)
  } finally { await r.close() }
})

for (const [version, method] of [
  ['2025-11-25', 'tools/call'], ['2026-07-28', 'tools/call'], ['2025-11-25', 'resources/read'],
]) test(`held read resumes its original operation after native approval (${version} ${method})`, async t => {
  const r = await runtime()
  try {
    const record = { id: 'held-read', value: 'protected', version: 1, exposure: 'internal' }
    await r.db.prepare('INSERT INTO test_records VALUES(?,?,?,?)').bind(...Object.values(record)).run()
    const records = (await r.db.prepare('SELECT * FROM test_records ORDER BY id').all()).results
    const read = (state?: string) => r.mcp(method, {
      ...(method === 'tools/call' ? { name: 'synthetic.records.list', arguments: {} } : { uri: 'synthetic://record/held-read' }),
      ...(state ? { requestState: state } : {}),
    }, { version })
    const dataOf = (reply: any) => method === 'tools/call' ? reply.result : reply.error.data
    const contentOf = (reply: any) => method === 'tools/call' ? reply.result.structuredContent : JSON.parse(reply.result.contents[0].text)
    const expected = method === 'tools/call' ? { records, sent: [] } : record
    const counts = async () => Object.fromEntries(await Promise.all(
      ['agent_door_approvals', 'agent_door_calls', 'test_jobs', 'test_effects', 'test_sent'].map(async table =>
        [table, (await r.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n]),
    ))
    assert.equal((await r.adopt()).status, 200)
    const immediate = await read()
    assert.equal(immediate.status, 200)
    assert.deepEqual(contentOf(immediate), expected)
    assert.equal(immediate.result.requestState, undefined)
    if (method === 'tools/call') assert.equal(immediate.result.isError, false)
    const before = await counts()
    const policy = autonomousPolicy()
    policy.rules = [{ id: 'all', class: '*', do: 'approval', approver: ['sponsor'], wait: 'PT1H' }]
    assert.equal((await r.adopt(policy)).status, 200)
    const held = await read(), data = dataOf(held), state = data.requestState
    assert.equal(held.status, 200)
    assert.equal(typeof state, 'string')
    const approval = data.approval ?? data._meta['com.runeditrun/approval'] ?? data._meta['com.runeditrun/error'].approval
    const saved = JSON.parse((await r.db.prepare('SELECT saved FROM agent_door_approvals WHERE id=?').bind(approval.id).first()).saved)
    assert.equal(state, saved.result.requestState)
    if (method === 'tools/call') {
      assert.equal(held.result.resultType, version === '2026-07-28' ? 'input_required' : 'complete')
      assert.equal(held.result.structuredContent, undefined)
      if (version === '2025-11-25') {
        assert.equal(held.result.isError, true)
        assert.equal(code(held), 'approval_required')
        assert.deepEqual(held.result.content, [{ type: 'text', text: '{"code":"approval_required"}' }])
      }
    } else {
      assert.equal(held.error.data.code, 'approval_required')
      assert.equal(held.result, undefined)
    }
    // A retry before approval must remain held and disclose no native payload.
    const unapproved = await read(state)
    assert.equal(dataOf(unapproved).requestState, state)
    assert.equal(unapproved.result?.structuredContent, undefined)
    assert.equal(unapproved.result?.contents, undefined)
    const view = (await r.person(`/agents/api/approvals/${approval.id}`)).body.approval
    const approved = await r.person(`/agents/api/approvals/${approval.id}/approve`, { revision: view.revision, summary_sha256: view.summary_sha256 })
    assert.equal(approved.status, 200)
    assert.equal(approved.body.approval.state, 'executed')
    assert.equal(approved.body.approval.approvals.length, 1)
    const complete = await read(state)
    assert.equal(complete.status, 200)
    assert.equal(complete.result.resultType, 'complete')
    assert.deepEqual(contentOf(complete), expected)
    assert.deepEqual(contentOf(await read(state)), expected)
    if (method === 'resources/read') assert.equal(complete.result.contents[0]._meta['com.runeditrun/untrusted'], true)
    else assert.equal(complete.result.isError, false)
    const audit = (await r.person('/agents/api/audit')).body
    const operation = saved.principal.operationId
    const continuationRows = audit.rows.filter((row: any) => row.id === saved.decision_id || row.decision_id === saved.decision_id || row.replay_of === saved.decision_id)
    assert.ok(continuationRows.length >= 3)
    assert.ok(continuationRows.every((row: any) => row.operation_id === operation))
    assert.equal(audit.rows.at(-1).operation_id, operation)
    assert.equal(audit.differs_from_policy, 0)
    const after = await counts()
    assert.deepEqual(after, { ...before, agent_door_approvals: before.agent_door_approvals + 1 })
    assert.deepEqual((await r.db.prepare('SELECT * FROM test_records ORDER BY id').all()).results, records)
    t.diagnostic(JSON.stringify({ version, method, operation, resumedOperation: audit.rows.at(-1).operation_id, generatedStateMatches: state === saved.result.requestState, before, after, approvals: approved.body.approval.approvals.length }))
    // A previously approved continuation cannot override a current policy refusal.
    assert.equal((await r.adopt({ ...autonomousPolicy(), rules: [{ id: 'blocked', class: '*', do: 'blocked' }] })).status, 200)
    for (const blocked of [await read(state), await read()]) {
      assert.equal(code(blocked) ?? blocked.error?.data?.code, 'policy_blocked')
      assert.equal(blocked.result?.structuredContent, undefined)
      assert.equal(blocked.result?.contents, undefined)
      assert.equal(blocked.result?.requestState, undefined)
      if (method === 'tools/call') {
        assert.equal(blocked.result.isError, true)
        assert.equal(JSON.stringify(blocked.result.content).includes(record.value), false)
      }
    }
    assert.deepEqual(await counts(), after)
    assert.equal((await r.person('/agents/api/audit')).body.differs_from_policy, 0)
  } finally { await r.close() }
})

test('approved mutation replay retains one native effect and the recorded outcome', async () => {
  const r = await runtime()
  try {
    const policy = autonomousPolicy(); policy.rules = [{ id: 'all', class: '*', do: 'approval', approver: ['sponsor'], wait: 'PT1H' }]
    await r.adopt(policy)
    const args = { id: 'once', value: 'approved', idempotency_key: crypto.randomUUID() }
    const pending = await r.tool('records.write', args), id = approvalOf(pending).id
    const view = (await r.person(`/agents/api/approvals/${id}`)).body.approval
    assert.equal((await r.person(`/agents/api/approvals/${id}/approve`, { revision: view.revision, summary_sha256: view.summary_sha256 })).body.approval.state, 'executed')
    const first = await r.tool('records.write', args)
    assert.deepEqual((await r.tool('records.write', args)).result.structuredContent, first.result.structuredContent)
    assert.equal((await r.db.prepare('SELECT version FROM test_records WHERE id=?').bind(args.id).first()).version, 1)
    assert.equal((await r.db.prepare("SELECT COUNT(*) AS n FROM test_contexts WHERE kind='run'").first()).n, 1)
    await r.person('/agents/api/pause', { paused: true })
    assert.equal(code(await r.tool('records.write', args)), 'agents_paused')
    assert.equal((await r.db.prepare('SELECT version FROM test_records WHERE id=?').bind(args.id).first()).version, 1)
  } finally { await r.close() }
})
