import { runRows } from '../rows.mjs'
const archiveRows = []
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { completeFirstRun } from '../operator-auth/first-run.mjs'
import { emittedRuntime, owner, setupToken } from '../operator-auth/emitted-runtime.mjs'
import { withoutCredentials } from '../../scripts/base-cli/cli/business/vendors/common.mjs'

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
    return { uploadId, bytes, totalChunks }
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

archiveRows.push(['Business keeps a tool\'s final export as an archive in the default seed: plan and catch-up leave it, and restore-check parses it writing nothing', {}, async (t) => {
  const seed = await businessSeed(t)
  // What rer's vendor export uploads: each live credential value stripped, its
  // marker left in a field (`[removed]`), a URL's user name (`removed@`) and a
  // credential query parameter (`=removed`). That bundle holds no credential, so it archives.
  const team = withoutCredentials([
    { ref: 'ada', name: 'Ada Archive', email: 'ada@example.test', details: { team: 'Support', apiKey: randomUUID() } },
    { ref: 'lin', name: 'Lin Archive', email: 'lin@example.test', details: { health: `https://monitor:${randomUUID()}@status.example.test/health` } },
    { ref: 'hal', name: 'Hal Archive', email: 'hal@example.test', details: { hook: `https://hooks.example.test/in?api_key=${randomUUID()}&region=eu` } },
  ])
  const first = await seed.upload(team)
  const takenAt = new Date().toISOString(), request = { uploadId: first.uploadId, tool: 'people-vendor', takenAt }
  const archived = await seed.call('archive', request)
  assert.equal(archived.status, 200, JSON.stringify(archived.body))
  assert.deepEqual({ ...archived.body, archiveId: undefined, counts: undefined }, { archiveId: undefined, counts: undefined,
    key: `business-archive/people-vendor/${takenAt}`, tool: 'people-vendor', takenAt, bundleSha256: hash(first.bytes), bytes: first.bytes.length })
  assert.deepEqual([archived.body.counts.input, archived.body.counts.mapped, archived.body.counts.rejected], [team.length, team.length, 0])
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

  // A live credential value, in a field or a URL, is never kept in exact bytes.
  for (const details of [{ apiKey: randomUUID() }, { health: `https://monitor:${randomUUID()}@status.example.test/health` }, { hook: `https://hooks.example.test/in?api_key=${randomUUID()}` }]) {
    const secret = await seed.upload([{ ref: 'kai', name: 'Kai Secret', email: 'kai@example.test', details }])
    const refused = await seed.call('archive', { ...request, uploadId: secret.uploadId })
    assert.deepEqual([refused.status, refused.body.error], [422, 'archive_holds_credentials'], Object.keys(details)[0])
  }

  // The baseline applies, then the tool's final export, which adds a person and
  // repeats one record identically, is archived and caught up.
  const baseline = await seed.plan(first.uploadId)
  await seed.apply(baseline)
  const added = [{ ref: 'max', name: 'Max Final', email: 'max@example.test' }]
  const final = await seed.upload([...team, team[1], ...added])
  const finalTakenAt = new Date().toISOString()
  const last = await seed.call('archive', { uploadId: final.uploadId, tool: 'people-vendor', takenAt: finalTakenAt })
  assert.equal(last.status, 200, JSON.stringify(last.body))
  const catchup = await seed.plan(final.uploadId, true)
  assert.deepEqual([catchup.summary.created, catchup.summary.unchanged], [added.length, team.length])
  await seed.apply(catchup)
  assert.deepEqual([last.body.counts.unique, last.body.counts.input], [catchup.summary.sourceRecords, catchup.counts.input],
    'the final archive counts what the final catch-up read: unique records against its source records, every record read against its input')
  assert.ok(last.body.counts.input > last.body.counts.unique, 'the repeated record counts in input only')
  assert.deepEqual(await seed.call('archive', { ...request, takenAt: finalTakenAt }), { status: 409, body: { error: 'archive_exists', details: { archiveId } } })

  // The vendor is unchanged since: its next export is the same bundle as the
  // applied catch-up. Under the standing approval it plans afresh against that
  // import, a catch-up of no changes that Business applies and reconciles; a
  // repeated request reuses that unapplied plan. An ordinary plan of the same
  // bytes still answers the applied import.
  const standing = { catchup: 'bounded', approvalRecordId: randomUUID(), approvedAt: new Date().toISOString() }
  const unchanged = await seed.upload([...team, team[1], ...added])
  const quiet = await seed.call('plan', { uploadId: unchanged.uploadId, catchup: true }, await seed.token({ action: 'plan', ...standing }))
  assert.equal(quiet.status, 200, JSON.stringify(quiet.body))
  assert.notEqual(quiet.body.planId, catchup.planId, 'an unchanged source plans a new catch-up, not the applied one')
  assert.deepEqual(quiet.body.summary, { ...catchup.summary, created: 0, updated: 0, unchanged: catchup.summary.sourceRecords, gone: 0 })
  const again = await seed.call('plan', { uploadId: (await seed.upload([...team, team[1], ...added])).uploadId, catchup: true }, await seed.token({ action: 'plan', ...standing }))
  assert.deepEqual([again.status, again.body.planId], [200, quiet.body.planId], 'the unapplied catch-up plan is reused')
  for (let batch = 0; ; batch++) {
    const applied = await seed.call('apply', { planId: quiet.body.planId, reviewedFingerprint: quiet.body.fingerprint }, await seed.token({ action: 'apply', fingerprint: quiet.body.fingerprint, ...standing }))
    assert.equal(applied.status, 200, JSON.stringify(applied.body))
    if (applied.body.job.state === 'completed') break
    assert.ok(batch < 50, 'apply did not complete')
  }
  const reconciled = await seed.call('reconcile', { planId: quiet.body.planId })
  assert.equal(reconciled.status, 200, JSON.stringify(reconciled.body))
  const ordinary = await seed.call('plan', { uploadId: (await seed.upload(team)).uploadId })
  assert.deepEqual([ordinary.status, ordinary.body.planId], [200, baseline.planId], 'an ordinary plan of an imported bundle reuses its plan')

  const native = await seed.people()
  assert.deepEqual(native.map((person) => person.ref).sort(), [...team, ...added].map((person) => person.ref).sort())
  for (const kept of [archived.body, last.body]) {
    const checked = await seed.call('restore-check', { archiveId: kept.archiveId })
    assert.equal(checked.status, 200, JSON.stringify(checked.body))
    assert.deepEqual(checked.body, { ...kept, rejected: [] }, 'the archive parses to its own hash and counts after plans, applies and a catch-up')
  }
  assert.deepEqual(await seed.people(), native, 'restore-check writes nothing native')
  assert.deepEqual(await seed.call('restore-check', { archiveId: randomUUID() }), { status: 404, body: { error: 'archive_not_found' } })
}])

archiveRows.push(['A person\'s erasure withdraws the door\'s archives and says so; the erased person\'s export cannot be archived again', {}, async (t) => {
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
  assert.ok(erased.body.journal.stores.some((store) => store.store === 'ik_door_archive_chunks' && store.rows === sent.totalChunks), 'the erasure journal counts the withdrawn archive bytes')
  const withdrawn = await seed.call('restore-check', { archiveId: archived.body.archiveId })
  assert.deepEqual([withdrawn.status, withdrawn.body.error, withdrawn.body.details.archiveId], [410, 'archive_withdrawn', archived.body.archiveId])
  assert.ok(typeof withdrawn.body.details.reason === 'string' && withdrawn.body.details.reason.length > 0, 'the refusal says why')
  assert.equal((await seed.owned('/api/people/ray/export')).status, 200, 'unrelated native records stay')

  // The tool's export still holds Eve: it is refused, and the upload goes, as a plan of it would.
  const again = await seed.upload(exported)
  assert.deepEqual(await seed.call('archive', { uploadId: again.uploadId, tool: 'people-vendor', takenAt: new Date().toISOString() }), { status: 409, body: { error: 'source_erased' } })
  assert.deepEqual(await seed.call('uploads', { uploadId: again.uploadId }), { status: 404, body: { error: 'upload_not_found' } })
}])

test('Business archive journey retains exact exports across catch-up and withdraws erased custody', async t => {
  await runRows(t, archiveRows)
})
