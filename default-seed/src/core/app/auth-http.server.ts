import { AuthError, createAuthHandler, createSignInHandler, securityHeaders } from '../../../../modules/operator-auth/index.mjs'
import type { Bindings } from '../platform/bindings.server'
import { operatorAuth } from '../platform/auth/session.server'
import { signinPresentation } from '../platform/auth/signin-options.server.mjs'
import { fontDocumentResponse } from '../../../../foundation/runtime/font-response'

export async function authResponse(request: Request, bindings: Bindings, waitUntil?: (promise: Promise<unknown>) => void): Promise<Response> {
  try {
    return await fontDocumentResponse(await createAuthHandler(operatorAuth(bindings, waitUntil))(request)) ?? new Response('Not found', { status: 404 })
  } catch (error) {
    const known = error instanceof AuthError
    return Response.json({ error: known ? error.code : 'auth_unavailable' }, {
      status: known ? error.status : 503, headers: securityHeaders(),
    })
  }
}

// The shared server-rendered sign-in page: it works before any script loads.
export async function signInResponse(request: Request, bindings: Bindings, waitUntil?: (promise: Promise<unknown>) => void): Promise<Response | null> {
  const presentation = signinPresentation(bindings)
  return fontDocumentResponse(await createSignInHandler(operatorAuth(bindings, waitUntil), {
    defaultReturnTo: '/setup',
    async setup() {
      if (!bindings.SETUP_TOKEN || await bindings.DB.prepare('SELECT singleton FROM oa_bootstrap LIMIT 1').first()) return null
      return { instructions: presentation.setupInstructions }
    },
  })(request))
}
