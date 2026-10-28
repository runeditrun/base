import type { AuditRow } from './audit.ts'
import type { Principal, Runtime, ToolDefinition } from './types.ts'

export const handoffPath = (kind: string, id: string) => `/agents/proofs/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`
/** A tool that needs native proof never runs on agent authority alone. The
 * person proves it through the seed's own check at the handoff, then the agent
 * retries with that reference; the reference carries no credential. */
export async function proofRefusal(rt: Runtime, tool: ToolDefinition, reference: unknown, principal: Principal, row: AuditRow) {
  const kind = tool.proof!.native
  if (typeof reference !== 'string') {
    const id = crypto.randomUUID()
    return { code: 'native_proof_required', fields: { proof: { kind, handoff: { id, url: `${rt.options.origin}${handoffPath(kind, id)}` } } } }
  }
  row.proof = { kind, reference }
  const valid = await rt.options.nativeProof![kind]!.verify(reference, { kind, person: principal.person, db: rt.options.db, agent: principal.agent, tool: tool.name })
  return valid ? null : { code: 'native_proof_invalid', fields: { proof: { kind } } }
}
