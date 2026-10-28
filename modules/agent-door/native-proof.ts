import type { Principal, Runtime, ToolDefinition } from './types.ts'
import { ToolRefusal } from './errors.ts'

/** Only the seed can verify a human's native proof; a policy decision cannot. */
export async function requireNativeProof(rt: Runtime, tool: ToolDefinition, args: Record<string, unknown>, principal: Principal, reference?: unknown) {
  if (!tool.proof) return
  const kind = tool.proofKind!, verifier = rt.options.nativeProofs![kind]!
  const context = { principal, tool: tool.name, kind, arguments: args }
  if (typeof reference === 'string' && reference.length > 0 && reference.length <= 2000) {
    try { if (await verifier.verify(reference, context) === true) return } catch { /* Invalid or unavailable proof stays closed. */ }
  }
  const handoff = new URL(await verifier.handoff(context), rt.options.origin)
  if (handoff.origin !== rt.options.origin || handoff.username || handoff.password) throw new TypeError('Invalid native proof handoff')
  throw new ToolRefusal('native_proof_required', 'Recent native authentication is required', { proof: 'native', kind, handoff: handoff.href })
}
