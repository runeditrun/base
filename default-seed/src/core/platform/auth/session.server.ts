import { createOperatorAuth } from '../../../../../modules/operator-auth/index.mjs'
import type { Bindings } from '../bindings.server'
import { authConfig } from './config.server'
import { operatorMail } from './mail.server.mjs'

export function operatorAuth(bindings: Bindings, waitUntil?: (promise: Promise<unknown>) => void) {
  return createOperatorAuth({
    db: bindings.DB,
    config: authConfig(bindings),
    mailSender: operatorMail(bindings),
    // Cloudflare overwrites this at the public Worker boundary. Local review
    // listeners must bind loopback; forwarded headers are never trusted.
    clientIp: (request) => request.headers.get('CF-Connecting-IP') ?? '',
    waitUntil,
  })
}

export async function sessionForRequest(bindings: Bindings, request: Request) {
  return operatorAuth(bindings).getSession(request)
}
