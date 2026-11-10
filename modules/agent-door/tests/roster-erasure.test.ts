import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runtime } from './runtime.mjs'
import { agentErasureStatements } from '../erasure.ts'
import { operatorPolicyRefs } from '../index.ts'
import { personAgentArtifacts } from '../../../default-seed/src/agent-door/erasure.ts'
import { createPortability } from '../../portability/index.mjs'

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

test('an existing database that already holds an erased person migrates: the roster rows are purged without the plaintext', async t => {
  const r = await runtime({ paired: true, erasure: true }); t.after(() => r.close())
  assert.equal((await r.settings({ team: [member(keeper), member(canary)] })).status, 200)
  await r.signIn(keeper.email); await r.signIn(canary.email)
  const operator = (await r.db.prepare('SELECT operator_id FROM bs_team WHERE business_id=?').bind(canary.id).first<string>('operator_id'))!
  // Erased by an older Base: the native rows are gone, the roster is untouched, and the new table does not exist yet.
  await r.db.batch([r.db.prepare('DELETE FROM oa_sessions WHERE operator_id=?').bind(operator),
    r.db.prepare('DELETE FROM oa_tokens WHERE operator_id=? OR issuer_id=?').bind(operator, operator),
    r.db.prepare('DELETE FROM oa_operators WHERE id=?').bind(operator), r.db.prepare('DROP TABLE bs_retired')])
  assert.ok((await dump(r.db)).bs_team.includes(canary.email))
  const migration = await readFile(new URL('../../../default-seed/migrations/core/0044_business_retired.sql', import.meta.url), 'utf8')
  for (const sql of migration.split(/;\s*\n/).map(part => part.trim()).filter(Boolean)) await r.db.prepare(sql).run()
  for (const [table, text] of Object.entries(await dump(r.db))) {
    if (outsideRoster.has(table)) continue
    for (const value of [canary.name, canary.email, canary.id, operator]) assert.ok(!text.includes(value), table + ' still holds ' + value)
  }
  assert.deepEqual((await r.db.prepare('SELECT email FROM bs_team').all()).results, [{ email: keeper.email }])
  assert.deepEqual(JSON.parse((await r.db.prepare('SELECT document FROM bs_settings').first<string>('document'))!).team, [member(keeper)])
})
