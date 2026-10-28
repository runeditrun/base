import test from 'node:test'
import assert from 'node:assert/strict'
import { runtime } from './runtime.mjs'
import { durableAdapter } from './durable-adapter.mjs'
import { autonomousPolicy } from '../conformance/crypto.mjs'

test('durable consent retains attribution and refuses work scheduled after signed revocation without an effect', async t => {
 const r = await runtime()
 try {
  await r.adopt()
  const consent = crypto.randomUUID(), token = await r.token({ consent }), adapter = durableAdapter({ origin: r.c.origin, cookie: r.c.person.cookie })
  const request = (path: string, init?: RequestInit) => r.fetch(path, init)
  const witness = async () => (await r.tool('records.list', {})).result.structuredContent
  const first = await adapter.queue({ request, token }), before = await witness()
  assert.deepEqual(before.records, [])
  const completed = await adapter.run({ request, handle: first })
  assert.equal(completed.outcome, 'done')
  const after = await witness()
  assert.equal(after.records.length, 1); assert.equal(after.records[0].version, 1)
  await r.adopt(autonomousPolicy(), { revoked: { agents: [], consents: [consent] } })
  const second = await adapter.queue({ request, token, previous: first })
  const refused = await adapter.run({ request, handle: second })
  assert.equal(refused.outcome, 'refused'); assert.equal(refused.code, 'consent_revoked')
  assert.deepEqual(await witness(), after)
  const audit = (await r.person('/agents/api/audit')).body
  assert.equal(audit.differs_from_policy, 0)
  const rows = audit.rows.filter((row: any) => row.consent === consent)
  assert.equal(rows.length, 3)
  const queue = rows.find((row: any) => row.door === 'mcp')
  for (const [answer, outcome, code] of [[completed, 'done', null], [refused, 'refused', 'consent_revoked']] as const) {
   const row = rows.find((row: any) => row.id === answer.decision.id)
   assert.equal(row.door, 'embedded'); assert.deepEqual(row.agent, queue.agent); assert.deepEqual(row.sponsor, queue.sponsor); assert.equal(row.label, queue.label)
   assert.equal(row.consent, consent); assert.equal(row.outcome, outcome); assert.equal(row.code, code)
   assert.equal(typeof row.idempotency_key, 'string'); assert.ok(row.idempotency_key.length)
   assert.ok(Number.isFinite(Date.parse(row.at))); assert.deepEqual(row.ignored_arguments, []); assert.equal(row.trace, null)
   assert.equal(row.revision, answer.decision.revision); assert.equal(row.decision, answer.decision.disposition)
   assert.deepEqual(row.classes, answer.decision.classes.map(({ class: cls, facts }: any) => ({ class: cls, facts })))
   assert.deepEqual(row.rules, answer.decision.classes.map(({ class: cls, rule, do: disposition }: any) => ({ class: cls, rule, do: disposition })))
  }
  t.diagnostic('Durable consent: one completed worker, one consent_revoked worker, one native record, two complete worker audit rows; rescheduled after signed revocation.')
 } finally { await r.close() }
})
