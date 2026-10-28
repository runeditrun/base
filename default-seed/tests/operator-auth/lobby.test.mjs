import { runRows } from '../rows.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emittedRuntime, setupToken, owner } from './emitted-runtime.mjs'

const lobbyRows = []

lobbyRows.push(['the claimed Lobby opens the local sign-in flow without deployment credentials', {}, async () => {
  for (const options of [{ hostname: 'localhost', noMail: true }, { demoHost: true }]) {
    const runtime = await emittedRuntime(options)
    try {
      const claim = await runtime.call('/auth/bootstrap', {
        method: 'POST', input: { token: setupToken, displayName: 'Morgan' },
      })
      assert.equal(claim.status, 303)
      const response = await runtime.call('/')
      assert.equal(response.status, 200)
      const html = await response.text()
      assert.match(html, /data-state="claimed"/)
      const href = html.match(/class="btn" href="([^"]+)"/)[1]
      assert.equal(new URL(href, runtime.origin).pathname, '/signin')
      assert.equal((await runtime.call(href)).status, 200)
      assert.equal(runtime.mails.length, 0, 'opening sign-in needs no deployed credentials or email delivery')
    } finally { await runtime.close() }
  }
}])

lobbyRows.push(['a current session opens the app from the Lobby and signout restores the sign-in action', {}, async () => {
  const runtime = await emittedRuntime({ noMail: true })
  try {
    const claim = await runtime.call('/auth/bootstrap', { method: 'POST', input: { token: setupToken, displayName: 'Morgan' } })
    const cookie = claim.headers.get('set-cookie').split(';')[0]
    const signedIn = await runtime.call('/', { cookie })
    assert.equal(signedIn.status, 200)
    const html = await signedIn.text()
    assert.match(html, /class="btn" href="\/app"/)
    assert.doesNotMatch(html, /href="\/signin/)
    assert.equal((await runtime.call('/app', { cookie })).headers.get('location'), '/setup')
    assert.equal((await runtime.call('/setup', { cookie })).status, 200)
    assert.equal((await runtime.call('/auth/signout', { method: 'POST', input: {}, cookie })).status, 204)
    const signedOut = await runtime.call('/', { cookie })
    assert.match(await signedOut.text(), /class="btn" href="\/signin/)
  } finally { await runtime.close() }
}])

lobbyRows.push(['the installed Lobby offers sign-in as soon as the owner is claimed, before first-run confirmation', {}, async () => {
  const runtime = await emittedRuntime({ noMail: true })
  try {
    const before = await runtime.call('/')
    assert.equal(before.status, 200)
    assert.equal(before.headers.get('cache-control'), 'no-store')
    const unclaimed = await before.text()
    assert.match(unclaimed, /data-state="unclaimed"/)
    assert.match(unclaimed, /class="btn" href="\/setup"/)
    assert.deepEqual(await (await runtime.call('/setup/state')).json(), { state: 'unclaimed' })

    const claim = await runtime.call('/auth/bootstrap', {
      method: 'POST', input: { token: setupToken, displayName: 'Morgan' },
    })
    assert.equal(claim.status, 303)
    assert.equal(await runtime.db.prepare('SELECT singleton FROM oa_first_run').first(), null)
    assert.equal((await runtime.call('/auth/bootstrap', {
      method: 'POST', input: { token: setupToken, displayName: 'Second owner' },
    })).status, 409, 'the setup token is retired by the claim')

    const after = await runtime.call('/')
    assert.equal(after.status, 200)
    assert.equal(after.headers.get('cache-control'), 'no-store')
    const claimed = await after.text()
    assert.match(claimed, /data-state="claimed"/)
    assert.match(claimed, /class="btn" href="\/signin\?login_hint=owner%40example\.test"/, 'a local Lobby hands the sole owner to the sign-in form')
    assert.doesNotMatch(claimed, /href="\/setup"/)
    assert.ok(!claimed.includes(owner) && !claimed.includes(setupToken))
    assert.deepEqual(await (await runtime.call('/setup/state')).json(), { state: 'claimed' })
    assert.equal((await runtime.call('/signin')).status, 200)
    const head = await runtime.call('/', { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(await head.text(), '')
  } finally { await runtime.close() }
}])

lobbyRows.push(['the Lobby Sign in link opens the sign-in form with the claimed owner already typed', {}, async () => {
  const runtime = await emittedRuntime()
  try {
    await runtime.call('/auth/bootstrap', { method: 'POST', input: { token: setupToken, displayName: 'Morgan' } })
    const href = (await (await runtime.call('/')).text()).match(/class="btn" href="([^"]+)"/)[1]
    const signin = await runtime.call(href)
    assert.equal(signin.status, 200)
    assert.match(await signin.text(), /<input id="signin-email"[^>]* value="owner@example\.test"/)
    assert.equal(runtime.mails.length, 0, 'opening the form sends nothing')
  } finally { await runtime.close() }
}])

test("Lobby admission follows claim, current session, signout and local owner hint", async t => {
  await runRows(t, lobbyRows)
})
