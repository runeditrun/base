import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { completeFirstRun } from '../operator-auth/first-run.mjs'
import { emittedRuntime, owner, setupToken } from '../operator-auth/emitted-runtime.mjs'
import { createProtocol, errorCode } from '../../../modules/agent-door/conformance/protocol.mjs'
import { accessToken, autonomousPolicy } from '../../../modules/agent-door/conformance/crypto.mjs'
import { signSettings, testDocument, testTrust } from '../../../modules/business-settings/testing/index.mjs'
import { createPortability } from '../../../modules/portability/index.mjs'
import { portabilityPolicy } from '../../src/core/platform/portability-policy.mjs'

const approvalId = answer => {
  assert.equal(answer.result?.resultType, 'input_required', JSON.stringify(answer))
  return answer.result._meta['com.runeditrun/approval'].id
}
async function archive(service) {
  const id = await service.exports.create()
  while ((await service.exports.advance(id)).phase !== 'complete') {}
  return new Response(await service.exports.download(id)).text()
}
async function restore(service, text) {
  const lines = text.trim().split('\n').map(line => JSON.parse(line))
  const id = await service.imports.create(lines[0])
  for (const part of lines.filter(line => line.kind === 'part')) await service.imports.uploadPart(id, part.index, part)
  return service.imports.finalize(id, { archiveHash: lines.at(-1).archiveHash })
}

async function fixture(t) {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const issuer = 'https://agent-erasure.example.test', kid = 'agent-erasure', installationId = crypto.randomUUID(), ownerId = crypto.randomUUID()
  const runtime = await emittedRuntime({ noMail: true, files: true, bindings: {
    RER_OWNER_CLAIM_ISSUER: issuer, RER_OWNER_CLAIM_INSTALLATION_ID: installationId,
    RER_OWNER_CLAIM_PUBLIC_KEYS: JSON.stringify({ [kid]: await crypto.subtle.exportKey('jwk', keys.publicKey) }),
    RER_BUSINESS_TRUST: JSON.stringify(testTrust()),
  } })
  t.after(() => runtime.close())
  const boot = await runtime.call('/auth/bootstrap', { method: 'POST', input: { token: setupToken, displayName: 'Erasure Owner' } })
  assert.equal(boot.status, 303)
  const cookie = boot.headers.get('set-cookie').split(';')[0]
  await completeFirstRun(runtime.origin, cookie)
  const owned = async (path, input) => {
    const response = await runtime.call(path, { method: input === undefined ? 'GET' : 'POST', input, cookie })
    return { status: response.status, body: await response.json() }
  }
  const settings = await runtime.call('/api/rer/business-settings', { method: 'POST', input: {
    settings: await signSettings(testDocument({ owner_id: ownerId, business: 'agent-erasure-business' })),
  } })
  assert.equal(settings.status, 200, await settings.text())
  const c = createProtocol({ origin: runtime.origin, fetch: (url, init) => runtime.call(new URL(url).pathname + new URL(url).search, { ...init, headers: Object.fromEntries(new Headers(init?.headers)) }),
    surface: JSON.parse(await readFile(new URL('../../agent-surface.json', import.meta.url), 'utf8')),
    signer: { issuer, kid, installationId, privateKey: keys.privateKey }, person: { sub: ownerId, email: owner, cookie },
    consent: crypto.randomUUID(), agentId: crypto.randomUUID(), business: 'agent-erasure-business', seq: 0, revision: 0, points: [] })
  return { runtime, owned, c }
}

// Real emitted Base Worker, native person erasure, signed agent proposals and D1.
// Extend the existing built-Worker verification shard; no application test door.
test('native person erasure redacts pending and approved agent proposals, retains receipts and isolates peers across replay and restore', { timeout: 180_000 }, async t => {
  const { runtime, owned, c } = await fixture(t)
  const marker = 'PersonalMarker' + crypto.randomUUID().replaceAll('-', '')
  const name = marker + ' Name', email = marker.toLowerCase() + '@example.test', sourceUserId = 'source-' + marker
  const target = await owned('/api/people', { name, email, details: { sourceUserId } })
  const peer = await owned('/api/people', { name: 'Unrelated Customer', email: 'peer@example.test', details: {} })
  assert.equal(target.status, 201); assert.equal(peer.status, 201)
  const id = target.body.id, peerId = peer.body.id
  const held = autonomousPolicy(); held.rules = [{ id: 'hold', class: '*', do: 'approval', approver: ['sponsor'], wait: 'PT1H' }]
  await c.adopt(held)
  const pendingArgs = { id, body: `Pending ${name} ${email}`, idempotency_key: crypto.randomUUID() }
  const pending = await c.tool('base.people.note', pendingArgs), pendingId = approvalId(pending)
  const executedArgs = { id, body: `Approved ${name} ${email}`, idempotency_key: crypto.randomUUID() }
  const executed = await c.tool('base.people.note', executedArgs), executedId = approvalId(executed)
  const approved = await c.decideApproval(executed)
  assert.equal(approved.body.approval.state, 'executed')
  assert.equal(approved.body.approval.approvals.length, 1)
  // An imported source identity is also an exact personal identifier. A proposal
  // may mention it without repeating the native id or email.
  const named = await c.tool('base.people.note', { id: peerId, body: `Discuss ${name} (${sourceUserId})`, idempotency_key: crypto.randomUUID() }), namedId = approvalId(named)
  const peerProposal = await c.tool('base.people.note', { id: peerId, body: 'Keep this unrelated proposal', idempotency_key: crypto.randomUUID() }), peerApprovalId = approvalId(peerProposal)
  await c.adopt(autonomousPolicy())
  const unrelated = await c.tool('base.people.note', { id: peerId, body: 'Keep this executed peer note', idempotency_key: crypto.randomUUID() })
  assert.equal(unrelated.result?.isError, false)
  // A personal key need not be repeated in a tool's saved output or audit trace.
  const keyArgs = { id: peerId, body: 'Non-personal note', idempotency_key: email }
  const keyed = await c.tool('base.people.note', keyArgs)
  assert.equal(keyed.result?.isError, false)
  const rows = async table => (await runtime.db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()).results
  const dump = async () => {
    const tables = (await runtime.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '_cf_*'").all()).results
    return Promise.all(tables.map(async ({ name }) => ({ table: name, rows: await rows(name) })))
  }
  const initial = await dump()
  const before = JSON.stringify(initial)
  t.diagnostic('Before erasure: personal marker rows=' + initial.reduce((n, table) => n + table.rows.filter(row => JSON.stringify(row).toLowerCase().includes(marker.toLowerCase())).length, 0))
  assert.ok(before.includes(marker), 'the proposal payloads contain the seeded personal marker before erasure')
  const peerBefore = await runtime.db.prepare('SELECT * FROM agent_door_approvals WHERE id=?').bind(peerApprovalId).first()
  const audits = await rows('agent_door_audit')
  const auditBefore = audits.map(row => [row.sequence, row.id])
  const peerDecisions = new Set([peerProposal.decision.id, unrelated.decision.id])
  const peerAudits = audits.filter(row => peerDecisions.has(row.id))
  const peerNative = await owned(`/api/people/${peerId}/export`)
  const usageBefore = await rows('agent_door_usage')
  const measures = records => records.map(row => [row.decision_id, row.at, row.seed, row.specialist, row.agent, JSON.parse(row.classes).map(item => [item.class, item.facts.measure, item.facts.currency ?? null, item.facts.counterparty ?? null, item.facts.direction ?? null])])
  const portability = await createPortability({ db: runtime.db, buckets: { FILES: await runtime.mf.getR2Bucket('FILES') }, policy: portabilityPolicy })
  const oldArchive = await archive(portability)
  const erased = await owned(`/api/people/${id}/erasure`, { confirmation: `erase ${id}` })
  assert.equal(erased.status, 200, JSON.stringify(erased.body))
  assert.equal(erased.body.receipt.phase, 'complete')
  assert.equal((await owned(`/api/people/${id}/export`)).status, 404)
  for (const proposal of [pendingId, executedId, namedId]) {
    const view = await owned(`/agents/api/approvals/${proposal}`)
    assert.equal(view.status, 200)
    assert.equal(view.body.approval.id, proposal)
    assert.equal(view.body.approval.state, proposal === executedId ? 'executed' : 'held')
    assert.ok(Number.isFinite(Date.parse(view.body.approval.expires_at)))
    assert.equal(view.body.approval.code, 'subject_erased')
    assert.deepEqual(view.body.approval.summary, {})
    assert.equal((await owned(`/agents/api/approvals/${proposal}/approve`, {})).status, 409)
  }
  assert.deepEqual(await runtime.db.prepare('SELECT * FROM agent_door_approvals WHERE id=?').bind(peerApprovalId).first(), peerBefore)
  assert.deepEqual((await rows('agent_door_audit')).map(row => [row.sequence, row.id]), auditBefore)
  assert.deepEqual((await rows('agent_door_audit')).filter(row => peerDecisions.has(row.id)), peerAudits)
  assert.deepEqual((await rows('agent_door_usage')).filter(row => peerDecisions.has(row.decision_id)), usageBefore.filter(row => peerDecisions.has(row.decision_id)))
  assert.deepEqual(measures(await rows('agent_door_usage')), measures(usageBefore), 'all reservation measures and accounting dimensions are retained')
  const audit = await owned('/agents/api/audit')
  assert.equal(audit.status, 200)
  assert.ok(audit.body.rows.some(row => row.tombstone && row.agent.id === c.agentId && row.decision === 'approval' && row.outcome === 'executed'))
  for (const args of [pendingArgs, executedArgs, keyArgs]) {
    const replay = await runtime.call('/mcp', { method: 'POST', headers: {
      authorization: `Bearer ${await accessToken(c)}`, 'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tools/call', 'mcp-name': 'base.people.note',
    }, input: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'base.people.note', arguments: args,
      _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': { elicitation: { url: {} } } } } } })
    assert.equal(errorCode(await replay.json()), 'subject_erased')
  }
  const after = JSON.stringify(await dump())
  assert.equal(after.includes(id), false, 'the native person id is absent too, including late erasure events')
  const notifications = (await rows('agent_door_events')).map(row => JSON.parse(row.event)).filter(event => event.type === 'person.erasure.requested')
  assert.equal(notifications.length, 1, 'the non-personal erasure notification remains')
  assert.equal(notifications[0].uri, 'base://erasures')
  assert.equal(after.includes(marker), false, 'zero personal marker hits across every live D1 table')
  assert.equal(after.toLowerCase().includes(email), false)
  const cleanArchive = await archive(portability)
  assert.equal(cleanArchive.includes(id), false)
  assert.equal(cleanArchive.includes(marker), false)
  assert.equal(cleanArchive.toLowerCase().includes(email), false)
  await assert.rejects(restore(portability, oldArchive), error => error.status === 400 && /erasure_epoch/.test(error.message))
  // Restore into a clean actual D1 store with the same migrated schema.
  const destination = await emittedRuntime({ noMail: true, files: true })
  t.after(() => destination.close())
  const clean = await createPortability({ db: destination.db, buckets: { FILES: await destination.mf.getR2Bucket('FILES') }, policy: portabilityPolicy })
  await restore(clean, cleanArchive)
  const restored = await archive(clean)
  assert.equal(restored.includes(id), false)
  assert.equal(restored.includes(marker), false)
  assert.equal(restored.toLowerCase().includes(email), false)
  assert.equal(await destination.db.prepare('SELECT count(*) n FROM agent_door_approvals').first('n'), 4)
  assert.deepEqual(await owned(`/api/people/${peerId}/export`), peerNative)
  t.diagnostic(`PROBE A native POST /api/people/:id/erasure -> HTTP 200 complete; 4 approvals retained, 3 redacted; live/archive/restore marker hits=0; pending+executed+key replays=subject_erased`)
  t.diagnostic(`PROBE B proposal ids/times/status/agent/decision receipts retained; audit rows=${auditBefore.length}; usage reservations=${usageBefore.length}; peer proposal and usage unchanged`)
  t.diagnostic('PROBE C older backup -> HTTP 400 erasure_epoch; clean restore succeeds; existing tombstone/concurrent-capture assertions run in module erasure suite')

  // Short source identities must not select another person's proposal merely
  // because its text, native id, timestamps or bookkeeping contain those bytes.
  await c.adopt(held)
  for (const source of ['1', 'source-12', 'source[*]?']) {
    const subject = await owned('/api/people', { name: 'Source Identity', email: crypto.randomUUID() + '@example.test', details: { sourceUserId: source } })
    assert.equal(subject.status, 201)
    const peerArgs = { id: peerId, body: `Keep peer revision 21 and source-1234 and source[*]?extra`, idempotency_key: crypto.randomUUID() }
    const proposal = await c.tool('base.people.note', peerArgs), proposalId = approvalId(proposal)
    const peerView = await owned(`/agents/api/approvals/${proposalId}`)
    // The same source as a delimited token still selects a linked proposal.
    const linked = await c.tool('base.people.note', { id: peerId, body: `Discuss prefix${source}suffix then (${source})`, idempotency_key: crypto.randomUUID() })
    const linkedId = approvalId(linked)
    const peerRows = async () => ({
      approval: await runtime.db.prepare('SELECT * FROM agent_door_approvals WHERE id=?').bind(proposalId).first(),
      calls: await runtime.db.prepare('SELECT * FROM agent_door_calls WHERE decision_id=? ORDER BY rowid').bind(proposal.decision.id).all(),
      audits: await runtime.db.prepare('SELECT * FROM agent_door_audit WHERE id=? ORDER BY sequence').bind(proposal.decision.id).all(),
      usage: await runtime.db.prepare('SELECT * FROM agent_door_usage WHERE decision_id=? ORDER BY rowid').bind(proposal.decision.id).all(),
    })
    const stable = value => ({ ...value, calls: value.calls.results, audits: value.audits.results, usage: value.usage.results })
    const beforePeer = stable(await peerRows())
    const counts = async () => Promise.all(['agent_door_approvals', 'agent_door_audit', 'agent_door_usage'].map(table => runtime.db.prepare(`SELECT count(*) n FROM ${table}`).first('n')))
    const beforeCounts = await counts()
    const result = await owned(`/api/people/${subject.body.id}/erasure`, { confirmation: `erase ${subject.body.id}` })
    assert.equal(result.status, 200, JSON.stringify(result.body))
    assert.deepEqual(stable(await peerRows()), beforePeer, `source ${JSON.stringify(source)} preserves the peer's full proposal and audit content`)
    assert.deepEqual(await owned(`/agents/api/approvals/${proposalId}`), peerView)
    assert.deepEqual(await counts(), beforeCounts, 'proposal, audit and usage counts stay intact')
    assert.equal((await owned(`/agents/api/approvals/${linkedId}`)).body.approval.code, 'subject_erased', 'whole source tokens still select linked proposals')
    t.diagnostic(`PROBE ISOLATION source=${JSON.stringify(source)}: peer proposal/call/audit/usage byte-identical; counts=${beforeCounts.join('/')} unchanged; bounded source mention redacted`)
  }
})

// Same native flow and verification registration. No identifier of the erased
// person is present in these proposals: only the recorded people.name value.
test('recorded names in proposal or audit free text erase with word boundaries and preserve peers', { timeout: 180_000 }, async t => {
  const { runtime, owned, c } = await fixture(t)
  const held = autonomousPolicy(); held.rules = [{ id: 'hold', class: '*', do: 'approval', approver: ['sponsor'], wait: 'PT1H' }]
  await c.adopt(held)
  const portability = await createPortability({ db: runtime.db, buckets: { FILES: await runtime.mf.getR2Bucket('FILES') }, policy: portabilityPolicy })
  const retained = []
  const colonCases = ['Al: please follow up tomorrow', 'Please follow up tomorrow:Al', 'Follow up:Al:tomorrow', 'Al: value; key:Al']
  const cases = [
    ...['Recorded Name ' + crypto.randomUUID(), 'a', 'Al', '1', 'Zoë', 'Name[*]?'].map(name => ({ name })),
    ...colonCases.map(body => ({ name: 'Al', body })),
  ]
  for (const { name, body } of cases) await t.test(JSON.stringify(body ?? name), async () => {
    const target = await owned('/api/people', { name, email: crypto.randomUUID() + '@example.test', details: {} })
    const peer = await owned('/api/people', { name: name + 'son', email: crypto.randomUUID() + '@example.test', details: {} })
    assert.equal(target.status, 201); assert.equal(peer.status, 201)
    const make = body => c.tool('base.people.note', { id: peer.body.id, body, idempotency_key: crypto.randomUUID() })
    // The embedded hit comes first; punctuation and a JSON escape surround the
    // real name. Names are literals, including regexp/LIKE/GLOB metacharacters.
    const args = { id: peer.body.id, body: body ?? `Keep prefix${name}suffix; discuss \"${name}\".`, idempotency_key: crypto.randomUUID() }
    const named = await c.tool('base.people.note', args), namedId = approvalId(named)
    const auditOnly = await make('Non-personal audit-only proposal'), auditId = approvalId(auditOnly)
    await runtime.db.prepare("UPDATE agent_door_audit SET evidence=json_set(evidence,'$.recorded_name',?) WHERE id=?").bind(body ?? `Discuss (${name}).`, auditOnly.decision.id).run()
    const peerProposal = await make(`Keep ${name}son and ordinary words: Alpine, data, policy/1, revision 21, version 1.0, source-1234, ${name}é.`), peerId = approvalId(peerProposal)
    await c.adopt(autonomousPolicy())
    const peerExecuted = await make('Keep the executed peer note and reservation')
    assert.equal(peerExecuted.result?.isError, false)
    await c.adopt(held)
    const peerDecisions = new Set([peerProposal.decision.id, peerExecuted.decision.id])
    const snapshot = async () => {
      const tables = ['agent_door_approvals', 'agent_door_calls', 'agent_door_audit', 'agent_door_usage']
      return Promise.all(tables.map(async table => ({ table, rows: (await runtime.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results })))
    }
    const before = await snapshot()
    const peerRows = data => data.map(({ table, rows }) => ({ table, rows: rows.filter(row => table === 'agent_door_approvals' ? row.id === peerId : peerDecisions.has(row.decision_id ?? row.id)) }))
    const peerBytes = JSON.stringify(peerRows(before))
    const counts = before.map(({ rows }) => rows.length)
    assert.ok(peerRows(before).find(item => item.table === 'agent_door_usage').rows.length > 0, 'the peer has a real usage reservation')
    const auditSequence = before.find(item => item.table === 'agent_door_audit').rows.map(row => [row.sequence, row.id, row.at, row.agent])
    const proposalRows = before.find(item => item.table === 'agent_door_approvals').rows.filter(row => [namedId, auditId].includes(row.id))
    assert.ok(proposalRows.every(row => !row.saved.includes(target.body.id)), 'no native identifier links select the name-only proposals')
    assert.equal(JSON.parse(proposalRows.find(row => row.id === auditId).saved).args.body, 'Non-personal audit-only proposal', 'the second proposal has no name in its free-text content')
    const oldArchive = await archive(portability)
    const result = await owned(`/api/people/${target.body.id}/erasure`, { confirmation: `erase ${target.body.id}` })
    assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.receipt.phase, 'complete')
    const after = await snapshot()
    assert.equal(JSON.stringify(peerRows(after)), peerBytes, 'peer proposal, call, audit content and usage reservations are byte-identical')
    assert.deepEqual(after.map(({ rows }) => rows.length), counts, 'all proposal, call, audit and usage counts stay intact')
    assert.deepEqual(after.find(item => item.table === 'agent_door_audit').rows.map(row => [row.sequence, row.id, row.at, row.agent]), auditSequence)
    const stubs = after.find(item => item.table === 'agent_door_approvals').rows.filter(row => [namedId, auditId].includes(row.id))
    const redacted = stubs.filter(row => JSON.parse(row.saved).tombstone).length
    t.diagnostic(`PROBE NAME ${JSON.stringify(body ?? name)}: personal proposal/audit payloads 2 -> ${2 - redacted}; peer byte-identical; counts ${counts.join('/')} -> ${after.map(item => item.rows.length).join('/')}`)
    for (const row of stubs) {
      const old = JSON.parse(proposalRows.find(item => item.id === row.id).saved), saved = JSON.parse(row.saved)
      assert.ok(saved.tombstone, 'name-only content selects the existing redaction stub')
      assert.equal(saved.expires_at, old.expires_at); assert.equal(row.state, 'held')
      assert.equal(saved.agent.id, old.principal.agent.id); assert.equal(saved.outcome, 'held')
      assert.equal(saved.summary, undefined); assert.equal(saved.args, undefined)
      const view = await owned(`/agents/api/approvals/${row.id}`)
      assert.equal(view.body.approval.code, 'subject_erased'); assert.deepEqual(view.body.approval.summary, {})
      assert.equal((await owned(`/agents/api/approvals/${row.id}/approve`, {})).status, 409)
    }
    const auditRows = after.find(item => item.table === 'agent_door_audit').rows.filter(row => [named.decision.id, auditOnly.decision.id].includes(row.id))
    assert.equal(auditRows.length, 2); assert.ok(auditRows.every(row => row.evidence === null && JSON.parse(row.row).tombstone))
    if (body) {
      assert.equal(JSON.stringify(after).includes(body), false, 'colon-delimited names are absent from live proposal and audit content')
      assert.equal(JSON.stringify((await owned('/agents/api/audit')).body).includes(body), false, 'the public audit content is redacted too')
    }
    const replay = await runtime.call('/mcp', { method: 'POST', headers: {
      authorization: `Bearer ${await accessToken(c)}`, 'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tools/call', 'mcp-name': 'base.people.note',
    }, input: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'base.people.note', arguments: args,
      _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': { elicitation: { url: {} } } } } } })
    assert.equal(errorCode(await replay.json()), 'subject_erased')
    await assert.rejects(restore(portability, oldArchive), error => error.status === 400 && /erasure_epoch/.test(error.message))
    retained.push(...stubs)
  })
  const cleanArchive = await archive(portability)
  for (const body of colonCases) assert.equal(cleanArchive.includes(body), false, 'colon-delimited names are absent from the export')
  const destination = await emittedRuntime({ noMail: true, files: true }); t.after(() => destination.close())
  const clean = await createPortability({ db: destination.db, buckets: { FILES: await destination.mf.getR2Bucket('FILES') }, policy: portabilityPolicy })
  await restore(clean, cleanArchive)
  const restored = (await destination.db.prepare('SELECT * FROM agent_door_approvals ORDER BY rowid').all()).results
  for (const row of retained) assert.deepEqual(restored.find(item => item.id === row.id), row, 'clean export/restore retains only the non-personal stub')
  const restoredAudits = (await destination.db.prepare('SELECT * FROM agent_door_audit WHERE evidence IS NULL').all()).results
  assert.equal(restoredAudits.filter(row => JSON.parse(row.row).tombstone).length, retained.length)
  const restoredArchive = await archive(clean)
  for (const body of colonCases) assert.equal(restoredArchive.includes(body), false, 'colon-delimited names are absent after clean restore')
  t.diagnostic(`PROBE NAME RESTORE: ${retained.length} non-personal proposal and audit stubs preserved; older archives HTTP 400 erasure_epoch`)
})
