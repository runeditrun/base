import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emittedRuntime, setupToken, owner } from './emitted-runtime.mjs'

test('the claimed Lobby offers project-folder recovery only on this computer', async () => {
  for (const [options, local] of [[{ hostname: 'localhost', noMail: true }, true], [{ demoHost: true }, false]]) {
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
      if (local) assert.match(html, /<code>rer signin<\/code>/)
      else assert.doesNotMatch(html, /rer signin/)
    } finally { await runtime.close() }
  }
})

test('the installed Lobby offers sign-in as soon as the owner is claimed, before first-run confirmation', async () => {
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
})

test('the Lobby Sign in link opens the sign-in form with the claimed owner already typed', async () => {
  const runtime = await emittedRuntime()
  try {
    await runtime.call('/auth/bootstrap', { method: 'POST', input: { token: setupToken, displayName: 'Morgan' } })
    const href = (await (await runtime.call('/')).text()).match(/class="btn" href="([^"]+)"/)[1]
    const signin = await runtime.call(href)
    assert.equal(signin.status, 200)
    assert.match(await signin.text(), /<input id="signin-email"[^>]* value="owner@example\.test"/)
    assert.equal(runtime.mails.length, 0, 'opening the form sends nothing')
  } finally { await runtime.close() }
})
