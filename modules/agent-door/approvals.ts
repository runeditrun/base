import type { Evidence } from './audit.ts'
import type { ClassAndFacts, CallResult, Person, Principal, Runtime, ToolContext } from './types.ts'
import { classify, context, livePrincipal, runTool, sameFacts, saveCall } from './execution.ts'
import { appendEvents } from './events.ts'
import { error, json } from './errors.ts'
import { matchesRef, preparedBy } from './people.ts'
import { acquireDecision, releaseDecision, reserveUsage } from './counting.ts'
import { usage, usageToday } from './audit.ts'
import { decide } from './policy/decide.ts'
import { canonical } from './policy/document.ts'
import { policyRefusal, policyState } from './policy-store.ts'

export interface SavedApproval {
  decision_id: string; revision: number | null; tool: string; args: Record<string, unknown>; digest: string; key: string | null
  classes: ClassAndFacts[]; principal: Principal; approvers: string[]; expires_at: string; door: ToolContext['door']; evidence: Evidence
  result: CallResult; expected_revision?: number
}
interface ApprovalRecord { id: string; state: string; saved: string; approvals: string; result: string | null; version: number }
interface ApprovalMark { ref: string; person: string; name: string; at: string }
export async function openApproval(rt: Runtime, saved: SavedApproval) {
  const id = crypto.randomUUID(), requestState = crypto.randomUUID()
  const approval = { id, url: `${rt.options.origin}/agents/approvals/${id}`, expires_at: saved.expires_at }
  saved.result = { ...saved.result, outcome: 'pending', approval, requestState }
  await rt.options.db.prepare('INSERT INTO agent_door_approvals(id,state,saved) VALUES(?,?,?)').bind(id, 'pending', JSON.stringify(saved)).run()
  return saved.result
}
export async function approvalReplay(rt: Runtime, result: CallResult): Promise<CallResult> {
  if (!result.approval) return result
  const row = await rt.options.db.prepare('SELECT * FROM agent_door_approvals WHERE id=?').bind(result.approval.id).first<ApprovalRecord>()
  if (!row) return { ...result, outcome: 'refused', code: 'approval_expired' }
  const saved: SavedApproval = JSON.parse(row.saved)
  if (row.result) return JSON.parse(row.result)
  if (row.state === 'rejected') return { ...result, outcome: 'refused', code: 'approval_rejected' }
  if (row.state === 'expired' || rt.now() >= Date.parse(saved.expires_at)) return { ...result, outcome: 'refused', code: 'approval_expired' }
  return result
}
export function approvalView(rt: Runtime, row: ApprovalRecord) {
  const saved: SavedApproval = JSON.parse(row.saved)
  return { id: row.id, decision_id: saved.decision_id, revision: saved.revision, state: row.state === 'pending' && rt.now() >= Date.parse(saved.expires_at) ? 'expired' : row.state === 'executing' ? 'pending' : row.state,
    tool: saved.tool, classes: saved.classes, approvers: saved.approvers, approvals: JSON.parse(row.approvals), expires_at: saved.expires_at,
    prepared_by: preparedBy(saved.principal), rules: saved.result.decision?.classes.map(({ class: cls, rule, do: action }) => ({ class: cls, rule, do: action })) }
}
export const canReadApproval = (rt: Runtime, person: Person, saved: SavedApproval) => person.id === saved.principal.person.id || saved.approvers.some(ref => matchesRef(rt.options.people, person, saved.principal.person.id, ref))
export async function approvalDoor(rt: Runtime, request: Request, person: Person, id?: string, action?: string): Promise<Response> {
  if (!id) {
    if (request.method !== 'GET') return error('method_not_allowed', 405)
    const rows = (await rt.options.db.prepare('SELECT * FROM agent_door_approvals ORDER BY rowid DESC LIMIT 200').all<ApprovalRecord>()).results
    return json({ approvals: rows.filter(row => canReadApproval(rt, person, JSON.parse(row.saved))).map(row => approvalView(rt, row)) })
  }
  const row = await rt.options.db.prepare('SELECT * FROM agent_door_approvals WHERE id=?').bind(id).first<ApprovalRecord>()
  if (!row) return error('not_found', 404)
  const saved: SavedApproval = JSON.parse(row.saved)
  if (!canReadApproval(rt, person, saved)) return error('forbidden', 403)
  if (request.method === 'GET' && !action) return json({ approval: approvalView(rt, row) })
  if (request.method !== 'POST' || !['approve', 'reject'].includes(action ?? '')) return error('method_not_allowed', 405)
  let body: { revision?: unknown }
  try { body = await request.json() } catch { return error('invalid_arguments') }
  if (body.revision !== saved.revision) return error('revision_conflict', 409, { current_revision: saved.revision })
  if (rt.now() >= Date.parse(saved.expires_at) && row.state === 'pending') {
    await rt.options.db.prepare("UPDATE agent_door_approvals SET state='expired' WHERE id=? AND state='pending'").bind(id).run()
    return error('approval_expired', 409)
  }
  const approvals: ApprovalMark[] = JSON.parse(row.approvals)
  const refs = saved.approvers.filter(ref => matchesRef(rt.options.people, person, saved.principal.person.id, ref))
  if (!refs.length) return error('forbidden', 403)
  if (row.state !== 'pending') return json({ approval: approvalView(rt, row) })
  const unsatisfied = refs.filter(ref => !approvals.some(mark => mark.ref === ref))
  if (!unsatisfied.length) return json({ approval: approvalView(rt, row) })
  if (action === 'approve') approvals.push(...unsatisfied.map(ref => ({ ref, person: person.id, name: person.name, at: new Date(rt.now()).toISOString() })))
  const complete = action === 'approve' && saved.approvers.every(ref => approvals.some(mark => mark.ref === ref))
  const nextState = action === 'reject' ? 'rejected' : complete ? 'executing' : 'pending'
  const changed = await rt.options.db.prepare('UPDATE agent_door_approvals SET state=?,approvals=?,version=version+1 WHERE id=? AND version=? AND state=?')
    .bind(nextState, JSON.stringify(approvals), id, row.version, 'pending').run()
  if (!changed.meta.changes) return error('approval_conflict', 409)
  let effects: Array<{ type: string; uri: string; data?: Record<string, unknown> }> = []
  if (complete) {
    let result = { ...saved.result }, locked = false
    const principal = await livePrincipal(rt, saved.principal), state = await policyState(rt), tool = rt.tools.find(tool => tool.name === saved.tool)
    const refusal = policyRefusal(rt, state, tool?.classes)
    if (!principal || !tool) result = { ...result, outcome: 'refused', code: 'sponsor_unavailable' }
    else if (refusal) result = { ...result, outcome: 'refused', ...refusal }
    else if (state.revision !== saved.revision) result = { ...result, outcome: 'refused', code: 'approval_evidence_changed' }
    else {
      try {
        const ctx = context(rt, principal, saved.door, [])
        const authority = await tool.authority?.(saved.args, ctx)
        if (authority?.widens && authority.subject === principal.person.id) result = { ...result, outcome: 'refused', code: 'self_escalation' }
        else if (tool.revision && saved.expected_revision !== undefined && await tool.revision(saved.args, ctx) !== saved.expected_revision) result = { ...result, outcome: 'refused', code: 'approval_evidence_changed' }
        else if (!sameFacts(saved.classes, await classify(tool, saved.args, ctx))) result = { ...result, outcome: 'refused', code: 'approval_evidence_changed' }
        else {
          locked = await acquireDecision(rt, saved.decision_id)
          if (!locked) throw new Error('decision_busy')
          const sums = await usage(rt, state.document!, principal)
          const fresh = decide({ document: state.document, revision: state.revision, call: { seed: rt.options.seed, specialist: principal.agent.specialist ?? null, agent: principal.agent.id, classes: saved.classes }, usageToday: usageToday(sums) })
          if (canonical(fresh.classes) !== canonical(saved.evidence.rules) || !await reserveUsage(rt, saved.decision_id, principal, saved.classes, state)) throw new Error('approval_evidence_changed')
          await releaseDecision(rt, saved.decision_id); locked = false
          const run = await runTool(rt, tool, saved.args, principal, result, saved.door)
          result = run.result; effects = run.effects
        }
      } catch (cause) { result = { ...result, outcome: 'refused', code: cause instanceof Error && ['decision_busy', 'approval_evidence_changed'].includes(cause.message) ? cause.message : 'execution_failed' } }
      finally { if (locked) await releaseDecision(rt, saved.decision_id) }
    }
    if (result.outcome === 'done') result.receipt = { id: crypto.randomUUID(), decision_id: saved.decision_id, approval_id: id, prepared_by: preparedBy(saved.principal), approved_by: [...new Set(approvals.map(mark => mark.person))] }
    await rt.options.db.prepare("UPDATE agent_door_approvals SET state='approved',result=? WHERE id=?").bind(JSON.stringify(result), id).run()
    await saveCall(rt, saved.principal, saved.key, result)
    await appendEvents(rt, effects.map(effect => ({ ...effect, actor: { kind: 'agent', ...preparedBy(principal ?? saved.principal) } })))
  }
  await appendEvents(rt, [{ type: 'approval.decided', uri: `${rt.options.origin}/agents/approvals/${id}`, actor: { kind: 'person', person: { id: person.id, name: person.name } }, data: { decision_id: saved.decision_id, classes: saved.classes, decision: 'approval', state: action === 'reject' ? 'rejected' : complete ? 'approved' : 'pending' } }])
  const current = (await rt.options.db.prepare('SELECT * FROM agent_door_approvals WHERE id=?').bind(id).first<ApprovalRecord>())!
  return json({ approval: approvalView(rt, current) })
}
