import test from 'node:test'
import assert from 'node:assert/strict'
import { emittedRuntime, owner, setupToken } from './emitted-runtime.mjs'

const cookies = response => response.headers.getSetCookie().map(line => line.split(';')[0]).join('; ')

test('hosted demo: owner invites a person who enters /app in one click with their role and no mail', async () => {
  const r = await emittedRuntime({ demo: true })
  const post = (input, cookie) => ({ method: 'POST', input, cookie })
  try {
    const claimed = await r.call('/auth/bootstrap', post({ token: setupToken, displayName: 'Jamie Chen' }))
    assert.equal(claimed.status, 303)
    const ownerCookie = cookies(claimed)
    for (const [email, displayName, role] of [['alex@example.test', 'Alex Morgan', 'member'], ['riley@example.test', 'Riley Patel', 'admin'], ['casey@example.test', 'Casey Reed', 'owner']]) {
      const invitation = await r.call('/auth/invite', post({ email, displayName, role }, ownerCookie))
      assert.equal(invitation.status, 202, await invitation.text())
      const operators = await (await r.call('/auth/operators', { cookie: ownerCookie })).json()
      const person = operators.find(person => person.email === email)
      assert.ok(person.signInUrl, 'the invitation screen supplies the one-click action')
      const signin = await (await r.call('/signin?returnTo=/app')).text()
      assert.ok(signin.includes(displayName))
      assert.doesNotMatch(signin, /outbox|<form[^>]+action="\/auth\/magic-link"|notice=sent/i)
      const entered = await r.call(person.signInUrl)
      assert.equal(entered.status, 303)
      assert.equal(entered.headers.get('location'), '/app')
      const personCookie = cookies(entered)
      const session = await (await r.call('/auth/session', { cookie: personCookie })).json()
      assert.equal(session.operator.email, email)
      assert.equal(session.operator.role, role)
      assert.equal(session.operator.status, 'active')
      assert.equal(session.kind, 'native')
      const app = await r.call('/app', { cookie: personCookie })
      assert.equal(app.status, 200)
      assert.match(app.headers.get('content-type'), /text\/html/)
      await app.text()
      const magic = await r.call('/auth/magic-link', post({ email }))
      assert.equal(magic.status, 202)
      assert.equal((await magic.json()).signInUrl, person.signInUrl)
      const form = await r.call('/auth/magic-link', { method: 'POST',
        body: new URLSearchParams({ email, returnTo: '/app' }).toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded' } })
      assert.equal(form.status, 303)
      assert.equal(form.headers.get('location'), person.signInUrl)
      assert.equal((await r.call('/auth/operator/status', post({ operatorId: person.id, status: 'inactive' }, ownerCookie))).status, 200)
      assert.equal((await r.call(person.signInUrl)).status, 404, 'deactivated people cannot re-enter')
    }
    const pending = { email: 'pending@example.test', displayName: 'Sam Taylor', role: 'member' }
    assert.equal((await r.call('/auth/invite', post(pending, ownerCookie))).status, 202)
    const people = await (await r.call('/auth/operators', { cookie: ownerCookie })).json()
    const person = people.find(person => person.email === pending.email)
    assert.equal((await r.call('/auth/invite/cancel', post({ operatorId: person.id }, ownerCookie))).status, 200)
    assert.equal((await r.call(person.signInUrl)).status, 404)
    assert.equal((await r.call('/__dev/outbox', { cookie: ownerCookie })).status, 404)
    assert.deepEqual(r.mails, [])
    assert.deepEqual(r.networkRequests, [])
    assert.equal((await r.db.prepare('SELECT count(*) AS n FROM rer_mail_development_outbox').first()).n, 0)
    {
      const ordinary = await emittedRuntime()
      try {
        assert.equal((await ordinary.call(`/auth/one-click?as=${encodeURIComponent(owner)}`, { headers: { 'x-rer-demo': '1' } })).status, 404)
      } finally { await ordinary.close() }
    }
  } finally { await r.close() }
})
