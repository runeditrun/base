import test from 'node:test'
import assert from 'node:assert/strict'
import { openConsumerRuntime } from './runtime.mjs'

test('hosted demos and local development accept suppressed invitations and sign-in mail through the auth routes', async () => {
  for (const { local, demo } of [{ local: false, demo: true }, { local: true, demo: true }, { local: true, demo: false }]) {
    const config = {
      origin: local ? 'http://localhost:8787' : 'https://demo.example.test', local,
      OWNER_EMAIL: 'owner@example.test', MAIL_FROM: 'auth@example.test',
      SESSION_SECRET: 'test-only-session-secret-with-32-bytes',
      SETUP_TOKEN: 'test-only-bootstrap-token-with-32-bytes',
    }
    const r = await openConsumerRuntime({ config, demo, mailStatus: 'accepted' })
    const post = (input, cookie, headers) => ({ method: 'POST', input, cookie, headers })
    try {
      const bootstrap = await r.call('/auth/bootstrap', post({ token: config.SETUP_TOKEN, displayName: 'Demo Owner' }))
      assert.equal(bootstrap.status, 303)
      const cookie = bootstrap.headers.get('set-cookie').split(';')[0]
      const invite = await r.call('/auth/invite', post({ email: 'colleague@example.test', role: 'member', displayName: 'Demo Colleague' }, cookie))
      assert.equal(invite.status, 202, await invite.text())
      const magic = await r.call('/auth/magic-link', post({ email: config.OWNER_EMAIL }))
      assert.equal(magic.status, 202)
      assert.deepEqual(await magic.json(), { status: 'accepted' })
      // Native sign-in forms still take the visitor to the normal next step.
      const form = await r.call('/auth/magic-link', { method: 'POST', body: new URLSearchParams({ email: config.OWNER_EMAIL, returnTo: '/app' }).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } })
      assert.equal(form.status, 303)
      assert.equal(new URL(form.headers.get('location'), config.origin).searchParams.get('notice'), 'sent')
      assert.deepEqual(await r.mails(), [])
    } finally { await r.close() }
  }
})
