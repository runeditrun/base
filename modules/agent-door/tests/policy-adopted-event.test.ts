import test from 'node:test'
import assert from 'node:assert/strict'
import { runtime } from './runtime.mjs'
import { autonomousPolicy, heldPolicy } from '../conformance/crypto.mjs'
import { CATALOGUE, classIds } from '../policy/catalogue.ts'
import { document_sha256 } from '../policy/document.ts'

const events = async (r: any, after?: string) => (await r.tool('events.list', { limit: 200, ...(after ? { after } : {}) })).result.structuredContent
const adopted = async (r: any, document: any) => {
 const before = (await events(r)).cursor
 const answer = await r.adopt(document); assert.equal(answer.status, 200)
 const { events: list } = await events(r, before ?? undefined)
 const found = list.filter((event: any) => event.type === 'policy.adopted'); assert.equal(found.length, 1)
 return { event: found[0], before, seq: answer.payload.seq, revision: answer.payload.revision }
}
const standardOnly = () => ({ schema: 'rer-agent-policy/1', catalogue: CATALOGUE, rules: [{ id: 'standard', class: 'standard', do: 'autonomous' }], spend: { none: true } })
const standardAndExternal = (r: any) => ({ ...standardOnly(), rules: [{ id: 'standard', class: 'standard', do: 'autonomous' }, { id: 'external', class: 'external', do: 'approval', approver: [`person:${r.c.person.sub}`, 'role:owner'], wait: 'PT1H', max_per_day: 3, seed: 'synthetic' }], reviewers: ['sponsor'], spend: { none: true } })

test('policy.adopted carries the adopted classes and a decision reference, and nothing a subscriber may not read', async () => {
 const r = await runtime()
 try {
  await r.adopt(autonomousPolicy())
  for (const [document, expected] of [[standardOnly(), ['standard']], [standardAndExternal(r), ['external', 'standard']], [autonomousPolicy(), [...classIds]]] as const) {
   const { event, seq, revision } = await adopted(r, document)
   assert.equal(event.seq, seq); assert.equal(event.revision, revision); assert.equal(event.uri, `${r.c.origin}/agents/policy/${seq}`); assert.deepEqual(event.actor, { kind: 'business' })
   assert.deepEqual(event.classes.map((item: any) => item.class).sort(), [...expected].sort()); assert.ok(event.classes.every((item: any) => Object.keys(item).join() === 'class'))
   assert.deepEqual(event.decision, { revision, document_sha256: await document_sha256(document as any) })
   const text = JSON.stringify(event)
   for (const secret of [r.c.person.sub, 'person:', 'role:owner', 'PT1H', 'sponsor', 'approver', 'reviewers', 'max_per_day', 'microusd', 'rules', 'document"']) assert.ok(!text.includes(secret), `${secret} must not appear in policy.adopted`)
   assert.deepEqual(Object.keys(event).sort(), ['actor', 'at', 'classes', 'decision', 'id', 'revision', 'seq', 'type', 'uri'])
  }
  // Replay by cursor returns the same shape and ids in order.
  const all = await events(r), policies = all.events.filter((event: any) => event.type === 'policy.adopted')
  const replay = await events(r, all.events[0].id)
  assert.deepEqual(replay.events, all.events.slice(1)); assert.deepEqual(replay.events.filter((event: any) => event.type === 'policy.adopted'), policies.filter((event: any) => event.id !== all.events[0].id))
  assert.ok(policies.length >= 3 && policies.every((event: any) => Array.isArray(event.classes) && event.decision?.revision === event.revision))
  // No document: the door is closed to the agent, so read the event once a policy is back.
  const cursor = (await events(r)).cursor, none = await r.adopt(null); assert.equal(none.status, 200); await r.adopt(autonomousPolicy())
  const empty = (await events(r, cursor)).events.find((event: any) => event.type === 'policy.adopted' && event.seq === none.payload.seq)
  assert.deepEqual(empty.classes, []); assert.deepEqual(empty.decision, { revision: none.payload.revision, document_sha256: null })
 } finally { await r.close() }
})
