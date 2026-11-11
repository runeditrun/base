import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createBusinessSettings } from '../../business-settings/index.ts'
import type { Database, ManagedMember, TeamAdapter } from '../../business-settings/index.ts'
import { signSettings, testDocument, testTrust } from '../../business-settings/testing/index.mjs'

const require = createRequire(new URL('../../../default-seed/package.json', import.meta.url))
const { Miniflare, convertV4MiniflareOptions } = require('miniflare')
const { unstable_splitSqlQuery: split } = require('wrangler')

// A seed whose older release erased a roster person by renaming their roster row to an opaque placeholder
// of its own (`erased:<sha256(address)>`), deleting the native account and keeping the Business member id.
// Base cannot compute that placeholder from the real address; the seed's adapter names it with `retiredForms`.
const who = (slug: string, name: string) => ({ id: slug + '-business-member', email: slug + '-roster@example.test', name })
const keeper = who('keeper', 'Keeper Roster'), canary = who('canary', 'Canary Roster'), newcomer = who('newcomer', 'Newcomer Roster')
const member = (person: typeof canary, invite = 0, id = true) => ({ ...(id ? { id: person.id } : {}), email: person.email, name: person.name, role: 'member', invite })
const hash = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), byte => byte.toString(16).padStart(2, '0')).join('')
const placeholder = async (email: string) => 'erased:' + await hash(email.toLowerCase())

async function seed(t: test.TestContext) {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response(null) } }', compatibilityDate: '2026-09-01', d1Databases: { DB: 'placeholder' } }))
  t.after(() => mf.dispose())
  const db = await mf.getD1Database('DB') as unknown as Database & D1Database
  for (const file of ['0001_business_settings', '0002_business_people', '0003_business_retired'])
    for (const sql of split(await readFile(new URL(`../../business-settings/schema/${file}.sql`, import.meta.url), 'utf8'))) await db.prepare(sql).run()
  await db.prepare('CREATE TABLE hh_users(id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE)').run()
  const invitations: string[] = []
  const team: TeamAdapter & { retiredForms(email: string): Promise<string[]> } = {
    async ownerEmail() { return testTrust().email ?? null },
    async retiredForms(email) { return [await placeholder(email)] },
    async prepare({ members, managed, guard }) {
      const rows: ManagedMember[] = [], statements: ReturnType<Database['prepare']>[] = [], sending: string[] = []
      const alive = async (id: string | null) => !!id && !!await db.prepare('SELECT 1 FROM hh_users WHERE id=?').bind(id).first()
      const gone = (await Promise.all(managed.map(async row => row.operatorId && !await alive(row.operatorId) ? row.operatorId : null))).filter((id): id is string => !!id)
      for (const item of members) {
        // The seed's own check: a listing that its placeholder names is the erased person, never a new account.
        const mark = await placeholder(item.email)
        if (managed.some(row => row.email === mark && gone.includes(row.operatorId!))) continue
        const found = managed.find(row => row.email === item.email)
        if (found?.operatorId) { if (!gone.includes(found.operatorId)) rows.push({ email: item.email, operatorId: found.operatorId, invite: item.invite, state: 'active' }); continue }
        const user = (await db.prepare('SELECT id FROM hh_users WHERE email=?').bind(item.email).first<{ id: string }>())?.id
        if (user) { rows.push({ email: item.email, operatorId: user, invite: item.invite, state: 'active' }); continue }
        const id = crypto.randomUUID()
        statements.push(db.prepare(`INSERT INTO hh_users(id,email) SELECT ?,? WHERE ${guard.sql}`).bind(id, item.email, ...guard.args))
        rows.push({ email: item.email, operatorId: id, invite: item.invite, state: 'invited' }); sending.push(item.email)
      }
      return { statements, rows, gone, afterCommit: async () => { invitations.push(...sending) } }
    },
  }
  const settings = createBusinessSettings({ db, trust: testTrust(), business: { settings: 1, values: ['display_name'], team: { roles: { admin: 'admin', member: 'member' } } }, team })
  let rev = 0
  const send = async (people: unknown[]) => {
    const response = await settings.handle(new Request('https://seed.example.test/api/rer/business-settings', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ settings: await signSettings(testDocument({ rev: ++rev, team: people })) }) }))
    return { status: response!.status, body: await response!.json() as any }
  }
  const count = async (table: string) => (await db.prepare(`SELECT count(*) n FROM ${table}`).first<number>('n'))!
  const text = async () => JSON.stringify([(await db.prepare('SELECT document FROM bs_settings').first<string>('document')), (await db.prepare('SELECT * FROM bs_team').all()).results])
  // The older release's erasure of the canary: placeholder row, native account gone, document entry anonymised.
  const erasedByOlderRelease = async () => {
    const mark = await placeholder(canary.email)
    await db.batch([db.prepare("UPDATE bs_team SET email=?,state='inactive' WHERE business_id=?").bind(mark, canary.id),
      db.prepare("DELETE FROM hh_users WHERE email=?").bind(canary.email),
      db.prepare(`UPDATE bs_settings SET document=json_set(document,'$.team',json((SELECT json_group_array(CASE WHEN json_extract(m.value,'$.id')=? THEN json_set(m.value,'$.name','Former teammate','$.email',?) ELSE json(m.value) END) FROM json_each(document,'$.team') m)))`).bind(canary.id, mark)])
  }
  return { send, count, text, invitations, db, erasedByOlderRelease }
}

async function installed(t: test.TestContext) {
  const s = await seed(t)
  assert.equal((await s.send([member(keeper), member(canary)])).status, 200)
  await s.erasedByOlderRelease()
  assert.equal(await s.count('bs_retired'), 0) // none of this predates the release that stores digests
  s.invitations.length = 0
  return s
}

test('a teammate an older release erased behind an opaque placeholder is not invited again by a Business roster that lists them by address alone', async t => {
  const s = await installed(t)
  const accounts = await s.count('hh_users')
  // The first revision after the upgrade no longer lists them: the adapter reports the row gone, the module retires it.
  assert.equal((await s.send([member(keeper)])).status, 200)
  assert.equal(await s.count('bs_team'), 1)
  // A later revision lists them by their real address, no member id, at the invite number they had.
  const relisted = await s.send([member(keeper), member(canary, 0, false)])
  assert.equal(relisted.status, 200)
  assert.deepEqual(s.invitations, [])
  assert.equal(await s.count('hh_users'), accounts)
  assert.deepEqual(relisted.body.retired, [canary.email])
  const stored = await s.text()
  for (const value of [canary.email, canary.name, canary.id]) assert.ok(!stored.includes(value), 'stored ' + value)
  // The same, a revision later.
  assert.deepEqual((await s.send([member(keeper), member(canary, 0, false)])).body.retired, [canary.email])
  assert.deepEqual(s.invitations, [])
  // The Business's explicit new invitation (a larger invite number) admits them.
  const invitedAgain = await s.send([member(keeper), member(canary, 1, false)])
  assert.equal(invitedAgain.body.retired, undefined)
  assert.deepEqual(s.invitations, [canary.email])
  // The address and the placeholder tombstones are dropped; the Business id's stays at the old invite number.
  assert.equal(await s.count('bs_retired'), 1)
})

test('the first revision after the upgrade that lists the erased teammate by address alone applies them as retired', async t => {
  const s = await installed(t)
  const relisted = await s.send([member(keeper), member(canary, 0, false)])
  assert.equal(relisted.status, 200)
  assert.deepEqual(relisted.body.retired, [canary.email])
  assert.deepEqual(s.invitations, [])
  const stored = await s.text()
  for (const value of [canary.email, canary.name]) assert.ok(!stored.includes(value), 'stored ' + value)
  assert.deepEqual((await s.send([member(keeper), member(canary, 0, false)])).body.retired, [canary.email])
  assert.deepEqual(s.invitations, [])
})

test('listing the erased teammate with their Business id, at the same or another address, and a new person, behave as before', async t => {
  const s = await installed(t)
  // (a) the Business member id, at the address.
  const byId = await s.send([member(keeper), member(canary)])
  assert.deepEqual(byId.body.retired, [canary.email]); assert.deepEqual(s.invitations, [])
  // (c) the same Business id at a new address.
  const moved = { ...member(canary), email: 'canary-moved@example.test' }
  assert.deepEqual((await s.send([member(keeper), moved])).body.retired, [moved.email]); assert.deepEqual(s.invitations, [])
  // (b) the real address alone.
  assert.deepEqual((await s.send([member(keeper), member(canary, 0, false)])).body.retired, [canary.email]); assert.deepEqual(s.invitations, [])
  // A genuinely new person, another address and another invite number, is unaffected.
  const fresh = await s.send([member(keeper), member(canary), member(newcomer, 3)])
  assert.deepEqual(fresh.body.retired, [canary.email]); assert.deepEqual(s.invitations, [newcomer.email])
  assert.deepEqual(fresh.body.team.map((item: any) => item.email).sort(), [keeper.email, newcomer.email])
})
