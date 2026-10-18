import assert from 'node:assert/strict'
import { checkDoor } from './import-door-conformance.mjs'

/** One core flow on the real migrated, newly claimed default Worker. */
export async function freshSeedImportDoor({ baseUrl, cookie }) {
  const call = (path, body, headers = {}) => fetch(baseUrl + path, {
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    headers: { cookie, origin: baseUrl, 'content-type': 'application/json', ...headers },
  })
  const request = (action, body) => call('/api/operator/import/' + action, body)
  const anonymous = await request('plan', {})
  assert.equal((await fetch(baseUrl + '/api/operator/import/plan', { method: 'POST', headers: { origin: baseUrl, 'content-type': 'application/json' }, body: '{}' })).status, 401)
  assert.equal((await call('/api/operator/import/plan', {}, { origin: 'https://cross-origin.example' })).status, 403)
  assert.equal(anonymous.status, 400, 'an authenticated empty request reaches the actual door validation')
  const nativeSnapshot = async () => {
    const response = await call('/api/operator/import-export')
    assert.equal(response.status, 200)
    return response.json()
  }
  const before = await nativeSnapshot()
  assert.deepEqual(before, [], 'the default seed begins with no people')
  const records = [
    { ref: 'door-alice', name: 'Alice Chen', email: 'alice.chen@example.test', details: { team: 'Customer support' } },
    { ref: 'door-sam', name: 'Sam Okafor', email: 'sam.okafor@example.test', details: { team: 'Operations' } },
  ]
  await checkDoor({ request, bytes: Buffer.from(JSON.stringify(records)), name: 'people.json', nativeSnapshot,
    assertApplied(_before, after, report) {
      assert.deepEqual(after.sort((a, b) => a.ref.localeCompare(b.ref)), records)
      assert.equal(report.counts.present, records.length)
    },
    assertUndone(initial, after) { assert.deepEqual(after, initial) },
  })
  const settings = await (await call('/api/operator/import-settings')).json()
  assert.equal(settings.enabled, false, 'owner flow works while Business grants are disabled')
  const revoked = await call('/api/operator/import-settings', { enabled: true, revokedKids: ['retired-test-key'] })
  assert.equal(revoked.status, 200)
  await call('/api/operator/import-settings', { enabled: false })
  const reenabled = await (await call('/api/operator/import-settings', { enabled: true })).json()
  assert.deepEqual(reenabled.revokedKids, ['retired-test-key'], 're-enabling Business never unrevokes a signing key')
  await call('/api/operator/import-settings', { enabled: false })
  assert.equal((await call('/api/rer/import/plan', {})).status, 404)
  const history = await (await call('/api/operator/import-history')).json()
  assert.equal(history.history.length, 1)
  assert.equal(history.history[0].state, 'undone')
  assert.match(history.history[0].caption, /approved by/)
  assert.equal((await call('/app/import')).status, 200)
  assert.equal((await call('/api/people/imports', { label: 'old', people: records })).status, 404, 'the older importer has been removed')
  return { conformance: 'PASS', people: records.length, undo: 'undone', businessEnabled: false }
}
