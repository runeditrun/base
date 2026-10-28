import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createReadStream } from 'node:fs'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { DatabaseSync as TraceDatabaseSync } from 'node:sqlite'
import { DatabaseSync } from '../../scripts/base-cli/modules/container/adapters/d1-sqlite.mjs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { freshLocalProject } from './runtime.mjs'
import { door, planPeople, applyDoor, finishDoor, assertWithdrawn } from './import-door.mjs'

const tag = Math.random().toString(36).slice(2, 10)
const canary = { name: `Name${tag}`, email: `mail-${tag}@example.test`, note: `Note${tag}`, detail: `Detail${tag}`, filename: `File${tag}.txt`, body: `Body${tag}` }
const planted = Object.values(canary).map((value) => value.toLowerCase())
const hits = (text) => planted.filter((value) => text.toLowerCase().includes(value))

async function session(origin, key, as) {
  const response = await fetch(`${origin}/auth/dev/enter?as=${as}`, { redirect: 'manual', headers: { 'x-rer-dev-key': key } })
  assert.equal(response.status, 303)
  return response.headers.getSetCookie().map((cookie) => cookie.split(';')[0]).filter((cookie) => !cookie.endsWith('=')).join('; ')
}
function api(origin, cookie) {
  return async (method, path, body, contentType = 'application/json') => {
    const response = await fetch(origin + path, { method, headers: { cookie, ...(method === 'GET' ? {} : { origin, ...(body instanceof FormData ? {} : { 'content-type': contentType }) }) }, body: body === undefined ? undefined : body instanceof FormData ? body : contentType === 'application/json' ? JSON.stringify(body) : body })
    return { status: response.status, json: await response.json().catch(() => null) }
  }
}
/** Every value left in the installation: each table of the local D1 file, then each R2 key and body. */
async function leftovers(root, values = planted) {
  const hits = (text) => values.filter(value => text.toLowerCase().includes(value))
  const found = []
  const directory = join(root, '.wrangler/state/v3/d1/miniflare-D1DatabaseObject')
  for (const file of (await readdir(directory)).filter((name) => name.endsWith('.sqlite') && name !== 'metadata.sqlite')) {
    const db = new DatabaseSync(join(directory, file), { readOnly: true })
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
      for (const row of db.prepare(`SELECT * FROM "${name}"`).all()) found.push(...hits(JSON.stringify(row, (_, v) => v instanceof Uint8Array ? new TextDecoder().decode(v) : v)).map((value) => `${name}:${value}`))
    }
    // Version 3 original custody is base64 text split at complete quanta. Scan
    // its decoded bytes too, including values spanning chunk boundaries.
    const originals = db.prepare("SELECT job_id,kind,original_key,group_concat(bytes,'') AS body FROM (SELECT o.* FROM ik_d1_original_chunks o JOIN ik_original_sets s ON s.job_id=o.job_id WHERE s.version=3 ORDER BY o.ordinal) GROUP BY job_id,kind,original_key").all()
    for (const original of originals) found.push(...hits(Buffer.from(original.body, 'base64').toString()).map(value => `original:${value}`))
    const chunks = db.prepare('SELECT upload_id,base64 FROM ik_door_chunks ORDER BY upload_id,ordinal').all()
    const bundles = new Map()
    for (const chunk of chunks) bundles.set(chunk.upload_id, [...(bundles.get(chunk.upload_id) ?? []), Buffer.from(chunk.base64, 'base64')])
    for (const parts of bundles.values()) found.push(...hits(Buffer.concat(parts).toString()).map(value => `door-upload:${value}`))
    db.close()
  }
  const traceDirectory = join(root, '.wrangler/state/v3/observability/miniflare-wobs-trace-store')
  for (const file of (await readdir(traceDirectory)).filter(name => name.endsWith('.sqlite'))) {
    const db = new TraceDatabaseSync(join(traceDirectory, file), { readOnly: true })
    try {
      for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
        for (const row of db.prepare(`SELECT * FROM "${name}"`).all()) found.push(...hits(JSON.stringify(row, (_, v) => v instanceof Uint8Array ? new TextDecoder().decode(v) : v)).map(value => `trace:${name}:${value}`))
      }
    } finally { db.close() }
  }
  const { getPlatformProxy } = createRequire(join(root, 'package.json'))('wrangler')
  const proxy = await getPlatformProxy({ configPath: join(root, 'wrangler.jsonc'), persist: { path: join(root, '.wrangler/state/v3') }, remoteBindings: false })
  try {
    for (const object of (await proxy.env.FILES.list()).objects) found.push(...hits(object.key + await (await proxy.env.FILES.get(object.key)).text()).map((value) => `r2:${value}`))
  } finally { await proxy.dispose() }
  return found
}
async function archiveLeftovers(root, path, values = planted) {
  const hits = (text) => values.filter(value => text.toLowerCase().includes(value))
  const { readArchive } = await import(pathToFileURL(join(root, 'scripts/base-cli/modules/portability/index.mjs')))
  const found = []
  for await (const record of readArchive(Readable.toWeb(createReadStream(join(root, path))))) {
    if (record.kind === 'manifest') found.push(...hits(JSON.stringify(record)))
    if (record.kind === 'part') for (const item of record.items) found.push(...hits(item.kind === 'object' ? item.key + Buffer.from(item.data, 'base64').toString() : JSON.stringify(item)))
  }
  return found
}
const sql = (root, query) => {
  const directory = join(root, '.wrangler/state/v3/d1/miniflare-D1DatabaseObject')
  return readdir(directory).then((files) => {
    const db = new DatabaseSync(join(directory, files.find((name) => name.endsWith('.sqlite') && name !== 'metadata.sqlite')), { readOnly: true })
    try { return db.prepare(query).all() } finally { db.close() }
  })
}
const refused = (run) => assert.rejects(run, /failed \(4\)/)

test('BASE-DATA-003 a person with 300 notes and 300 reactions across 30 imports erases through bounded, continued steps that survive a server restart, while pending door custody is withdrawn and unrelated imported peers survive', { timeout: 30 * 60_000 }, async (t) => {
  const runtime = await freshLocalProject('large-erasure-owner@example.test')
  try {
    let owner = api(runtime.origin, await session(runtime.origin, runtime.vars.RER_DEV_KEY, 'owner'))
    const actor = `U-LARGE-${tag}`
    const created = await owner('POST', '/api/people', { name: 'Large native subject', email: `large-${tag}@example.test`, details: { sourceUserId: actor } })
    assert.equal(created.status, 201)
    const person = created.json.id
    const peer = (await owner('POST', '/api/people', { name: 'Unrelated native peer', email: 'native-peer@example.test' })).json.id
    const beforePeer = (await owner('GET', `/api/people/${peer}/export`)).json
    const reactions = [{ name: 'acknowledged', count: 3, users: [person, actor, 'U-KEPT'] }]
    // Thirty real catch-ups retain the complete source snapshot. Each introduces
    // ten people; erasure must redact all retained copies across the lineage.
    const peers = []
    for (let upload = 0; upload < 30; upload++) {
      peers.push(...Array.from({ length: 10 }, (_, index) => ({
        ref: `reacted-${upload}-${index}`, name: `Reacted ${upload}-${index}`, email: `reacted-${upload}-${index}@example.test`, details: { reactions } })))
      const plan = await planPeople(owner, `reactions-${upload}.json`, peers, upload > 0)
      await finishDoor(owner, 'apply', plan)
    }
    const plan = await planPeople(owner, 'large-erasure-peers.json', [
      { ref: 'large-applied-peer', name: 'Applied peer', email: 'applied@example.test', details: { reactions } },
      ...Array.from({ length: 19 }, (_, index) => ({ ref: `large-filler-${index}`, name: `Filler ${index}`, email: `filler-${index}@example.test` })),
      { ref: 'large-pending-peer', name: 'Pending peer', email: 'pending@example.test', details: { reactions } }, ...peers,
    ], true)
    assert.equal((await applyDoor(owner, plan)).json.job.state, 'applying')
    assert.equal((await owner('GET', '/api/people/large-pending-peer/export')).status, 404)
    for (let index = 0; index < 300; index++) {
      assert.equal((await owner('POST', `/api/people/${person}/notes`, { body: `Large subject note ${index}` })).status, 201)
    }
    assert.equal((await owner('GET', `/api/people/${person}/export`)).json.notes.length, 300)
    const erased = await owner('POST', `/api/people/${person}/erasure`, { confirmation: `erase ${person}` })
    assert.equal(erased.status, 202, 'the first request commits one bounded redaction step and queues the next')
    assert.ok(erased.json.redaction.jobsRedacted > 0 && erased.json.redaction.jobsPending > 0)
    // The server stops with the next step queued, and the queue does not outlive it.
    // Nobody repeats the request: the scheduled sweep (here every minute) takes the
    // erasure over and its queued steps finish it.
    await runtime.stop()
    for (const file of ['wrangler.jsonc', 'deploy.json']) {
      const path = join(runtime.root, file)
      await writeFile(path, (await readFile(path, 'utf8')).replace(/("crons"\s*:\s*\[)[^\]]*\]/, '$1"* * * * *"]'))
    }
    await runtime.start(runtime.origin)
    owner = api(runtime.origin, await session(runtime.origin, runtime.vars.RER_DEV_KEY, 'owner'))
    for (const deadline = Date.now() + 6 * 60_000; (await owner('GET', `/api/people/${person}/export`)).status !== 404;) {
      assert.ok(Date.now() < deadline, 'the sweep and its queued steps finish the erasure')
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
    const [operation] = await sql(runtime.root, 'SELECT id FROM rer_erasure_operations')
    const { receipt } = (await owner('GET', `/api/erasures/${operation.id}`)).json
    assert.equal(receipt.phase, 'complete')
    assert.deepEqual(receipt.deleted, { people: 1, person_erasure_redactions: 1, person_notes: 300 })
    assert.ok((await owner('GET', '/api/erasures/journal')).json.journal.length >= 2, 'each committed step leaves a journal row')
    assert.equal((await owner('POST', `/api/people/${person}/erasure`, { confirmation: `erase ${person}` })).status, 404)
    const clean = [{ ...reactions[0], users: ['U-KEPT'] }]
    assert.deepEqual((await owner('GET', '/api/people/large-applied-peer/export')).json.person.details.reactions, clean)
    assert.deepEqual((await owner('GET', '/api/people/reacted-29-9/export')).json.person.details.reactions, clean)
    // Erasure withdraws the reviewed snapshot. Applying it again cannot publish
    // its pending source data; rollback removes only this pending plan's effects.
    await assertWithdrawn(owner, plan)
    assert.equal((await owner('GET', '/api/people/large-pending-peer/export')).status, 404)
    await finishDoor(owner, 'undo', plan, 'rolled_back')
    assert.equal((await owner('GET', '/api/people/large-applied-peer/export')).status, 404)
    assert.equal((await owner('GET', '/api/people/large-pending-peer/export')).status, 404)
    assert.deepEqual((await owner('GET', `/api/people/${peer}/export`)).json, beforePeer)
    await runtime.stop()
    assert.deepEqual(await sql(runtime.root, 'SELECT id FROM person_notes'), [], 'all 300 native notes are gone from D1')
    assert.deepEqual(await leftovers(runtime.root, [actor.toLowerCase()]), [], 'no table, original, trace or object still holds the source user id')
    assert.equal((await sql(runtime.root, `SELECT count(*) AS n FROM people WHERE instr(details,'${person}')>0`))[0].n, 0, 'no peer still names the person')
    assert.equal((await sql(runtime.root, "SELECT count(*) AS n FROM people WHERE details LIKE '%U-KEPT%'"))[0].n, 300, 'all 300 reacted peers keep their other reactions')
    t.diagnostic('300 notes + 300 reactions over 30 imports: 202 then queued steps; people=1, person_notes=300; no identifier left; withdrawn pending plan rolled back and all 300 unrelated imported peers preserved')
  } finally { await runtime.close() }
})

test('BASE-DATA-003 person erasure leaves no planted value anywhere, keeps anonymised audit, and old archives are fenced', { timeout: 30 * 60_000 }, async () => {
  const runtime = await freshLocalProject('erasure-owner@example.test')
  try {
    const { root, origin } = runtime, cli = (verb, ...args) => runtime.command(['run', verb, '--', ...args, '--non-interactive'])
    const owner = api(origin, await session(origin, runtime.vars.RER_DEV_KEY, 'owner'))
    const person = (await owner('POST', '/api/people', { name: canary.name, email: canary.email, details: { phone: canary.detail } })).json.id
    const note = (await owner('POST', `/api/people/${person}/notes`, { body: `About ${canary.note}` })).json.id
    const upload = new FormData()
    upload.set('file', new File([`bytes ${canary.body}`], canary.filename, { type: 'text/plain' }))
    const file = (await owner('POST', `/api/people/${person}/files`, upload)).json.id
    assert.ok(person && note && file)
    const labelled = await planPeople(owner, canary.email, [{ ref: 'native-erasure-carol', name: 'Carol Example', email: 'carol@example.test' }])
    const labelledJob = await finishDoor(owner, 'apply', labelled)

    await runtime.stop()
    await cli('export', '--output', 'exports/pre.rer')
    assert.deepEqual(new Set(await archiveLeftovers(root, 'exports/pre.rer')), new Set(planted), 'the pre-erasure archive holds every planted value')
    const audits = (await sql(root, `SELECT id FROM audit_events WHERE entity_id IN ('${person}','${note}','${file}')`)).map((row) => row.id)
    assert.equal(audits.length, 3)

    await runtime.start(origin)
    const operator = api(origin, await session(origin, runtime.vars.RER_DEV_KEY, 'owner'))
    assert.equal((await operator('POST', `/api/people/${person}/erasure`, { confirmation: 'erase' })).status, 400)
    const erased = await operator('POST', `/api/people/${person}/erasure`, { confirmation: `erase ${person}` })
    assert.equal(erased.status, 200)
    const { receipt, journal } = erased.json
    assert.equal(receipt.phase, 'complete')
    assert.ok(receipt.seconds < 300)
    assert.deepEqual(receipt.deleted, { people: 1, person_erasure_redactions: 1, person_files: 1, person_notes: 1 })
    assert.deepEqual(hits(JSON.stringify(receipt)), [])
    assert.equal(journal.jobsRetired, 1, 'an original labelled with the exact erased email retires its whole job')
    assert.ok(journal.stores.some(store => store.store === 'ik_jobs' && store.rows === 1))
    const retired = await door(operator, 'status', { planId: labelled.planId })
    assert.deepEqual([retired.status, retired.json.error], [409, 'plan_custody_mismatch'], 'retired job custody is unavailable through the door')
    assert.equal((await door(operator, 'undo', { planId: labelled.planId })).status, 409)
    const history = await operator('GET', '/api/operator/import-history')
    assert.equal(history.status, 200)
    assert.equal(history.json.history.some(entry => entry.jobId === labelledJob.id), false, 'whole-job retirement removes it from live import history')
    const publicJournal = await operator('GET', '/api/erasures/journal')
    assert.ok(publicJournal.json.journal.some(entry => entry.receiptId === journal.receiptId && entry.jobsRetired === 1), 'the public journal retains the plain retirement receipt')
    assert.equal((await operator('GET', '/api/people/native-erasure-carol/export')).status, 200, 'rows a retired import wrote stay')

    await runtime.stop()

    assert.deepEqual(await leftovers(root), [], 'no planted value in any D1 table or R2 object')
    const directory = join(root, '.wrangler/state/v3/d1/miniflare-D1DatabaseObject')
    const database = new DatabaseSync(join(directory, (await readdir(directory)).find(name => name.endsWith('.sqlite') && name !== 'metadata.sqlite')))
    try {
      assert.deepEqual(database.prepare('SELECT receipt_id FROM ik_d1_retirements WHERE id=?').all(labelledJob.id).map(row => row.receipt_id), [journal.receiptId], 'the whole labelled job has a durable retirement receipt')
      assert.throws(() => database.exec("INSERT OR REPLACE INTO ik_d1_retirements SELECT id,kind,destination,'rewritten',retired_at FROM ik_d1_retirements"), /IMPORT_RETIREMENT_CHANGED/)
    } finally { database.close() }
    const kept = await sql(root, `SELECT entity_id, details FROM audit_events WHERE id IN (${audits.map((id) => `'${id}'`).join(',')})`)
    assert.deepEqual(kept.map((row) => [row.entity_id, row.details]), audits.map(() => [receipt.label, '{}']), 'audit rows survive with the anonymised label')
    await cli('export', '--output', 'exports/post.rer')
    assert.deepEqual(await archiveLeftovers(root, 'exports/post.rer'), [])

    const { sha256, canonicalJson } = await import(pathToFileURL(join(root, 'scripts/base-cli/modules/portability/index.mjs')))
    const source = JSON.parse((await readFile(join(root, 'exports/pre.rer'), 'utf8')).split('\n')[0]).sourceIdentity
    const fenced = async () => {
      const journal = new Set((await sql(root, 'SELECT tombstone FROM rer_portability_journal')).map((row) => row.tombstone))
      for (const [table, id] of [['people', person], ['person_notes', note], ['person_files', file]]) assert.ok(journal.has(await sha256(canonicalJson([source, table, { id }]))), `${table} row is fenced`)
    }
    await refused(cli('import', '--input', 'exports/pre.rer', '--yes'))
    await fenced()
    await cli('reset', '--yes')
    await cli('import', '--input', 'exports/post.rer', '--yes')
    await refused(cli('import', '--input', 'exports/pre.rer', '--yes'))
    await fenced()
    await cli('reset', '--yes')
    await refused(cli('import', '--input', 'exports/pre.rer', '--journal', 'exports/post.rer', '--yes'))
    assert.deepEqual(await sql(root, 'SELECT id FROM people'), [], 'nothing restored past the supplied journal')
  } finally { await runtime.close() }
})

test('BASE-DATA-003 an imported person is erased from import custody; a withdrawn pending door refuses apply and a clean replan applies and undoes; old archives stay fenced', { timeout: 30 * 60_000 }, async (t) => {
  const alice = { name: `Alice${tag}`, email: `alice-${tag}@example.test`, detail: `Phone${tag}`, note: `Note${tag}` }
  const actor = `U-ERASE-${tag}`
  const reactions = Array.from({ length: 15 }, (_, index) => ({ name: `reaction-${index}`, count: 2, users: [actor, 'U-PEER'] }))
  const cleanReactions = reactions.map(reaction => ({ ...reaction, users: ['U-PEER'] }))
  const values = [...Object.values(alice), actor].map((value) => value.toLowerCase())
  const found = (text) => values.filter((value) => text.toLowerCase().includes(value))
  const runtime = await freshLocalProject('import-erasure-owner@example.test')
  try {
    const { root, origin } = runtime, cli = (verb, ...args) => runtime.command(['run', verb, '--', ...args, '--non-interactive'])
    const first = api(origin, await session(origin, runtime.vars.RER_DEV_KEY, 'owner'))
    // One bounded apply writes Alice and Bob while Dave remains pending.
    // The final peer is deliberately beyond the door's twenty-record batch.
    const team = await planPeople(first, 'team.json', [
      { ref: 'alice', name: alice.name, email: alice.email, details: { phone: alice.detail, sourceUserId: actor } },
      { ref: 'bob', name: 'Bob Example', email: 'bob@example.test', details: { reactions } },
      ...Array.from({ length: 18 }, (_, index) => ({ ref: `team-filler-${index}`, name: `Filler ${index}`, email: `team-filler-${index}@example.test` })),
      { ref: 'dave', name: 'Dave Example', email: 'dave@example.test', details: { reactions } }])
    // An archive from while Alice was still pending: no people row of hers to fence.
    await runtime.stop()
    await cli('export', '--output', 'exports/pending.rer')
    await runtime.start(origin)
    const owner = api(origin, await session(origin, runtime.vars.RER_DEV_KEY, 'owner'))
    assert.equal((await applyDoor(owner, team)).json.job.state, 'applying')
    assert.equal((await owner('POST', '/api/people/alice/notes', { body: alice.note })).status, 201)
    assert.equal((await owner('GET', '/api/people/dave/export')).status, 404)
    await runtime.stop()
    await cli('export', '--output', 'exports/pre.rer')
    assert.deepEqual(new Set(found(JSON.stringify(await sql(root, 'SELECT * FROM ik_jobs')))), new Set([alice.name, alice.email, alice.detail, actor].map((value) => value.toLowerCase())), 'import custody holds Alice')

    await runtime.start(origin)
    const operator = api(origin, await session(origin, runtime.vars.RER_DEV_KEY, 'owner'))
    const erased = await operator('POST', '/api/people/alice/erasure', { confirmation: 'erase alice' })
    assert.equal(erased.status, 200)
    const { receipt, journal } = erased.json
    assert.equal(receipt.phase, 'complete')
    assert.deepEqual(receipt.deleted, { people: 1, person_erasure_redactions: 1, person_notes: 1 })
    assert.equal(journal.recordsErased, 1)
    assert.equal(journal.jobsRetired, 0)
    assert.ok(journal.stores.some((store) => store.store === 'ik_jobs' && store.rows === 1), 'the pending job is rewritten without retaining erased values')
    for (const table of ['ik_door_chunks', 'ik_door_uploads', 'ik_door_plan_chunks']) assert.ok(journal.stores.some(store => store.store === table && store.rows > 0), `${table} custody is tallied and withdrawn`)
    assert.deepEqual(found(JSON.stringify(erased.json)), [])
    const bob = await operator('GET', '/api/people/bob/export')
    assert.deepEqual(bob.json.person.details.reactions, cleanReactions, 'Bob keeps all 15 reaction counts while Alice disappears from every user list')
    await runtime.stop()
    assert.deepEqual(await leftovers(root, values), [], 'every table, retained original, journal and object is clear immediately after erasure')
    t.diagnostic('Erasure: 15 peer reaction counts retained; source ID absent from every table, decoded original, journal and object')
    await runtime.start(origin)
    await assertWithdrawn(operator, team)
    assert.equal((await operator('GET', '/api/people/alice/export')).status, 404, 'a withdrawn apply never resurrects Alice')
    assert.equal((await operator('GET', '/api/people/dave/export')).status, 404, 'pending source data is never applied from the withdrawn plan')
    await finishDoor(operator, 'undo', team, 'rolled_back')
    assert.equal((await operator('GET', '/api/people/bob/export')).status, 404)
    const remaining = await planPeople(operator, 'remaining-team.json', [
      { ref: 'bob', name: 'Bob Example', email: 'bob@example.test', details: { reactions: cleanReactions } },
      { ref: 'dave', name: 'Dave Example', email: 'dave@example.test', details: { reactions: cleanReactions } }])
    assert.equal((await operator('GET', '/api/people/dave/export')).status, 404, 'replanning is inert')
    await finishDoor(operator, 'apply', remaining)
    assert.equal((await operator('GET', '/api/people/alice/export')).status, 404)
    assert.deepEqual((await operator('GET', '/api/people/bob/export')).json.person.details.reactions, cleanReactions)
    assert.deepEqual((await operator('GET', '/api/people/dave/export')).json.person.details.reactions, cleanReactions, 'the newly reviewed source contains only redacted peer reactions')
    const report = await door(operator, 'reconcile', { planId: remaining.planId })
    assert.equal(report.status, 200)
    assert.equal(report.json.ok, true)
    await finishDoor(operator, 'undo', remaining)
    assert.equal((await operator('GET', '/api/people/bob/export')).status, 404)
    assert.equal((await operator('GET', '/api/people/dave/export')).status, 404)
    assert.deepEqual((await operator('GET', '/api/erasures/journal')).json.journal.map((entry) => entry.receiptId).slice(-1), [journal.receiptId])
    await runtime.stop()

    assert.deepEqual(await leftovers(root, values), [], 'no Alice value in any D1 table, import custody included, or R2 object')
    t.diagnostic('Withdrawn apply refused; rollback, clean replan, reconcile and undo completed with no erased values restored')
    const database = new DatabaseSync(join(root, '.wrangler/state/v3/d1/miniflare-D1DatabaseObject', (await readdir(join(root, '.wrangler/state/v3/d1/miniflare-D1DatabaseObject'))).find((name) => name.endsWith('.sqlite') && name !== 'metadata.sqlite')))
    try {
      assert.throws(() => database.exec('INSERT OR REPLACE INTO ik_d1_erasure_journal SELECT id,destination,recorded_at,99,jobs_retired,streams_retired,stores_json FROM ik_d1_erasure_journal'), /IMPORT_ERASURE_JOURNAL_APPEND_ONLY/)
      assert.deepEqual(database.prepare('SELECT records_erased FROM ik_d1_erasure_journal WHERE id=?').all(journal.receiptId).map((row) => row.records_erased), [1], 'the journal row cannot be rewritten')
    } finally { database.close() }
    await cli('export', '--output', 'exports/post.rer')
    assert.deepEqual(await archiveLeftovers(root, 'exports/post.rer', values), [])
    await cli('reset', '--yes')
    for (const archive of ['pre', 'pending']) {
      await refused(cli('import', '--input', `exports/${archive}.rer`, '--journal', 'exports/post.rer', '--yes'))
      assert.deepEqual(await sql(root, 'SELECT id FROM people UNION ALL SELECT id FROM ik_jobs'), [], `nothing from ${archive}.rer restored past the supplied journal`)
    }
    await cli('import', '--input', 'exports/post.rer', '--yes')
    assert.deepEqual((await sql(root, "SELECT id FROM people WHERE id IN ('alice','bob','carol') ORDER BY id")).map((row) => row.id), [])
    assert.deepEqual((await sql(root, 'SELECT id FROM ik_d1_erasure_journal')).map((row) => row.id).includes(journal.receiptId), true, 'the journal travels in the archive')
    t.diagnostic('Restore: both pre-erasure archives refused; post-erasure archive and journal restored')
  } catch (error) {
    t.diagnostic(`Journey body failed before cleanup: ${error.code ?? error.name}`)
    throw error
  } finally { await runtime.close() }
})
