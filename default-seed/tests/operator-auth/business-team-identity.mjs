import assert from 'node:assert/strict'
import { emittedRuntime, owner, setupToken } from './emitted-runtime.mjs'
import { signSettings, testDocument, testTrust } from '../../../modules/business-settings/testing/index.mjs'

export const teamIdentityRows = []


const tokenOf = mail => new URL(mail.text.match(/https?:\/\/\S+/)[0]).searchParams.get('token')
const cookieOf = response => {
  assert.equal(response.status, 303)
  return response.headers.get('set-cookie').split(';')[0]
}

// The native email-change door must not let a Business-created identity escape
// its durable roster key, even when a human or the owner takes that old address.
teamIdentityRows.push(['Business removal and re-addition follow operator IDs after native email changes', {}, async () => {
  const runtime = await emittedRuntime({ bindings: { RER_BUSINESS_TRUST: JSON.stringify(testTrust({ email: undefined })) } })
  let rev = 0, ownerEmail = owner
  const member = { email: 'sam@example.test', name: 'Sam Chen', role: 'member', invite: 0 }
  const operator = id => runtime.db.prepare('SELECT * FROM oa_operators WHERE id=?').bind(id).first()
  const ledger = email => runtime.db.prepare('SELECT * FROM bs_team WHERE email=?').bind(email).first()
  async function post(team) {
    const response = await runtime.call('/api/rer/business-settings', { method: 'POST', input: {
      settings: await signSettings(testDocument({ rev: ++rev, email: ownerEmail, team })),
    } })
    assert.equal(response.status, 200)
    return response.json()
  }
  async function changeEmail(cookie, email) {
    assert.equal((await runtime.call('/auth/step-up', { method: 'POST', cookie, input: { action: 'email:change' } })).status, 202)
    assert.equal((await runtime.call('/auth/confirm', { method: 'POST', cookie, input: { token: tokenOf(runtime.mails.at(-1)) } })).status, 303)
    assert.equal((await runtime.call('/auth/email', { method: 'POST', cookie, input: { email } })).status, 200)
  }
  async function joinAndRename(entry, email) {
    await post([entry])
    const cookie = cookieOf(await runtime.call('/auth/confirm', { method: 'POST', input: { token: tokenOf(runtime.mails.at(-1)) } }))
    const { operator_id: id } = await ledger(entry.email)
    await changeEmail(cookie, email)
    assert.equal((await operator(id)).email, email)
    assert.equal((await runtime.call('/api/work', { cookie })).status, 200)
    return { cookie, id }
  }
  async function remove(entry, identity) {
    await post([])
    assert.equal((await operator(identity.id)).status, 'inactive')
    const managed = await ledger(entry.email)
    assert.equal(managed.operator_id, identity.id)
    assert.equal(managed.state, 'inactive')
    assert.equal((await runtime.call('/api/work', { cookie: identity.cookie })).status, 401)
    await post([])
    assert.deepEqual(await ledger(entry.email), managed)
  }
  try {
    const ownerCookie = cookieOf(await runtime.call('/auth/bootstrap', { method: 'POST', input: { token: setupToken, displayName: 'Alex Rivera' } }))
    const renamed = await joinAndRename(member, 'sam-renamed@example.test')
    // This account was invited manually, after Business's account vacated the
    // roster address. Its entire row must survive removal and later role edits.
    assert.equal((await runtime.call('/auth/invite', { method: 'POST', cookie: ownerCookie, input: {
      email: member.email, displayName: 'Human-managed colleague', role: 'member',
    } })).status, 202)
    const human = await runtime.db.prepare('SELECT * FROM oa_operators WHERE email=?').bind(member.email).first()
    await remove(member, renamed)
    const readded = await post([{ ...member, role: 'admin' }])
    assert.equal(readded.team.find(row => row.email === member.email).state, 'active')
    assert.equal((await operator(renamed.id)).role, 'admin')
    assert.equal((await ledger(member.email)).operator_id, renamed.id)
    assert.deepEqual(await operator(human.id), human)
    await remove(member, renamed)
    assert.deepEqual(await operator(human.id), human)

    const ownerKey = { ...member, email: 'former-member@example.test' }
    const second = await joinAndRename(ownerKey, 'another-renamed@example.test')
    await changeEmail(ownerCookie, ownerKey.email)
    ownerEmail = ownerKey.email
    const ownerBefore = await runtime.db.prepare("SELECT * FROM oa_operators WHERE role='owner'").first()
    await remove(ownerKey, second)
    await post([{ ...ownerKey, role: 'admin' }])
    assert.equal((await operator(second.id)).status, 'active')
    assert.equal((await operator(second.id)).role, 'admin')
    assert.deepEqual(await operator(ownerBefore.id), ownerBefore)
    assert.deepEqual(await operator(human.id), human)
  } finally { await runtime.close() }
}])
