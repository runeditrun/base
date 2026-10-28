import type { NativeProofVerifier } from '../../../modules/agent-door/index.ts'
import type { Bindings } from '../core/platform/bindings.server'
import { operatorAuth } from '../core/platform/auth/session.server'

// This reference requires a recent native sign-in. Editions with two-factor
// step-up supply their own verifier; Business approval never substitutes for it.
const lifetime = 10 * 60 * 1000
export function nativeProofs(bindings: Bindings): Record<string, NativeProofVerifier> {
  return { recent_sign_in: {
    handoff: () => `${bindings.AUTH_ORIGIN}/signin?returnTo=%2Fagents`,
    async verify(reference, { principal }) {
      const proof = await bindings.DB.prepare(`SELECT s.id FROM oa_sessions s JOIN oa_operators o ON o.id=s.operator_id
        WHERE s.id=? AND o.id=? AND o.status='active' AND s.operator_version=o.version
        AND s.kind='native' AND s.revoked_at IS NULL AND s.expires_at>? AND s.created_at>=?`)
        .bind(reference, principal.person.id, Date.now(), Date.now() - lifetime).first()
      return !!proof
    },
  } }
}
export async function nativeProofResponse(request: Request, bindings: Bindings): Promise<Response | null> {
  if (new URL(request.url).pathname !== '/agents/api/native-proof') return null
  const headers = { 'Cache-Control': 'no-store' }
  if (request.method !== 'POST') return Response.json({ code: 'method_not_allowed' }, { status: 405, headers })
  if (request.headers.has('authorization') || request.headers.get('origin') !== bindings.AUTH_ORIGIN) return Response.json({ code: 'forbidden' }, { status: 403, headers })
  const session = await operatorAuth(bindings).getSession(request)
  if (!session || session.kind !== 'native' || session.createdAt < Date.now() - lifetime) return Response.json({ code: 'native_proof_required' }, { status: 403, headers })
  // An opaque database id, never a session cookie, token or credential.
  return Response.json({ reference: session.id }, { headers })
}
