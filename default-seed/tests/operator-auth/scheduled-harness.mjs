import assert from 'node:assert/strict'
import { emittedRuntime } from './emitted-runtime.mjs'
import { createOperatorAuth } from '../../../modules/operator-auth/service.mjs'
import { createAuthHandler } from '../../../modules/operator-auth/routes.mjs'
import { withDevIdentity } from '../../../modules/operator-auth/dev/index.mjs'
import { configure } from '../../../modules/operator-auth/config.mjs'
import { hashToken, opaqueToken } from '../../../modules/operator-auth/crypto.mjs'
import { policyVersion } from '../../../modules/operator-auth/scheduled/definition.mjs'
import { AuthError } from '../../../modules/operator-auth/errors.mjs'

export const day = 86400000
export const definition = (overrides = {}) => ({
  id: 'inactive-members', kind: 'deactivate-members-without-recent-signin.v1',
  parameters: { inactiveDays: 90 }, maxActionsPerRun: 25, minIntervalMinutes: 10,
  actions: [{ action: 'operators:deactivate', scope: { roles: ['member'], inactiveDays: 90 } }],
  ...overrides,
})

// The implementation runs in the host so policies, the clock and rolePolicy can
// vary. Its persistence is the emitted app's real workerd D1, with all migrations.
export async function scheduledHarness({ definitions = () => [definition()], rolePolicy } = {}) {
  const runtime = await emittedRuntime({ noMail: true })
  const db = runtime.db, mails = []
  let now = Date.now()
  const clock = () => now
  const config = configure({ origin: runtime.origin, local: true,
    OWNER_EMAIL: 'owner@example.test', SESSION_SECRET: 'scheduled-refusal-test-only-session-secret-00001',
    MAIL_FROM: 'Auth <auth@example.test>', review: { enabled: true, operatorEmail: 'owner@example.test' } })
  const auth = createOperatorAuth({ db, config, clock, clientIp: () => '127.0.0.1',
    scheduledPolicies: definitions, ...(rolePolicy ? { rolePolicy } : {}),
    mailSender: { async send(message) { mails.push(message); return { status: 'accepted' } } },
  })
  const handle = createAuthHandler(auth)
  const devKey = 'scheduled-refusal-test-only-dev-key-00000000000000000001'
  const worker = withDevIdentity({ fetch: request => handle(request) }, { config: () => config })
  const env = { DB: db, AUTH_ORIGIN: runtime.origin, AUTH_LOCAL: 'true', RER_DEV_KEY: devKey }
  function request(path, cookie, { method = 'POST', input, headers = {} } = {}) {
    return new Request(runtime.origin + path, { method, headers: {
      host: new URL(runtime.origin).host, origin: runtime.origin, 'x-rer-dev-key': devKey,
      ...(cookie ? { cookie } : {}), ...(input === undefined ? {} : { 'content-type': 'application/json' }), ...headers,
    }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) })
  }
  const call = (path, options = {}) => worker.fetch(request(path, options.cookie, { method: 'GET', ...options }), env, {})
  const post = (path, input, cookie) => call(path, { method: 'POST', input, cookie })
  const json = async response => {
    assert.equal(response.status, 200, await response.clone().text())
    return response.json()
  }
  async function sessionFor(person, { sessionDaysAgo = 0, sessionKind = 'native', proof = true } = {}) {
    const token = opaqueToken(), id = crypto.randomUUID(), createdAt = now - sessionDaysAgo * day
    let sourceToken = null
    // A new native session alone is not proof. Link it to the actual consumed
    // magic-link provenance, as a native email-link confirmation does.
    if (sessionKind === 'native' && proof) {
      sourceToken = crypto.randomUUID()
      await db.prepare(`INSERT INTO oa_tokens(id,token_hash,kind,operator_id,operator_version,return_to,created_at,expires_at,consumed_at)
        VALUES(?,?,'magic',?,1,'/app',?,?,?)`).bind(sourceToken, await hashToken(config.SESSION_SECRET, 'link', opaqueToken()), person.id, createdAt, createdAt + 900000, createdAt).run()
    }
    await db.prepare(`INSERT INTO oa_sessions(id,token_hash,operator_id,operator_version,kind,source_token_id,created_at,expires_at)
      VALUES(?,?,?,1,?,?,?,?)`).bind(id, await hashToken(config.SESSION_SECRET, 'session', token), person.id, sessionKind, sourceToken, createdAt, now + 7 * day).run()
    return { id, cookie: `${config.cookieName}=${token}` }
  }
  async function person(email, role, { createdDaysAgo = 200, status = 'active', sessionDaysAgo = null, sessionKind = 'native', proof = true } = {}) {
    const record = { id: crypto.randomUUID(), cookie: null }
    await db.prepare('INSERT INTO oa_operators(id,email,display_name,role,status,created_at) VALUES(?,?,?,?,?,?)')
      .bind(record.id, email, email, role, status, now - createdDaysAgo * day).run()
    if (sessionDaysAgo !== null) record.cookie = (await sessionFor(record, { sessionDaysAgo, sessionKind, proof })).cookie
    return record
  }
  async function approvalInput(policyId = 'inactive-members') {
    return { policyId, versionHash: (await policyVersion(definitions().find(policy => policy.id === policyId))).versionHash }
  }
  const approveAs = async cookie => json(await post('/auth/policy/approve', await approvalInput(), cookie))
  const history = async (cookie, suffix = '') => json(await call('/auth/policy-runs' + suffix, { cookie }))
  const lastRun = () => db.prepare('SELECT * FROM oa_policy_runs ORDER BY rowid DESC LIMIT 1').first()
  const status = async id => (await db.prepare('SELECT status FROM oa_operators WHERE id=?').bind(id).first()).status
  async function runWith(callback, policyId = 'inactive-members') {
    try { await auth.scheduledPolicies.run(policyId, callback) } catch (error) { if (!(error instanceof AuthError)) throw error }
    return lastRun()
  }
  const code = async operation => { try { await operation; return 'ok' } catch (error) { if (!(error instanceof AuthError)) throw error; return error.code } }
  return { db, auth, person, sessionFor, request, call, post, json, approvalInput, approveAs, history, lastRun, status, runWith, code,
    mails, clock, advance: milliseconds => { now += milliseconds }, close: () => runtime.close() }
}
