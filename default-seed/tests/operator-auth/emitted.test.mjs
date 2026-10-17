import { completeFirstRun } from './first-run.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { emittedRuntime, root, owner, setupToken, decodeStart } from './emitted-runtime.mjs'
import { startTogether } from '../ports.mjs'

export const cookieOf = (response) => { assert.equal(response.status, 303); return response.headers.get('set-cookie').split(';')[0] }
export async function functionId(name) {
  for (const file of await readdir(join(root, 'dist/server/assets'))) {
    if (!file.startsWith('loaders-') || !file.endsWith('.js')) continue
    const source = await readFile(join(root, 'dist/server/assets', file), 'utf8')
    const match = source.match(new RegExp(`id: "([a-f0-9]{64})",\\n\\s*name: "${name}"`))
    if (match) return match[1]
  }
  throw new Error(`No emitted server function ${name}`)
}

async function matrix(runtime, cookie, allowed) {
  for (const path of ['/api/work', '/api/work/unknown/deep']) {
    const response = await runtime.call(path, { cookie })
    assert.equal(response.status, allowed ? (path === '/api/work' ? 200 : 404) : 401)
    if (!allowed) assert.deepEqual(await response.json(), { error: 'authentication required' })
    if (allowed && path === '/api/work') assert.deepEqual(Object.keys(await response.json()).sort(), ['latestJob', 'latestSchedule'])
  }
  const document = await runtime.call('/app', { cookie })
  assert.equal(document.status, allowed ? 200 : 307)
  if (!allowed) { assert.equal(document.headers.get('location'), '/signin?returnTo=%2Fapp'); assert.equal(await document.text(), '') }
  for (const name of ['requireOperator', 'loadPrivateDashboard']) {
    const response = await runtime.call(`/_serverFn/${await functionId(name)}`, {
      cookie, headers: { 'x-tsr-serverFn': 'true', accept: 'application/json', origin: runtime.origin, 'sec-fetch-site': 'same-origin' },
    })
    const body = await response.text()
    assert.equal(response.status, 200)
    if (allowed) {
      assert.equal(response.headers.get('x-tss-serialized'), 'true')
      assert.match(response.headers.get('content-type'), /application\/json/)
      const decoded = decodeStart(body)
      assert.ok(decoded.result)
      if (name === 'requireOperator') assert.equal(decoded.result.operator.email, owner)
      else assert.ok(Object.hasOwn(decoded.result, 'latestJob'))
      assert.match(body, name === 'requireOperator' ? /owner@example.test/ : /latestJob/)
      assert.doesNotMatch(body, /\/signin/)
    } else {
      assert.match(body, /\/signin\?returnTo=%2Fapp/)
      assert.doesNotMatch(body, /latestJob|latestSchedule|owner@example.test/)
    }
  }
}

test('emitted Worker: fresh D1, bootstrap without mail, private session transport matrix, revoke, queue and cron', async () => {
  const runtime = await emittedRuntime({ noMail: true })
  try {
    for (const table of ['operators', 'articles', 'jobs', 'oa_operators']) assert.equal((await runtime.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n, 0)
    await matrix(runtime, undefined, false)
    const bootstrap = await runtime.call('/auth/bootstrap', { method: 'POST', input: { token: setupToken, displayName: 'Test Owner' } })
    const cookie = cookieOf(bootstrap)
    assert.match(bootstrap.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/)
    assert.equal(runtime.mails.length, 0)
    for (const name of ['requireOperator', 'loadPrivateDashboard']) {
      const response = await runtime.call(`/_serverFn/${await functionId(name)}`, { cookie, headers: { 'x-tsr-serverFn': 'true', accept: 'application/json', origin: runtime.origin, 'sec-fetch-site': 'same-origin' } })
      const body = await response.text()
      assert.equal(JSON.parse(body).href, '/setup', 'unfinished owner direct private RPC leads to setup')
      assert.doesNotMatch(body, /latestJob|latestSchedule|owner@example.test/)
    }
    await completeFirstRun(runtime.origin, cookie)
    await matrix(runtime, cookie, true)
    const work = await runtime.call('/api/work', { method: 'POST', cookie })
    assert.equal(work.status, 202)
    const { id } = await work.json()
    let state
    for (let i = 0; i < 50; i++) {
      state = await runtime.call(`/api/work/${id}`, { cookie }).then((response) => response.json())
      if (state.state === 'completed') break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.equal(state.state, 'completed')
    const worker = await runtime.mf.getWorker()
    await worker.scheduled({ cron: '*/10 * * * *' })
    assert.equal((await runtime.db.prepare('SELECT count(*) AS n FROM scheduled_runs').first()).n, 1)
    for (const headers of [{ origin: 'https://attacker.test' }, { origin: '' }]) assert.equal((await runtime.call('/api/work', { method: 'POST', cookie, headers })).status, 403)
    const session = await runtime.call('/auth/session', { cookie }).then((response) => response.json())
    await runtime.db.prepare('UPDATE oa_sessions SET expires_at = 1 WHERE id = ?').bind(session.id).run()
    await matrix(runtime, cookie, false)
    assert.equal((await runtime.call('/setup', { method: 'POST', cookie, input: {} })).status, 401, 'expired session cannot complete setup')
    await runtime.db.prepare('UPDATE oa_sessions SET expires_at = ? WHERE id = ?').bind(Date.now() + 60000, session.id).run()
    assert.equal((await runtime.call('/auth/session/revoke', { method: 'POST', cookie, input: { sessionId: session.id } })).status, 204)
    await matrix(runtime, cookie, false)
    assert.equal((await runtime.call('/setup', { method: 'POST', cookie, input: {} })).status, 401, 'revoked session cannot complete setup')
    assert.equal((await runtime.db.prepare('SELECT COUNT(*) AS n FROM articles').first()).n, 0)
  } finally { await runtime.close() }
})

test('emitted Worker: the owner corrects their name at first-run setup and later from settings', async () => {
  const runtime = await emittedRuntime({ noMail: true })
  try {
    const cookie = cookieOf(await runtime.call('/auth/bootstrap', { method: 'POST', input: { token: setupToken, displayName: 'Owner' } }))
    const name = async () => (await runtime.call('/auth/session', { cookie }).then((response) => response.json())).operator.displayName
    const page = await runtime.call('/setup', { cookie }).then((response) => response.text())
    assert.match(page, /<input name="displayName"[^>]* value="Owner">/, 'setup shows the name as an editable field')
    const form = (body) => runtime.call('/setup', { method: 'POST', cookie, body, headers: { 'content-type': 'application/x-www-form-urlencoded' } })
    assert.equal((await form('displayName=+&confirm=yes')).status, 400)
    assert.equal(await name(), 'Owner')
    const finished = await form('displayName=Rivera+Lee&confirm=yes')
    assert.equal(finished.status, 303)
    assert.equal(finished.headers.get('location'), '/app')
    assert.equal(await name(), 'Rivera Lee')
    const later = await runtime.call('/auth/display-name', { method: 'POST', cookie, input: { displayName: '  R. Lee  ' } })
    assert.equal(later.status, 200)
    assert.equal((await later.json()).displayName, 'R. Lee')
    assert.equal(await name(), 'R. Lee')
    assert.equal((await runtime.call('/auth/display-name', { method: 'POST', input: { displayName: 'Intruder' } })).status, 401)
    assert.equal((await runtime.call('/auth/display-name', { method: 'POST', cookie, input: { displayName: 'x'.repeat(121) } })).status, 400)
    assert.equal(await name(), 'R. Lee')
  } finally { await runtime.close() }
})

test('emitted Worker: prior data survives additive migration and legacy cookies do not authenticate', async () => {
  const runtime = await emittedRuntime({ prior: true, noMail: true })
  try {
    assert.equal((await runtime.db.prepare('SELECT email FROM operators').first()).email, 'previous@example.test')
    assert.equal((await runtime.db.prepare('SELECT token_hash FROM sessions').first()).token_hash, 'old-hash')
    assert.equal((await runtime.db.prepare('SELECT body FROM articles').first()).body, 'Preserved body')
    assert.equal((await runtime.call('/api/work', { cookie: 'rer_session=old-hash' })).status, 401)
    cookieOf(await runtime.call('/auth/bootstrap', { method: 'POST', input: { token: setupToken, displayName: 'Current Owner' } }))
    assert.equal((await runtime.db.prepare('SELECT count(*) AS n FROM oa_operators').first()).n, 1)
    assert.match(await runtime.call('/records').then((response) => response.text()), /Previous data/)
  } finally { await runtime.close() }
})

test('emitted Worker browser: owner setup, POST magic confirmation and revoke at desktop/mobile widths', async () => {
  const { browserProof } = await import('./browser.mjs')
  await browserProof()
})

test('emitted Worker browser: native sessions stay separate across loopback ports', async () => {
  // Browsers keep cookies per host, not per port: one browser holds both apps'
  // cookies for 127.0.0.1 and sends all of them to each port.
  const keys = ['a', 'b'].map((letter) => letter.repeat(43))
  const [a, b] = await startTogether(keys.map((devKey) => () => emittedRuntime({ noMail: true, devKey })))
  let browser
  try {
    const { chromium } = await import('@playwright/test')
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext()
    const signedIn = (page) => page.getByText(`${owner} · owner`, { exact: true }).waitFor()
    const open = async (runtime, key) => {
      const page = await context.newPage()
      await page.goto(`${runtime.origin}/__dev/key#rer-dev=${key}&next=%2Fsignin`)
      await page.waitForURL(`${runtime.origin}/signin`)
      await page.getByLabel('Your name').fill('Side Owner')
      await page.getByLabel('Setup token').fill(setupToken)
      await page.getByRole('button', { name: 'Create owner and sign in' }).click()
      await page.waitForURL(`${runtime.origin}/setup`)
      await page.getByRole('checkbox').check()
      await page.getByRole('button', { name: 'Finish setup', exact: true }).click()
      await page.waitForURL(`${runtime.origin}/app`)
      await signedIn(page)
      return page
    }
    const admits = async (runtime) => (await context.request.get(`${runtime.origin}/auth/session`)).status()
    const pageA = await open(a, keys[0])
    assert.equal(await admits(b), 401, "B accepts none of A's cookies, which the browser also sends to B")
    const pageB = await open(b, keys[1])
    await pageA.reload(); await signedIn(pageA)
    assert.equal(await admits(a), 200, 'signing in on B leaves A signed in')
    assert.equal(await admits(b), 200)
    // A's cookie values presented under B's own names are refused as well.
    const portOf = (runtime) => new URL(runtime.origin).port
    const fromA = Object.fromEntries((await context.cookies()).filter((c) => c.name.endsWith(`_${portOf(a)}`)).map((c) => [c.name.slice(0, -portOf(a).length - 1), c.value]))
    assert.deepEqual(Object.keys(fromA).sort(), ['operator_session_local', 'rer_dev_gate'])
    assert.equal((await b.call('/auth/session', { cookie: `operator_session_local_${portOf(b)}=${fromA.operator_session_local}` })).status, 401)
    // The access panel is hydrated and loaded once it lists sessions to revoke.
    await pageA.getByRole('button', { name: 'Revoke', exact: true }).first().waitFor()
    await pageA.getByRole('button', { name: 'Sign out', exact: true }).click()
    await pageA.waitForURL(`${a.origin}/signin`)
    assert.equal(await admits(a), 401, 'sign-out on A ends only its session')
    await pageB.reload(); await signedIn(pageB)
    assert.equal(await admits(b), 200, 'sign-out on A leaves B signed in')
  } finally { await Promise.allSettled([browser?.close(), a.close(), b.close()]) }
})

test('emitted Worker: a linked Auth provider verifies a signed callback and shares revoked session admission', async () => {
  const runtime = await emittedRuntime({ oidc: true, noMail: true })
  try {
    assert.equal((await runtime.call('/auth/dependencies/setup', { method: 'POST', input: { issuer: runtime.provider.issuer, token: setupToken } })).status, 200)
    const ownerCookie = cookieOf(await runtime.call('/auth/bootstrap', { method: 'POST', input: { token: setupToken, displayName: 'Owner' } }))
    assert.equal((await runtime.call('/auth/settings/identity', { method: 'POST', input: { idpSignIn: true }, cookie: ownerCookie })).status, 200)
    assert.equal((await runtime.provider.link(runtime.call)).status,200)
    assert.match(await runtime.call('/signin?returnTo=%2Fapp').then((response) => response.text()), /action="\/auth\/oidc\/auth\/start"/)
    assert.equal((await runtime.call('/auth/oidc/auth/start')).status, 405)
    const start = await runtime.call('/auth/oidc/auth/start', { method: 'POST', input: { returnTo: '/app' } })
    assert.equal(start.status, 303, `OIDC start: ${await start.clone().text()}; fixture requests ${JSON.stringify(runtime.networkRequests)}`)
    const binding = start.headers.get('set-cookie').split(';')[0]
    const callback = await runtime.provider.grant(start.headers.get('location'))
    assert.equal((await runtime.call(callback)).status, 400, 'missing browser binding does not authenticate')
    const completed = await runtime.call(callback, { cookie: binding })
    assert.equal(completed.status, 303)
    const sessionCookie = completed.headers.getSetCookie().find((value) => value.startsWith(`operator_session_local_${new URL(runtime.origin).port}=`)).split(';')[0]
    const session = await runtime.call('/auth/session', { cookie: sessionCookie }).then((response) => response.json())
    assert.equal(session.kind, 'oidc')
    await completeFirstRun(runtime.origin, sessionCookie)
    await matrix(runtime, sessionCookie, true)
    assert.equal((await runtime.call(callback, { cookie: binding })).status, 400)
    assert.equal((await runtime.call('/auth/signout', { method: 'POST', input: {}, cookie: sessionCookie })).status, 204)
    await matrix(runtime, sessionCookie, false)
    const badStart = await runtime.call('/auth/oidc/auth/start', { method: 'POST', input: {} })
    const badCallback = await runtime.provider.grant(badStart.headers.get('location'), { aud: 'attacker' })
    assert.equal((await runtime.call(badCallback, { cookie: badStart.headers.get('set-cookie').split(';')[0] })).status, 400)
    runtime.provider.redirectDiscovery()
    assert.equal((await runtime.call('/auth/oidc/auth/start', { method: 'POST', input: {} })).status, 502)
    assert.equal(runtime.networkRequests.some((request) => request.origin === 'https://attacker.example.test'), false)
  } finally { await runtime.close() }
})

test('native Wrangler emitted artifact: fresh migrations, browser navigation, SSR, assets and real 404s', async () => {
  const { nativeWranglerProof } = await import('./native-wrangler.mjs')
  await nativeWranglerProof()
})

test('vite dev: real Start scripts hydrate and navigate with no layout or transport failures', async () => {
  const { devBrowserProof } = await import('./dev-browser.mjs')
  await devBrowserProof()
})

test('emitted Worker administration: invitations, scoped admin roles, deactivation/reactivation and loopback review', async () => {
  const runtime = await emittedRuntime()
  const post = (path, input, cookie) => runtime.call(path, { method: 'POST', input, cookie })
  const confirm = async () => {
    const link = new URL(runtime.mails.at(-1).text.match(/https?:\/\/[^\s]+/)[0])
    return cookieOf(await post('/auth/confirm', { token: link.searchParams.get('token') }))
  }
  try {
    const ownerCookie = cookieOf(await post('/auth/bootstrap', { token: setupToken, displayName: 'Owner' }))
    const ownerSession = await runtime.call('/auth/session', { cookie: ownerCookie }).then((response) => response.json())
    assert.equal((await post('/auth/invite', { email: 'admin@example.test', displayName: 'Admin', role: 'admin' }, ownerCookie)).status, 202)
    const adminCookie = await confirm()
    assert.equal((await post('/auth/invite', { email: 'member@example.test', displayName: 'Member' }, adminCookie)).status, 202)
    const memberCookie = await confirm()
    const member = await runtime.call('/auth/session', { cookie: memberCookie }).then((response) => response.json())
    assert.equal((await runtime.call('/api/work', { cookie: memberCookie })).status, 200)
    assert.equal((await post('/auth/operator/role', { operatorId: member.operator.id, role: 'admin' }, adminCookie)).status, 403)
    assert.equal((await post('/auth/operator/status', { operatorId: ownerSession.operator.id, status: 'inactive' }, adminCookie)).status, 403)
    assert.equal((await post('/auth/operator/status', { operatorId: member.operator.id, status: 'inactive' }, adminCookie)).status, 200)
    assert.equal((await runtime.call('/api/work', { cookie: memberCookie })).status, 401)
    assert.equal((await post('/auth/operator/status', { operatorId: member.operator.id, status: 'active' }, adminCookie)).status, 200)
    assert.equal((await runtime.call('/api/work', { cookie: memberCookie })).status, 401)
    assert.equal((await post('/auth/magic-link', { email: 'member@example.test' })).status, 202)
    const reactivatedCookie = await confirm()
    assert.equal((await runtime.call('/api/work', { cookie: reactivatedCookie })).status, 200)
    const reviewCookie = cookieOf(await post('/auth/review-session', { returnTo: '/app' }))
    assert.equal((await runtime.call('/auth/session', { cookie: reviewCookie }).then((response) => response.json())).kind, 'review')
    assert.equal((await runtime.call('/api/work', { cookie: reviewCookie })).status, 200)
    assert.equal((await post('/auth/operator/status', { operatorId: ownerSession.operator.id, status: 'inactive' }, ownerCookie)).status, 403, 'bootstrap alone cannot change owner authority')
    assert.equal((await post('/auth/magic-link', { email: ownerSession.operator.email })).status, 202)
    const provedOwnerCookie = await confirm()
    assert.equal((await post('/auth/operator/status', { operatorId: ownerSession.operator.id, status: 'inactive' }, provedOwnerCookie)).status, 409, 'fresh proof still cannot remove the final owner')
    assert.equal((await runtime.call('/auth/session', { cookie: provedOwnerCookie }).then((response) => response.json())).operator.status, 'active')
  } finally { await runtime.close() }
})

test('emitted Worker: the Start renderer stays out of the complete eager module graph', async () => {
  const { rendererBoundaryProof } = await import('./renderer-boundary.mjs')
  await rendererBoundaryProof()
})
