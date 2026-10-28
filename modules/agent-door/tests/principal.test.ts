import test from 'node:test'
import assert from 'node:assert/strict'
import { runtime } from './runtime.mjs'
import { autonomousPolicy, heldPolicy } from '../conformance/crypto.mjs'

const code = (answer: any) => answer.result?._meta?.['com.runeditrun/error']?.code ?? answer.error?.data?.code

test('principal journey: sponsor-shared clients retain resource, event, subscription and approval fences', async t => {
 const r = await runtime()
 let checks = 0
 const check = (value: unknown) => { assert.ok(value); checks++ }
 try {
  await r.adopt()
  for (const client of ['a', 'b']) await r.db.prepare('INSERT INTO test_records VALUES(?,?,1,?)').bind(client, client, `client:${client}`).run()
  const token = (client: string) => r.token({ client_id: client, act: { sub: `agent-${client}`, name: `Agent ${client}`, specialist: 'operations' }, scope: `records:read events:read service:${client}` })
  const a = await token('a'), b = await token('b')
  const read = (id: string, bearer: string) => r.mcp('resources/read', { uri: `synthetic://record/${id}` }, { token: bearer })
  for (const [client, bearer] of [['a', a], ['b', b]]) {
   const listed = await r.tool('records.list', {}, { token: bearer })
   check(listed.result.structuredContent.records.length === 1 && listed.result.structuredContent.records[0].id === client)
   const own = await read(client, bearer), data = JSON.parse(own.result.contents[0].text)
   check(data.reader.agent === `agent-${client}` && data.reader.client === client && data.reader.scopes.includes(`service:${client}`))
   check((await read(client === 'a' ? 'b' : 'a', bearer)).result === undefined)
  }
  // Both actors have the same owner sponsor. Native resource authorization wins
  // over both the Business-role shortcut and sponsor attribution.
  for (const client of ['a', 'b']) await r.db.prepare('INSERT INTO agent_door_events(id,uri,event) VALUES(?,?,?)').bind(`event-${client}`, `synthetic://record/${client}`, JSON.stringify({ id: `event-${client}`, type: 'changed', uri: `synthetic://record/${client}`, actor: { kind: 'person', person: { id: (await r.person('/auth/session')).body.operator.id, name: 'Owner' } }, at: new Date().toISOString() })).run()
  for (const [client, bearer] of [['a', a], ['b', b]]) {
   const events = await r.tool('events.list', {}, { token: bearer })
   check(events.result.structuredContent.events.some((e: any) => e.id === `event-${client}`) && !events.result.structuredContent.events.some((e: any) => e.id === `event-${client === 'a' ? 'b' : 'a'}`))
   const stream = await r.post('/mcp', { jsonrpc: '2.0', id: client, method: 'subscriptions/listen', params: { notifications: { resourceSubscriptions: ['synthetic://record/a', 'synthetic://record/b'] }, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } }, { Authorization: `Bearer ${bearer}`, 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'subscriptions/listen' })
   const reader = stream.body.getReader()
   try {
    const ack = new TextDecoder().decode((await reader.read()).value)
    check(ack.includes(`synthetic://record/${client}`) && !ack.includes(`synthetic://record/${client === 'a' ? 'b' : 'a'}`))
    for (const changed of ['a', 'b']) await r.db.prepare('INSERT INTO agent_door_events(id,uri,event) VALUES(?,?,?)').bind(crypto.randomUUID(), `synthetic://record/${changed}`, JSON.stringify({ id: crypto.randomUUID(), type: 'changed', uri: `synthetic://record/${changed}`, actor: { kind: 'business' }, at: new Date().toISOString() })).run()
    const delivered = await Promise.race([reader.read(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('No authorized subscription delivery')), 5000))])
    const update = new TextDecoder().decode(delivered.value)
    check(update.includes('notifications/resources/updated') && update.includes(`synthetic://record/${client}`) && !update.includes(`synthetic://record/${client === 'a' ? 'b' : 'a'}`))
   } finally { await reader.cancel() }
  }
  await r.adopt(heldPolicy())
  const approve = async (pending: any) => {
   const id = pending.error.data.approval.id, view = (await r.person(`/agents/api/approvals/${id}`)).body.approval
   return r.person(`/agents/api/approvals/${id}/approve`, { revision: view.revision, summary_sha256: view.summary_sha256 })
  }
  const pending = await read('a', a), completed = await approve(pending)
  check(completed.body.approval.state === 'executed')
  const saved = await r.db.prepare('SELECT result FROM agent_door_approvals WHERE id=?').bind(pending.error.data.approval.id).first()
  const result = JSON.parse(saved.result), reader = JSON.parse(result.result.contents[0].text).reader
  check(reader.agent === 'agent-a' && reader.client === 'a' && reader.scopes.includes('service:a') && !reader.scopes.includes('service:b'))
  const held = await read('a', a)
  await r.db.prepare('INSERT INTO test_grants VALUES(?,?)').bind('a', JSON.stringify(['events:read', 'service:a', 'unrequested:scope'])).run()
  const refused = await approve(held)
  check(refused.body.approval.state === 'refused' && refused.body.approval.code === 'insufficient_scope')
  const rows = (await r.person('/agents/api/audit')).body.rows
  const audit = rows.find((row: any) => row.decision_id === held.error.data._meta['com.runeditrun/decision'].id)
  check(audit.agent.id === 'agent-a' && audit.tool === 'resources/read' && audit.resource === 'synthetic://record/a' && audit.outcome === 'refused' && audit.code === 'insufficient_scope' && audit.client_id === 'a' && !audit.scopes.includes('records:read') && !audit.scopes.includes('unrequested:scope') && audit.approval.id && audit.sponsor.id && audit.at)
  await r.db.prepare('DELETE FROM test_grants WHERE client=?').bind('a').run()
  const resourceFence = await read('a', a)
  await r.db.prepare('INSERT INTO test_grants VALUES(?,?)').bind('a', JSON.stringify(['records:read', 'events:read'])).run()
  const narrowedResource = await approve(resourceFence)
  check(narrowedResource.body.approval.state === 'refused' && narrowedResource.body.approval.code === 'insufficient_scope')
  await r.adopt(autonomousPolicy())
  const embedded = await r.person('/__embedded', { name: 'synthetic.records.list', scopes: ['events:read'] })
  check(embedded.body.code === 'insufficient_scope')
  check((await r.person('/__embedded', { scopes: ['records:read'] })).body.outcome === 'done')
  t.diagnostic(`Gap P public-door journey: ${checks}/${checks} assertions passed`)
 } finally { await r.close() }
})
