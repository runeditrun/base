import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { completeFirstRun } from '../operator-auth/first-run.mjs'
import { emittedRuntime, owner, setupToken } from '../operator-auth/emitted-runtime.mjs'

const issuer = 'https://business.example.test'
const claimInstallation = 'business-archive-test-installation'
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const segment = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')

/** The emitted default seed Worker carrying RER's claim trust, signed in, with
 * its Business door opened by the owner. RER's grant signer is the network edge. */
async function businessSeed(t) {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const runtime = await emittedRuntime({ noMail: true, files: true, bindings: {
    RER_OWNER_CLAIM_ISSUER: issuer, RER_OWNER_CLAIM_INSTALLATION_ID: claimInstallation,
    RER_OWNER_CLAIM_PUBLIC_KEYS: JSON.stringify({ business: await crypto.subtle.exportKey('jwk', keys.publicKey) }),
  } })
  t.after(() => runtime.close())
  const bootstrap = await runtime.call('/auth/bootstrap', { method: 'POST', input: { token: setupToken, displayName: 'Archive Owner' } })
  assert.equal(bootstrap.status, 303)
  const cookie = bootstrap.headers.get('set-cookie').split(';')[0]
  await completeFirstRun(runtime.origin, cookie)
  const owned = async (path, input) => {
    const response = await runtime.call(path, { method: input === undefined ? 'GET' : 'POST', input, cookie })
    return { status: response.status, body: await response.json() }
  }
  assert.equal((await owned('/api/operator/import-settings', { enabled: true })).status, 200)
  const token = async (claims) => {
    const now = Math.floor(Date.now() / 1000)
    const signed = `${segment({ alg: 'ES256', typ: 'rer-import-grant+jwt', kid: 'business' })}.${segment({
      v: 1, iss: issuer, aud: runtime.origin, installationId: claimInstallation, email: owner, jti: randomUUID(),
      iat: now, exp: now + 120, namespace: 'people', maxBytes: 1_000_000, maxChunks: 16, maxRecords: 1000, ...claims })}`
    const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, Buffer.from(signed))
    return `${signed}.${Buffer.from(signature).toString('base64url')}`
  }
  const call = async (action, input, grant) => {
    const response = await runtime.call(`/api/rer/import/${action}`, { method: 'POST', input,
      headers: { authorization: `Bearer ${grant ?? await token({ action })}` } })
    return { status: response.status, body: await response.json() }
  }
  const upload = async (people) => {
    const bytes = Buffer.from(JSON.stringify(people)), totalChunks = Math.ceil(bytes.length / 65536)
    let uploadId
    for (let index = 0; index < totalChunks; index++) {
      const chunk = bytes.subarray(index * 65536, (index + 1) * 65536)
      const sent = await call('uploads', { uploadId, name: 'people.json', bundleSha256: hash(bytes), totalBytes: bytes.length,
        totalChunks, index, chunkSha256: hash(chunk), base64: chunk.toString('base64') })
      assert.equal(sent.status, 200, JSON.stringify(sent.body))
      uploadId = sent.body.uploadId
    }
    return { uploadId, bytes }
  }
  const plan = async (uploadId, catchup) => {
    const planned = await call('plan', { uploadId, ...(catchup ? { catchup } : {}) })
    assert.equal(planned.status, 200, JSON.stringify(planned.body))
    return planned.body
  }
  const apply = async (planned) => {
    const review = { fingerprint: planned.fingerprint, approvalRecordId: randomUUID(), approvedAt: new Date().toISOString() }
    for (let batch = 0; batch < 50; batch++) {
      const applied = await call('apply', { planId: planned.planId, reviewedFingerprint: planned.fingerprint }, await token({ action: 'apply', ...review }))
      assert.equal(applied.status, 200, JSON.stringify(applied.body))
      if (applied.body.job.state === 'completed') return
    }
    assert.fail('apply did not complete')
  }
  const people = async () => (await owned('/api/operator/import-export')).body
  return { call, token, owned, upload, plan, apply, people }
}

test('Business keeps a tool\'s final export as an archive in the default seed: plan and catch-up leave it, and restore-check parses it writing nothing', async (t) => {
  const seed = await businessSeed(t)
  // rer's vendor exports leave a removed credential as a marker; that bundle archives.
  const team = [
    { ref: 'ada', name: 'Ada Archive', email: 'ada@example.test', details: { team: 'Support', apiKey: '[removed]' } },
    { ref: 'lin', name: 'Lin Archive', email: 'lin@example.test' },
  ]
  const first = await seed.upload(team)
  const takenAt = new Date().toISOString(), request = { uploadId: first.uploadId, tool: 'people-vendor', takenAt }
  const archived = await seed.call('archive', request)
  assert.equal(archived.status, 200, JSON.stringify(archived.body))
  assert.deepEqual({ ...archived.body, archiveId: undefined, counts: undefined }, { archiveId: undefined, counts: undefined,
    key: `business-archive/people-vendor/${takenAt}`, tool: 'people-vendor', takenAt, bundleSha256: hash(first.bytes), bytes: first.bytes.length })
  assert.deepEqual([archived.body.counts.input, archived.body.counts.mapped, archived.body.counts.rejected], [2, 2, 0])
  assert.deepEqual(await seed.call('archive', request), archived, 'repeating the request with a fresh grant answers the same archive')
  assert.deepEqual(await seed.people(), [], 'archiving writes nothing native')

  // The existing grant rules hold for both actions.
  const { archiveId } = archived.body, once = await seed.token({ action: 'restore-check' })
  assert.equal((await seed.call('restore-check', { archiveId }, once)).status, 200)
  assert.deepEqual(await seed.call('restore-check', { archiveId }, once), { status: 403, body: { error: 'grant_replayed_revoked_or_expired' } })
  assert.deepEqual(await seed.call('restore-check', { archiveId }, await seed.token({ action: 'archive' })), { status: 403, body: { error: 'grant_binding_mismatch' } })
  assert.deepEqual(await seed.call('archive', request, await seed.token({ action: 'archive', fingerprint: 'a'.repeat(64) })), { status: 403, body: { error: 'invalid_grant' } })
  assert.deepEqual(await seed.call('archive', request, await seed.token({ action: 'archive', catchup: 'bounded', approvalRecordId: randomUUID(), approvedAt: takenAt })), { status: 403, body: { error: 'invalid_grant' } })
  assert.deepEqual(await seed.call('archive', { ...request, tool: '../people' }), { status: 400, body: { error: 'invalid_tool' } })
  assert.equal((await seed.owned('/api/operator/import/archive', request)).status, 404, 'the owner-session mount does not serve grant-only actions')

  // A live credential value is never kept in exact bytes.
  const secret = await seed.upload([{ ref: 'kai', name: 'Kai Secret', email: 'kai@example.test', details: { apiKey: randomUUID() } }])
  const refused = await seed.call('archive', { ...request, uploadId: secret.uploadId })
  assert.deepEqual([refused.status, refused.body.error], [422, 'archive_holds_credentials'])

  // The baseline applies, then the tool's next export catches up and is archived as the final copy.
  await seed.apply(await seed.plan(first.uploadId))
  const final = await seed.upload([...team, { ref: 'max', name: 'Max Final', email: 'max@example.test' }])
  const catchup = await seed.plan(final.uploadId, true)
  assert.deepEqual([catchup.summary.created, catchup.summary.unchanged], [1, 2])
  await seed.apply(catchup)
  const finalTakenAt = new Date().toISOString()
  const last = await seed.call('archive', { uploadId: final.uploadId, tool: 'people-vendor', takenAt: finalTakenAt })
  assert.equal(last.status, 200, JSON.stringify(last.body))
  assert.equal(last.body.counts.input, catchup.summary.sourceRecords, 'the final archive counts what the final catch-up read')
  assert.deepEqual(await seed.call('archive', { ...request, takenAt: finalTakenAt }), { status: 409, body: { error: 'archive_exists', details: { archiveId } } })

  const native = await seed.people()
  assert.deepEqual(native.map((person) => person.ref).sort(), ['ada', 'lin', 'max'])
  for (const kept of [archived.body, last.body]) {
    const checked = await seed.call('restore-check', { archiveId: kept.archiveId })
    assert.equal(checked.status, 200, JSON.stringify(checked.body))
    assert.deepEqual(checked.body, { ...kept, rejected: [] }, 'the archive parses to its own hash and counts after plans, applies and a catch-up')
  }
  assert.deepEqual(await seed.people(), native, 'restore-check writes nothing native')
  assert.deepEqual(await seed.call('restore-check', { archiveId: randomUUID() }), { status: 404, body: { error: 'archive_not_found' } })
})

test('A person\'s erasure withdraws the door\'s archives and says so; the erased person\'s export cannot be archived again', async (t) => {
  const seed = await businessSeed(t)
  const exported = [
    { ref: 'eve', name: 'Eve Erased', email: 'eve@example.test', details: { phone: '+1 555 0100' } },
    { ref: 'ray', name: 'Ray Kept', email: 'ray@example.test' },
  ]
  const sent = await seed.upload(exported)
  await seed.apply(await seed.plan(sent.uploadId))
  const archived = await seed.call('archive', { uploadId: sent.uploadId, tool: 'people-vendor', takenAt: new Date().toISOString() })
  assert.equal(archived.status, 200, JSON.stringify(archived.body))
  assert.equal((await seed.call('restore-check', { archiveId: archived.body.archiveId })).status, 200)

  const erased = await seed.owned('/api/people/eve/erasure', { confirmation: 'erase eve' })
  assert.equal(erased.status, 200, JSON.stringify(erased.body))
  assert.ok(erased.body.journal.stores.some((store) => store.store === 'ik_door_archive_chunks' && store.rows === 1), 'the erasure journal counts the withdrawn archive bytes')
  assert.deepEqual(await seed.call('restore-check', { archiveId: archived.body.archiveId }), { status: 410, body: { error: 'archive_withdrawn', details: {
    archiveId: archived.body.archiveId, reason: 'An erasure in this seed withdrew the archive\'s bytes with the rest of the import door\'s held content. Nothing remains to restore.' } } })
  assert.equal((await seed.owned('/api/people/ray/export')).status, 200, 'unrelated native records stay')

  // The tool's export still holds Eve: it is refused, and the upload goes, as a plan of it would.
  const again = await seed.upload(exported)
  assert.deepEqual(await seed.call('archive', { uploadId: again.uploadId, tool: 'people-vendor', takenAt: new Date().toISOString() }), { status: 409, body: { error: 'source_erased' } })
  assert.deepEqual(await seed.call('uploads', { uploadId: again.uploadId }), { status: 404, body: { error: 'upload_not_found' } })
})
