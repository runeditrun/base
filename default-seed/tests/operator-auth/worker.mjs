import { withDemo } from '../../../modules/demo/index.mjs'
import { authResponse } from '../../src/core/app/auth-http.server'
import { createApi } from '../../src/core/app/hono'
const api = createApi()

// This envelope preserves hostile Host values through Miniflare's proxy. Only
// tests import it. All application routes and guards are the actual consumer.
export default withDemo({
  async fetch(envelope, env, execution) {
    const { url, ...init } = await envelope.json()
    const request = new Request(url, init)
    globalThis.fetch = async (url, options) => {
      if (String(url) !== 'https://api.resend.com/emails') throw new Error('Unexpected network request in test')
      const message = JSON.parse(options.body)
      await env.DB.prepare('INSERT INTO test_mail(message) VALUES (?)').bind(JSON.stringify(message)).run()
      const status = env.TEST_MAIL_STATUS
      return status === 'accepted' ? Response.json({ id: 'test-provider-receipt' })
        : Response.json({ message: 'test failure' }, { status: status === 'uncertain' ? 500 : 400 })
    }
    return new URL(url).pathname.startsWith('/auth/')
      ? authResponse(request, env)
      : api.fetch(request, env, execution)
  },
})
