import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { runtime } from './runtime.mjs'

test('a Business token is refused before a policy envelope binds the Business, and a missing settings row stops Business authority', async t => {
 const r = await runtime()
 t.after(() => r.close())
 const listed = () => r.mcp('tools/list')
 const pull = async () => {
  const iat = Math.floor(Date.now() / 1000), { issuer, installationId } = r.c.signer
  const signed = await r.sign('rer-agent-decisions+jwt', { v: 1, iss: issuer, aud: r.c.origin, sub: installationId, business: r.c.business, after: 0, limit: 200, iat, exp: iat + 60, jti: randomUUID() })
  const response = await r.post('/api/rer/agent-decisions', { pull: signed })
  await response.body?.cancel()
  return response.status
 }
 // Paired settings, signed token, but no envelope yet: nothing to compare the token's business claim with.
 const unbound = await listed()
 assert.equal(unbound.status, 401)
 assert.match(unbound.headers.get('www-authenticate') ?? '', /resource_metadata=/)
 assert.equal((await r.adopt(null)).status, 200)
 const bound = await listed()
 assert.equal(bound.status, 200)
 assert.deepEqual(bound.result.tools, [])
 assert.equal(await pull(), 200)
 // An install with no settings row was never paired: a missing row is a stopped Business, not a running one.
 await r.db.prepare('DELETE FROM bs_settings').run()
 const unpaired = await listed()
 assert.equal(unpaired.status, 401)
 assert.match(unpaired.headers.get('www-authenticate') ?? '', /resource_metadata=/)
 assert.equal(await pull(), 404)
})
