import assert from 'node:assert/strict'

// Prepare the real first-run prerequisite for tests of post-setup app behavior.
export async function completeFirstRun(origin, cookie) {
  const response = await fetch(`${origin}/setup`, {
    method: 'POST', redirect: 'manual',
    headers: { origin, cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'confirm=yes',
  })
  assert.equal(response.status, 303, 'owner confirms first-run setup through its actual form transport')
  assert.equal(response.headers.get('location'), '/app')
}
