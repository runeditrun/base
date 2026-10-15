import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emittedRuntime, setupToken, owner } from './emitted-runtime.mjs'

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
    assert.match(claimed, /class="btn" href="\/signin"/)
    assert.doesNotMatch(claimed, /href="\/setup"/)
    assert.ok(!claimed.includes(owner) && !claimed.includes(setupToken))
    assert.deepEqual(await (await runtime.call('/setup/state')).json(), { state: 'claimed' })
    assert.equal((await runtime.call('/signin')).status, 200)
    const head = await runtime.call('/', { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(await head.text(), '')
  } finally { await runtime.close() }
})
