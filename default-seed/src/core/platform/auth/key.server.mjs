import { devGate, devNotFound } from '../../../../../modules/operator-auth/index.mjs'
import { localDevelopmentEnabled } from './local.server.mjs'
import { authConfig } from './config.server'

// The fragment exchange keeps the checkout key out of request URLs and logs.
export async function developmentKeyResponse(request, env) {
  if (new URL(request.url).pathname !== '/__dev/key') return null
  if (!localDevelopmentEnabled(env)) return devNotFound()
  const gate = devGate({ key: env.RER_DEV_KEY, origin: env.AUTH_ORIGIN, local: true })
  return gate ? gate.exchange(request, authConfig(env).branding) : devNotFound()
}
