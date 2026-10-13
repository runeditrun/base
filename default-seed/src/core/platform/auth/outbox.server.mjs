import { createD1DevelopmentOutbox, createDevelopmentOutboxHandler } from '../../../../../modules/mail/src/development/index.mjs'
import { devGate, devNotFound } from '../../../../../modules/operator-auth/index.mjs'
import { localDevelopmentEnabled } from './local.server.mjs'
import { theme } from '../../app/theme.ts'

// The outbox and the key exchange answer only a local runtime that holds
// RER_DEV_KEY. A tunnel or local proxy makes remote requests look local, so the
// outbox also needs the key gate's cookie (or the rer harness's key header).
export async function developmentOutboxResponse(request, env) {
  const url = new URL(request.url)
  if (url.pathname !== '/__dev/outbox' && url.pathname !== '/__dev/key') return null
  if (!localDevelopmentEnabled(env)) return devNotFound()
  const gate = devGate({ key: env.RER_DEV_KEY, origin: env.AUTH_ORIGIN, local: true })
  if (!gate) return devNotFound()
  if (url.pathname === '/__dev/key') return gate.exchange(request)
  const trusted = new URL(env.AUTH_ORIGIN)
  if (url.origin !== trusted.origin || request.headers.get('host') !== trusted.host ||
    (request.headers.has('origin') && request.headers.get('origin') !== trusted.origin) ||
    request.headers.get('sec-fetch-site') === 'cross-site' || !await gate.admits(request)) return devNotFound()
  return createDevelopmentOutboxHandler({
    local: true,
    origin: env.AUTH_ORIGIN,
    outbox: createD1DevelopmentOutbox({ db: env.DB }),
    theme: theme.href,
  })(request)
}
