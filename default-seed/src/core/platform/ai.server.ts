import { createNativeAiConsumer, type NativeAiRequest, type NativeAiAuthority } from '../../../../modules/ai/index.mjs'
import { operatorAuth } from './auth/session.server'
import type { Bindings } from './bindings.server'

/** Reference adoption. Editions supply their own server-owned second-call prompt. */
export async function nativeAiResponse(request: Request, bindings: Bindings): Promise<Response | null> {
  if (new URL(request.url).pathname !== '/api/ai') return null
  let declaration: NativeAiRequest, authority: NativeAiAuthority
  try {
    declaration = JSON.parse(bindings.RER_AI_REQUEST ?? 'null')
    authority = JSON.parse(bindings.RER_AI_AUTHORITY ?? 'null')
  } catch {
    return Response.json({ error: { code: 'ai_disabled' } }, { status: 503, headers: { 'cache-control': 'private, no-store' } })
  }
  return createNativeAiConsumer({ env: bindings, auth: operatorAuth(bindings), origin: bindings.AUTH_ORIGIN,
    request: declaration, authority, mode: 'owner-account',
    prepareSecond: (first, original) => `Check the candidate summary against the original site data. Return only supported facts.\nCandidate data:\n${first}\nOriginal site data:\n${original}`,
  }).handle(request)
}
