import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createBusinessSettings } from '../../business-settings/index.ts'
import type { Database, ManagedMember, TeamAdapter } from '../../business-settings/index.ts'
import { signSettings, testDocument, testTrust } from '../../business-settings/testing/index.mjs'
import { runtime } from './runtime.mjs'
import { agentErasureStatements } from '../erasure.ts'
import { operatorPolicyRefs } from '../index.ts'
import { personAgentArtifacts } from '../../../default-seed/src/agent-door/erasure.ts'
import { createPortability } from '../../portability/index.mjs'

const require = createRequire(new URL('../../../default-seed/package.json', import.meta.url))
const { Miniflare, convertV4MiniflareOptions } = require('miniflare')
const { unstable_splitSqlQuery: split } = require('wrangler')

// A person invited through signed Business settings and later erased leaves nothing of themselves in
// the Business roster, and the Business's own next revision cannot bring them back.
const canary = { id: 'canary-business-member-7f3a', email: 'canary-roster-7f3a@example.test', name: 'Canary Roster Seven' }
const keeper = { id: 'keeper-business-member-91c2', email: 'keeper-roster-91c2@example.test', name: 'Keeper Roster Nine' }
// Not the Business roster: the native audit of an id-only action and the test harness's captured outbox.
const outsideRoster = new Set(['oa_auth_audit', 'test_mail'])
const member = (who: typeof canary, invite = 0) => ({ ...who, role: 'admin', invite })

async function dump(db: D1Database) {
  const tables = (await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all<{ name: string }>()).results
  return Object.fromEntries(await Promise.all(tables.map(async ({ name }) => [name, JSON.stringify((await db.prepare('SELECT * FROM "' + name + '"').all()).results)])))
}
const mailCount = async (db: D1Database, email: string) => await db.prepare('SELECT count(*) n FROM test_mail WHERE email=?').bind(email).first<number>('n')

// The seed's native erasure batch: Base's agent erasure statements, then the seed's own native deletions.
// The seed does not touch bs_*; retiring the roster is Base's rule inside agentErasureStatements.
async function eraseOperator(r: any, operator: string) {
  const portability = await createPortability({ db: r.db, policy: { product: 'roster-erasure-test', buckets: {}, excludeTables: ['test_contexts', 'test_callbacks'] } })
  const map = { artifacts: personAgentArtifacts.artifacts.map(item => item.table === 'agent_door_state'
    ? { table: item.table, columns: item.columns, retire: { refs: 'refs' } }
    : item.match ? { table: item.table, columns: item.columns, match: { sql: '0', params: [] } } : item) }
  const tombstone = { erasure_id: crypto.randomUUID(), at: new Date().toISOString() }
  const statements = await agentErasureStatements({ db: r.db, map, secret: r.secret, tombstone,
    subject: { refs: JSON.stringify(await operatorPolicyRefs(r.db, operator)) }, checkpoint: () => portability.redactionStatements() })
  await r.db.batch([...statements,
    r.db.prepare('DELETE FROM oa_sessions WHERE operator_id=?').bind(operator),
    r.db.prepare('DELETE FROM oa_tokens WHERE operator_id=? OR issuer_id=?').bind(operator, operator),
    r.db.prepare('DELETE FROM oa_operators WHERE id=?').bind(operator)])
  return tombstone
}

test('erasing an operator retires them from the Business roster; the Business cannot silently bring them back', async t => {
  const r = await runtime({ paired: true, erasure: true }); t.after(() => r.close())
  const invited = await r.settings({ team: [member(keeper), member(canary)] })
  assert.equal(invited.status, 200)
  await r.signIn(keeper.email); await r.signIn(canary.email)
  const operator = (await r.db.prepare('SELECT operator_id FROM bs_team WHERE business_id=?').bind(canary.id).first<string>('operator_id'))!
  const keeperOperator = (await r.db.prepare('SELECT operator_id FROM bs_team WHERE business_id=?').bind(keeper.id).first<string>('operator_id'))!
  assert.ok(operator && keeperOperator)

  await eraseOperator(r, operator)

  // (a) No canary name, email, native id or Business id anywhere in the database, outside the
  // seed's own native stores.
  const everything = await dump(r.db)
  for (const [table, text] of Object.entries(everything)) {
    if (outsideRoster.has(table)) continue
    for (const value of [canary.name, canary.email, canary.id, operator]) assert.ok(!text.includes(value), table + ' still holds ' + value)
  }

  // (b) The remaining roster is intact and still works.
  assert.deepEqual((await r.db.prepare('SELECT email,operator_id,business_id FROM bs_team ORDER BY email').all()).results,
    [{ email: keeper.email, operator_id: keeperOperator, business_id: keeper.id }])
  assert.deepEqual(JSON.parse((await r.db.prepare('SELECT document FROM bs_settings').first<string>('document'))!).team, [member(keeper)])
  await r.signIn(keeper.email)
  const kept = await r.settings({ team: [member(keeper)], values: { display_name: 'Still Verified' } })
  assert.equal(kept.status, 200); assert.deepEqual(kept.body.team, [{ email: keeper.email, state: 'active' }]); assert.equal(kept.body.retired, undefined)

  // (c) The Business, which still lists the erased person, re-applies as retired: everyone else is applied,
  // the erased person gets no operator, no invitation and no row, and nothing of them is stored again.
  const mails = await mailCount(r.db, canary.email), operators = (await r.db.prepare('SELECT count(*) n FROM oa_operators').first<number>('n'))!
  const relisted = await r.settings({ team: [member(keeper), member(canary)], values: { display_name: 'Relisted' } })
  assert.equal(relisted.status, 200)
  assert.deepEqual(relisted.body.retired, [canary.email]); assert.deepEqual(relisted.body.team, [{ email: keeper.email, state: 'active' }])
  assert.equal(await mailCount(r.db, canary.email), mails)
  assert.equal(await r.db.prepare('SELECT count(*) n FROM oa_operators').first<number>('n'), operators)
  const after = await dump(r.db)
  for (const [table, text] of Object.entries(after)) {
    if (outsideRoster.has(table)) continue
    for (const value of [canary.name, canary.email, canary.id]) assert.ok(!text.includes(value), table + ' holds ' + value + ' after re-listing')
  }
  assert.equal(JSON.parse((await r.db.prepare('SELECT document FROM bs_settings').first<string>('document'))!).values.display_name, 'Relisted')
  // Re-listing under only the Business id, or only the address, is the same person.
  assert.deepEqual((await r.settings({ team: [member(keeper), { ...member(canary), email: 'other-address-7f3a@example.test' }] })).body.retired, ['other-address-7f3a@example.test'])
  const noId = await r.settings({ team: [member(keeper), { email: canary.email, name: 'Someone', role: 'member', invite: 0 }] })
  assert.deepEqual(noId.body.retired, [canary.email])

  // A new explicit invitation (a larger invite number, the Business's re-invite request) admits them again.
  const invitedAgain = await r.settings({ team: [member(keeper), member(canary, 1)] })
  assert.equal(invitedAgain.status, 200); assert.equal(invitedAgain.body.retired, undefined)
  assert.deepEqual(invitedAgain.body.team, [{ email: canary.email, state: 'invited' }, { email: keeper.email, state: 'active' }])
  assert.equal(await mailCount(r.db, canary.email), mails + 1)
  assert.equal(await r.db.prepare('SELECT count(*) n FROM bs_retired').first<number>('n'), 0)
})

test('the roster rule refuses an unaccounted Business table and an erasure of a person outside the roster changes nothing', async t => {
  const r = await runtime({ paired: true, erasure: true }); t.after(() => r.close())
  assert.equal((await r.settings({ team: [member(keeper)] })).status, 200)
  const owner = (await r.db.prepare("SELECT id FROM oa_operators WHERE role='owner'").first<string>('id'))!
  const before = await dump(r.db)
  // Owner erasure is outside the roster rule: nothing in bs_* moves.
  const refs = JSON.stringify(await operatorPolicyRefs(r.db, owner))
  const portability = await createPortability({ db: r.db, policy: { product: 'roster-erasure-test', buckets: {}, excludeTables: ['test_contexts', 'test_callbacks'] } })
  const map = { artifacts: personAgentArtifacts.artifacts.map(item => item.table === 'agent_door_state'
    ? { table: item.table, columns: item.columns, retire: { refs: 'refs' } } : item.match ? { table: item.table, columns: item.columns, match: { sql: '0', params: [] } } : item) }
  const compile = () => agentErasureStatements({ db: r.db, map, secret: r.secret, tombstone: { erasure_id: crypto.randomUUID(), at: new Date().toISOString() }, subject: { refs }, checkpoint: () => portability.redactionStatements() })
  await r.db.batch(await compile())
  const unchanged = await dump(r.db)
  for (const table of ['bs_team', 'bs_settings', 'bs_retired']) assert.equal(unchanged[table], before[table], table)
  await r.db.prepare('CREATE TABLE bs_unaccounted(email TEXT)').run()
  await assert.rejects(compile(), /business_roster_undeclared_table:bs_unaccounted/)
})

test('a person an older release erased (native account gone, roster row left) is retired at runtime and the Business cannot invite them again', async t => {
  const r = await runtime({ paired: true, erasure: true }); t.after(() => r.close())
  assert.equal((await r.settings({ team: [member(keeper), member(canary)] })).status, 200)
  await r.signIn(keeper.email); await r.signIn(canary.email)
  const operator = (await r.db.prepare('SELECT operator_id FROM bs_team WHERE business_id=?').bind(canary.id).first<string>('operator_id'))!
  // Erased by an older Base: the native rows are gone, the roster is untouched and no tombstone exists.
  await r.db.batch([r.db.prepare('DELETE FROM oa_sessions WHERE operator_id=?').bind(operator),
    r.db.prepare('DELETE FROM oa_tokens WHERE operator_id=? OR issuer_id=?').bind(operator, operator),
    r.db.prepare('DELETE FROM oa_operators WHERE id=?').bind(operator)])
  assert.ok((await dump(r.db)).bs_team.includes(canary.email))
  const keeperRow = await r.db.prepare('SELECT * FROM bs_team WHERE email=?').bind(keeper.email).first()
  const mails = await mailCount(r.db, canary.email), operators = (await r.db.prepare('SELECT count(*) n FROM oa_operators').first<number>('n'))!

  // The Business's next ordinary revision still lists them: not re-created, not mailed, and the row goes.
  const next = await r.settings({ team: [member(keeper), member(canary)], values: { display_name: 'Next' } })
  assert.equal(next.status, 200)
  assert.deepEqual(next.body.retired, [canary.email]); assert.deepEqual(next.body.team, [{ email: keeper.email, state: 'active' }])
  assert.equal(await mailCount(r.db, canary.email), mails)
  assert.equal(await r.db.prepare('SELECT count(*) n FROM oa_operators').first<number>('n'), operators)
  for (const [table, text] of Object.entries(await dump(r.db))) {
    if (outsideRoster.has(table)) continue
    for (const value of [canary.name, canary.email, canary.id, operator]) assert.ok(!text.includes(value), table + ' holds ' + value)
  }
  assert.deepEqual(await r.db.prepare('SELECT * FROM bs_team WHERE email=?').bind(keeper.email).first(), { ...keeperRow, state: 'active' })
  assert.deepEqual(JSON.parse((await r.db.prepare('SELECT document FROM bs_settings').first<string>('document'))!).team, [member(keeper)])
  // And the revision after that.
  const again = await r.settings({ team: [member(keeper), member(canary)] })
  assert.deepEqual(again.body.retired, [canary.email]); assert.equal(await mailCount(r.db, canary.email), mails)
  // A larger invite number is the Business's explicit new invitation.
  const invitedAgain = await r.settings({ team: [member(keeper), member(canary, 1)] })
  assert.equal(invitedAgain.status, 200); assert.equal(invitedAgain.body.retired, undefined)
  assert.equal(await mailCount(r.db, canary.email), mails + 1)
})

// A seed with its own roster adapter (Oncall: `oc_members` ids) that also has `oa_operators`. Base never reads
// `oa_operators` for the roster: only an id its own adapter reports gone is retired, in its own id space.
test('a seed with its own accounts table keeps every live roster row byte for byte; only what its adapter reports gone is retired', async t => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response(null) } }', compatibilityDate: '2026-09-01', d1Databases: { DB: 'own-adapter' } }))
  t.after(() => mf.dispose())
  const db = await mf.getD1Database('DB') as unknown as Database & D1Database
  const sqlOf = async (file: string) => split(await readFile(new URL(file, import.meta.url), 'utf8'))
  for (const file of ['../../operator-auth/accounts/schema/operator-auth.sql', '../../business-settings/schema/0001_business_settings.sql', '../../business-settings/schema/0002_business_people.sql', '../../business-settings/schema/0003_business_retired.sql'])
    for (const sql of await sqlOf(file)) await db.prepare(sql).run()
  await db.prepare('CREATE TABLE oc_members(id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE)').run()
  // `oa_operators` exists and holds ids unrelated to the roster's.
  await db.prepare("INSERT INTO oa_operators(id,email,display_name,role,status,version,created_at) VALUES('oa-owner','owner@example.test','Owner','owner','active',0,'2026-01-01')").run()
  const team: TeamAdapter = {
    async ownerEmail() { return testTrust().email ?? null },
    async prepare({ members, managed }) {
      const gone: string[] = [], rows: ManagedMember[] = []
      for (const row of managed) if (row.operatorId && !await db.prepare('SELECT 1 FROM oc_members WHERE id=?').bind(row.operatorId).first()) gone.push(row.operatorId)
      for (const item of members) {
        const found = await db.prepare('SELECT id FROM oc_members WHERE email=?').bind(item.email).first<{ id: string }>()
        if (found) rows.push({ email: item.email, operatorId: found.id, invite: item.invite, state: 'active' })
      }
      return { statements: [], rows, gone, afterCommit: async () => {} }
    },
  }
  const settings = createBusinessSettings({ db, trust: testTrust(), business: { settings: 1, values: ['display_name'], team: { roles: { admin: 'admin', member: 'member' } } }, team })
  let rev = 0
  const send = async (people: unknown[]) => {
    const response = await settings.handle(new Request('https://seed.example.test/api/rer/business-settings', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ settings: await signSettings(testDocument({ rev: ++rev, team: people })) }) }))
    return { status: response!.status, body: await response!.json() as any }
  }
  const people = [keeper, canary, { id: 'third-business-member-55aa', email: 'third-roster-55aa@example.test', name: 'Third Roster' }].map(who => member(who))
  for (const person of people) await db.prepare('INSERT INTO oc_members(id,email) VALUES(?,?)').bind('oc-' + person.id, person.email).run()
  assert.equal((await send(people)).status, 200)
  // The state an installation is in before this release: the module's tables as shipped then, none of them touched by 0044.
  await db.prepare('DROP TABLE bs_retired').run()
  const rowsBefore = (await db.prepare('SELECT * FROM bs_team ORDER BY email').all()).results
  const documentBefore = JSON.parse((await db.prepare('SELECT document FROM bs_settings').first<string>('document'))!).team
  assert.equal(rowsBefore.length, 3)
  const migration = await readFile(new URL('../../../default-seed/migrations/core/0044_business_retired.sql', import.meta.url), 'utf8')
  for (const sql of split(migration)) await db.prepare(sql).run()
  assert.deepEqual((await db.prepare('SELECT * FROM bs_team ORDER BY email').all()).results, rowsBefore)
  assert.deepEqual(JSON.parse((await db.prepare('SELECT document FROM bs_settings').first<string>('document'))!).team, documentBefore)

  // The runtime over live members: the same rows and entries, nothing retired.
  const live = await send(people)
  assert.equal(live.status, 200); assert.equal(live.body.retired, undefined)
  assert.deepEqual((await db.prepare('SELECT * FROM bs_team ORDER BY email').all()).results, rowsBefore)
  assert.deepEqual(JSON.parse((await db.prepare('SELECT document FROM bs_settings').first<string>('document'))!).team, documentBefore)
  assert.equal(await db.prepare('SELECT count(*) n FROM bs_retired').first<number>('n'), 0)

  // The adapter's own check finds one member gone: that person alone is retired, in the apply batch.
  await db.prepare('DELETE FROM oc_members WHERE id=?').bind('oc-' + canary.id).run()
  const after = await send(people)
  assert.equal(after.status, 200); assert.deepEqual(after.body.retired, [canary.email])
  assert.deepEqual((await db.prepare('SELECT * FROM bs_team ORDER BY email').all()).results, rowsBefore.filter((row: any) => row.email !== canary.email))
  assert.deepEqual(JSON.parse((await db.prepare('SELECT document FROM bs_settings').first<string>('document'))!).team, documentBefore.filter((item: any) => item.email !== canary.email))
  assert.equal(await db.prepare('SELECT count(*) n FROM bs_retired').first<number>('n'), 2) // the address and the Business id
})
