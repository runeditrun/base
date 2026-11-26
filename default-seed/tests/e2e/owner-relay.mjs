import assert from 'node:assert/strict'
import { emittedRuntime, owner, setupToken } from '../operator-auth/emitted-runtime.mjs'

export async function ownerRelaySignIn() {
  const relayUrl = 'https://relay.example.test/api/managed-mail/send'
  const key = 'test-only-owner-relay'
  const member = 'teammate@example.test'
  const submissions = []
  let reply = () => Response.json({ messageId: '<test-receipt@example.test>' }, { status: 202 })
  const runtime = await emittedRuntime({
    bindings: { MAIL_PROVIDER: 'rer', MAIL_RELAY_URL: relayUrl, MAIL_API_KEY: key },
    async outboundMail(request) {
      assert.equal(request.url, relayUrl)
      assert.equal(request.method, 'POST')
      assert.ok(request.headers.get('authorization') === `Bearer ${key}`)
      submissions.push(await request.json())
      return reply()
    },
  })
  const post = (path, input) => runtime.call(path, { method: 'POST', input })
  const signIn = email => post('/auth/magic-link', { email, returnTo: '/app' })
  try {
    const bootstrap = await post('/auth/bootstrap', { token: setupToken, displayName: 'Morgan Ortiz' })
    assert.equal(bootstrap.status, 303)
    await bootstrap.body?.cancel()
    // An active teammate would get a link through a direct provider; the relay answers
    // them like an unknown address, so the public response does not reveal teammates.
    await runtime.db.prepare(`INSERT INTO oa_operators (id,email,display_name,role,status,created_at)
      VALUES (?,?,?,'member','active',?)`).bind(crypto.randomUUID(), member, 'Jamie Price', Date.now()).run()
    const refused = await signIn(member)
    assert.equal(refused.status, 202)
    assert.deepEqual(runtime.networkRequests, [])

    assert.equal((await signIn(owner.toUpperCase())).status, 202)
    assert.equal(submissions.length, 1)
    const [mail] = submissions
    assert.equal(mail.to, owner)
    assert.ok(mail.subject && mail.text && mail.html)
    const link = new URL(mail.text.match(/https?:\/\/\S+/)[0])
    assert.equal(link.origin, runtime.origin)
    assert.equal(link.pathname, '/auth/confirm')
    const confirmed = await post(link.pathname, { token: link.searchParams.get('token') })
    assert.equal(confirmed.status, 303)
    assert.ok(confirmed.headers.get('set-cookie'))

    for (const response of [
      () => Response.redirect('https://elsewhere.example.test/collect', 307),
      () => Response.json({ error: key }),
    ]) {
      reply = response
      const failed = await signIn(owner)
      assert.equal(failed.status, 503)
      assert.ok(!(await failed.text()).includes(key))
    }
    assert.equal(submissions.length, 3)
    assert.deepEqual(runtime.networkRequests.map(({ origin, path }) => origin + path), Array(3).fill(relayUrl))
    return true
  } finally {
    await runtime.close()
  }
}
