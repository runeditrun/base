import test from 'node:test'
import assert from 'node:assert/strict'
import { runtime } from './runtime.mjs'
import { autonomousPolicy, heldPolicy } from '../conformance/crypto.mjs'
import { createProtocol } from '../conformance/protocol.mjs'
import { runJourney } from '../conformance/journey.mjs'
import { runAgentDoorConformance, validateAgentSurface } from '../conformance/index.mjs'

const code = (answer: any) => answer.result?._meta?.['com.runeditrun/error']?.code ?? answer.error?.data?.code
const resource = { kind: 'record', id: 'operations-brief' }
const input = () => ({ id: resource.id, value: 'Review the supplier renewal', idempotency_key: crypto.randomUUID() })
const audit = async (r: any) => (await r.person('/agents/api/audit')).body.rows
const surface = (security = false) => ({
 schema: 'rer-agent-surface/1', seed: 'synthetic', specialist: 'operations', notTools: [], resources: ['synthetic://record/{id}'],
 tools: [
  { name: 'synthetic.records.list', scope: 'records:read', readOnly: true, classes: ['standard'], clauses: ['BASE-AGENT-002'] },
  { name: 'synthetic.records.write', scope: 'records:write', readOnly: false, classes: [security ? 'security' : 'standard'], clauses: ['BASE-AGENT-002'], ...(security ? { sponsorEscalation: false } : {}) },
  { name: 'synthetic.records.send', scope: 'records:write', readOnly: false, classes: ['external', 'sensitive'], clauses: ['BASE-AGENT-006'] },
  { name: 'synthetic.events.list', scope: 'events:read', readOnly: true, classes: ['standard'], clauses: ['BASE-AGENT-010'] },
 ],
 witness: { tool: 'synthetic.records.list', args: {} },
 journey: [
  { id: 'write', tool: 'synthetic.records.write', args: { id: resource.id, value: 'Review the supplier renewal' }, expect: [{ class: security ? 'security' : 'standard' }] },
  { id: 'send', tool: 'synthetic.records.send', args: { id: resource.id }, expect: [{ class: 'external' }, { class: 'sensitive' }] },
  { id: 'list', tool: 'synthetic.records.list', args: {}, expect: [{ class: 'standard' }] },
  { id: 'events', tool: 'synthetic.events.list', args: {}, expect: [{ class: 'standard' }] },
 ],
})
const fixture = (extra = {}) => runtime({ nativeTargets: true, toolSubset: ['synthetic.records.list', 'synthetic.records.write', 'synthetic.records.send'], ...extra })
const conform = (r: any, declaration: any, nativeJourney?: any) => runAgentDoorConformance({ fetch: r.fetch, origin: r.c.origin, signer: r.c.signer, person: r.c.person, surface: declaration, business: r.c.business, consent: r.c.consent, now: () => r.c.now, nativeJourney })
const failures = (result: any) => result.points.filter((point: any) => !point.ok)

// The conformance callback inspects only the supported person/audit and MCP doors.
test('native target resolver reaches audit, approval summary and execution without trusting caller attribution', async t => {
 const r = await fixture()
 try {
  const result = await conform(r, surface(), async ({ tool }: any) => {
   const call = await tool('synthetic.records.write', { ...input(), target: { kind: 'person', id: 'injected' } })
   assert.equal(call.result.isError, false)
   const rows = await audit(r), row = rows.at(-1)
   assert.deepEqual(row.resource, resource)
   assert.deepEqual(row.ignored_arguments, ['target'])
  })
  assert.deepEqual(failures(result), [])
  t.diagnostic(`target fixture: ${result.points.length}/${result.points.length} conformance points passed`)
  // A delayed approval keeps its exact resolved target. Changing native target
  // identity before execution must invalidate the approved summary.
  const state = (await r.person('/agents/api/state')).body.policy
  r.c.seq = state.seq; r.c.revision = state.revision
  await r.adopt({ ...heldPolicy(), rules: heldPolicy().rules.slice(0, 1) })
  const pending = await r.tool('records.write', input()), id = pending.result._meta['com.runeditrun/approval'].id
  const view = (await r.person(`/agents/api/approvals/${id}`)).body.approval
  assert.deepEqual(view.summary.target, resource)
  const executed = await r.person(`/agents/api/approvals/${id}/approve`, { revision: view.revision, summary_sha256: view.summary_sha256 })
  assert.equal(executed.body.approval.state, 'executed')
  assert.deepEqual((await audit(r)).at(-1).resource, resource)
  const second = await r.tool('records.write', input()), secondId = second.result._meta['com.runeditrun/approval'].id
  const secondView = (await r.person(`/agents/api/approvals/${secondId}`)).body.approval
  await r.db.prepare("UPDATE test_records SET exposure='hidden' WHERE id=?").bind(resource.id).run()
  const refused = await r.person(`/agents/api/approvals/${secondId}/approve`, { revision: secondView.revision, summary_sha256: secondView.summary_sha256 })
  assert.equal(refused.body.approval.code, 'approval_evidence_changed')
  const invalid = await fixture({ nativeTargets: 'invalid' })
  try {
   await invalid.adopt()
   assert.equal(code(await invalid.tool('records.write', input())), 'target_invalid')
   assert.deepEqual((await invalid.tool('records.list', {})).result.structuredContent.records, [])
  } finally { await invalid.close() }
  t.diagnostic('target negatives: caller attribution ignored; malformed resolver target_invalid; changed target approval_evidence_changed')
 } finally { await r.close() }
})

test('resource refusals retain machine codes while missing and hidden records stay indistinguishable', async t => {
 const r = await fixture()
 try {
  const result = await conform(r, surface(), async () => {
   const hidden = 'synthetic://record/hidden', missing = 'synthetic://record/missing'
   await r.db.prepare("INSERT INTO test_records VALUES('hidden','Private account notes',1,'hidden')").run()
   const a = await r.mcp('resources/read', { uri: hidden }), b = await r.mcp('resources/read', { uri: missing })
   assert.deepEqual(a.error, b.error)
   assert.equal(a.error.data?.code, 'resource_unavailable')
   assert.equal(a.result, undefined)
  })
  // Callback requests use r's separate authenticated agent, so auditPhase's
  // per-agent count remains exact.
  assert.deepEqual(failures(result), [])
  const scoped = await r.mcp('resources/read', { uri: `synthetic://record/${resource.id}` }, { token: await r.token({ scope: 'events:read' }) })
  assert.equal(code(scoped), 'insufficient_scope'); assert.equal(scoped.result, undefined)
  await r.adopt(autonomousPolicy(), { seq: 1000, revision: 1000, paused: true })
  assert.equal(code(await r.mcp('resources/read', { uri: `synthetic://record/${resource.id}` })), 'agents_paused')
  t.diagnostic(`resource fixture: ${result.points.length}/${result.points.length} conformance points passed; hidden/missing, scope and pause negatives refused`)
 } finally { await r.close() }
})

test('security surfaces without sponsor widening retain full policy and approval journeys', async t => {
 const r = await fixture({ recordSecurity: true })
 try {
  const declaration = surface(true)
  const result = await conform(r, declaration)
  assert.deepEqual(failures(result), [])
  t.diagnostic(`per-surface fixture: ${result.points.length}/${result.points.length} conformance points passed`)
  const widening = structuredClone(declaration)
  delete (widening.tools[1] as any).sponsorEscalation
  assert.equal(validateAgentSurface(widening).ok, false)
  const falseClaim = structuredClone(declaration)
  ;(falseClaim.tools[1] as any).sponsorEscalation = 'no'
  assert.equal(validateAgentSurface(falseClaim).ok, false)
  const native = await runtime({ selfWideningClaim: true })
  try {
   await native.adopt()
   const actor = await native.mcp('tools/list')
   assert.equal(actor.status, 200)
   const sponsor = (await native.person('/agents/api/agents')).body.agents.find((a: any) => a.id === native.c.agentId).sponsor.id
   assert.equal(code(await native.tool('access.change', { id: sponsor, idempotency_key: crypto.randomUUID() })), 'self_escalation')
   const declaration = { ...surface(), tools: [{ name: 'synthetic.access.change', scope: 'records:write', readOnly: false, classes: ['access'], sponsorEscalation: false }], journey: [{ id: 'false-claim', tool: 'synthetic.access.change', args: { id: sponsor }, expect: [{ class: 'access' }] }] }
   const c = createProtocol({ ...native.c, fetch: native.fetch, points: [], listed: new Map(), surface: declaration })
   c.listed = new Map((await c.mcp('tools/list')).result.tools.map((tool: any) => [tool.name, tool]))
   await runJourney(c, 'false-claim')
   assert.ok(c.points.some((point: any) => !point.ok && point.detail.includes('self_escalation')))

  } finally { await native.close() }
  t.diagnostic('per-surface negatives: undeclared widening coverage and malformed contract fail; actual self-widening still self_escalation')
 } finally { await r.close() }
})

test('paused and unset refusals retain resolvable native classes without executing effects', async t => {
 const r = await fixture()
 try {
  const result = await conform(r, surface(), async () => {
   const before = (await r.tool('records.list', {})).result.structuredContent
   const metadata = []
   for (const paused of [true, false]) {
    await r.adopt(paused ? autonomousPolicy() : null, { seq: paused ? 1000 : 1001, revision: paused ? 1000 : 1001, paused })
    const answer = await r.tool('records.write', input())
    assert.equal(code(answer), paused ? 'agents_paused' : 'policy_unset')
    const row = (await audit(r)).at(-1)
    metadata.push({ resource: row.resource, classes: row.classes, rules: row.rules })
   }
   await r.adopt()
   assert.deepEqual((await r.tool('records.list', {})).result.structuredContent, before)
   assert.deepEqual(metadata, ['paused', 'unset'].map(disposition => ({ resource, classes: [{ class: 'standard', facts: { measure: 1 } }], rules: [{ class: 'standard', rule: null, do: disposition }] })))
  })
  assert.deepEqual(failures(result), [])
  t.diagnostic(`early refusal fixture: ${result.points.length}/${result.points.length} conformance points passed; no native effect under pause/unset`)
 } finally { await r.close() }
})
