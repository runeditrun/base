import { completeFirstRun } from '../operator-auth/first-run.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from '@playwright/test'
import { emittedRuntime, root, owner, setupToken, decodeStart } from '../operator-auth/emitted-runtime.mjs'

async function privateFunctions() {
  const sources = await Promise.all((await readdir(join(root, 'dist/server/assets')))
    .filter((file) => file.endsWith('.js'))
    .map((file) => readFile(join(root, 'dist/server/assets', file), 'utf8')))
  return Object.fromEntries(['requireOperator', 'loadPrivateDashboard'].map((name) => {
    const match = sources.join('\n').match(new RegExp(`id: "([a-f0-9]{64})",\\n\\s*name: "${name}"`))
    assert.ok(match, `${name} has an actual generated transport`)
    return [name, `/_serverFn/${match[1]}`]
  }))
}

const noStore = (response) => assert.equal(response.headers.get('cache-control'), 'no-store, no-transform')
const transportHeaders = (origin) => ({
  'x-tsr-serverFn': 'true', accept: 'application/json', origin, 'sec-fetch-site': 'same-origin',
})

test('emitted Worker keeps private documents and each RPC uncached through every admission state', async () => {
  const runtime = await emittedRuntime({ noMail: true })
  try {
    const functions = await privateFunctions()
    const matrix = async (cookie, allowed) => {
      const document = await runtime.call('/app', { cookie, headers: { 'sec-fetch-mode': 'navigate' } })
      noStore(document)
      assert.equal(document.status, allowed ? 200 : 307)
      if (allowed) {
        assert.match(document.headers.get('content-type'), /text\/html/)
        const reader = document.body.getReader()
        const chunks = []
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          chunks.push(Buffer.from(value))
        }
        assert.ok(chunks.length > 0)
        const html = Buffer.concat(chunks).toString()
        assert.match(html, /Native session protected operator app/)
        assert.match(html, /Latest job:/)
        assert.match(html, /<script/)
      } else {
        assert.equal(document.headers.get('location'), '/signin?returnTo=%2Fapp')
        assert.equal(await document.text(), '')
      }
      for (const [name, path] of Object.entries(functions)) {
        const response = await runtime.call(path, { cookie, headers: transportHeaders(runtime.origin) })
        noStore(response)
        assert.equal(response.status, 200)
        assert.match(response.headers.get('content-type'), /application\/json/)
        const body = await response.text()
        if (allowed) {
          assert.equal(response.headers.get('x-tss-serialized'), 'true')
          const decoded = decodeStart(body)
          if (name === 'requireOperator') assert.equal(decoded.result.operator.email, owner)
          else assert.deepEqual(Object.keys(decoded.result).sort(), ['latestJob', 'latestSchedule'])
        } else {
          // The sign-in page is server-rendered outside the route tree: a document navigation.
          assert.deepEqual(JSON.parse(body), {
            href: '/signin?returnTo=%2Fapp', reloadDocument: true, statusCode: 307, isSerializedRedirect: true,
          })
          assert.doesNotMatch(body, /latestJob|latestSchedule|owner@example.test/)
        }
      }
    }
    await matrix(undefined, false)
    await matrix(`operator_session_local_${new URL(runtime.origin).port}=invalid`, false)
    const bootstrap = await runtime.call('/auth/bootstrap', {
      method: 'POST', input: { token: setupToken, displayName: 'Cache Owner' },
    })
    assert.equal(bootstrap.status, 303)
    const cookie = bootstrap.headers.get('set-cookie').split(';')[0]
    await completeFirstRun(runtime.origin, cookie)
    await matrix(cookie, true)
    for (const path of Object.values(functions)) {
      for (const rejected of [
        { origin: 'https://attacker.test', 'sec-fetch-site': 'cross-site' },
        { origin: 'https://attacker.test' },
        {},
      ]) {
        const response = await runtime.call(path, { cookie, headers: { 'x-tsr-serverFn': 'true', accept: 'application/json', ...rejected } })
        noStore(response)
        assert.equal(response.status, 403)
        assert.equal(await response.text(), 'Forbidden')
      }
    }
    const asset = (await readdir(join(root, 'dist/client/assets'))).find((file) => file.startsWith('index-') && file.endsWith('.js'))
    assert.ok(asset)
    for (const path of [`/assets/${asset}`, '/reference/']) {
      const anonymous = await runtime.call(path)
      const authenticated = await runtime.call(path, { cookie })
      assert.equal(anonymous.status, 200)
      assert.equal(authenticated.status, 200)
      assert.notEqual(anonymous.headers.get('cache-control'), 'no-store, no-transform')
      assert.equal(authenticated.headers.get('cache-control'), anonymous.headers.get('cache-control'))
      assert.equal(await authenticated.text(), await anonymous.text())
    }
    const session = await runtime.call('/auth/session', { cookie }).then((response) => response.json())
    await runtime.db.prepare('UPDATE oa_sessions SET expires_at = 1 WHERE id = ?').bind(session.id).run()
    await matrix(cookie, false)
    await runtime.db.prepare('UPDATE oa_sessions SET expires_at = ? WHERE id = ?').bind(Date.now() + 60000, session.id).run()
    assert.equal((await runtime.call('/auth/session/revoke', { method: 'POST', cookie, input: { sessionId: session.id } })).status, 204)
    await matrix(cookie, false)

  } finally { await runtime.close() }
})

test('emitted Worker browser retains uncached SSR and hydrated native RPC navigation', async () => {
  const { privateResponseBrowser } = await import('./private-response-browser.mjs')
  await privateResponseBrowser(await privateFunctions())
})

test('the owner moves people in through the import screen: upload, review, approve, reconcile, reload, undo and the Business setting', async (t) => {
  const runtime = await emittedRuntime({ noMail: true })
  t.after(() => runtime.close())
  const directory = await mkdtemp(join(tmpdir(), 'import-screen-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const bootstrap = await runtime.call('/auth/bootstrap', { method: 'POST', input: { token: setupToken, displayName: 'Screen Owner' } })
  assert.equal(bootstrap.status, 303)
  const cookie = bootstrap.headers.get('set-cookie').split(';')[0]
  await completeFirstRun(runtime.origin, cookie)
  const native = async () => (await (await runtime.call('/api/operator/import-export', { cookie })).json()).sort((a, b) => a.ref.localeCompare(b.ref))
  const settings = async () => (await runtime.call('/api/operator/import-settings', { cookie })).json()
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())

  for (const width of [1440, 390]) {
    const records = [
      { ref: `screen-${width}-ada`, name: 'Ada Screen', email: `ada-${width}@example.test`, details: { team: 'Support' } },
      { ref: `screen-${width}-bo`, name: 'Bo Screen', email: `bo-${width}@example.test`, details: { team: 'Operations' } },
    ]
    const file = join(directory, `people-${width}.json`)
    await writeFile(file, JSON.stringify(records))
    const before = await native()
    const context = await browser.newContext({ viewport: { width, height: 900 } })
    try {
      const [name, value] = cookie.split('=')
      await context.addCookies([{ name, value, url: runtime.origin }])
      const page = await context.newPage()
      const problems = []
      page.on('pageerror', error => problems.push(error.message))
      page.on('console', message => { if (message.type() === 'error') problems.push(message.text()) })
      await context.route('**/*', route => new URL(route.request().url()).origin === runtime.origin ? route.continue() : (problems.push('external request'), route.abort()))
      const notice = page.locator('#notice')
      const overflow = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)

      await page.goto(`${runtime.origin}/app/import`)
      await page.getByText('Loading history…').waitFor({ state: 'detached' })
      await page.locator('#bundle').setInputFiles(file)
      const planned = page.waitForResponse(response => response.url() === `${runtime.origin}/api/operator/import/plan` && response.request().method() === 'POST')
      await page.getByRole('button', { name: 'Upload and review', exact: true }).click()
      const reviewed = await (await planned).json()
      await page.locator('#review').waitFor({ state: 'visible' })
      assert.equal(await page.locator('#fingerprint').textContent(), reviewed.fingerprint, 'the screen displays the fingerprint of the reviewed plan')
      const differences = await page.locator('#differences').innerText()
      for (const record of records) assert.ok(differences.includes(record.name), `the review lists ${record.name}`)
      assert.deepEqual(await native(), before, 'reviewing changes no native record')

      // Approval needs the reviewer's explicit confirmation.
      await page.getByRole('button', { name: 'Apply reviewed import', exact: true }).click()
      assert.deepEqual(await native(), before, 'an unconfirmed approval applies nothing')
      await page.locator('#confirmed').check()
      const applying = page.waitForRequest(request => request.url() === `${runtime.origin}/api/operator/import/apply` && request.method() === 'POST')
      await page.getByRole('button', { name: 'Apply reviewed import', exact: true }).click()
      const approval = (await applying).postDataJSON()
      assert.deepEqual([approval.planId, approval.reviewedFingerprint], [reviewed.planId, reviewed.fingerprint], 'approval binds to the plan and fingerprint the owner reviewed')
      await page.locator('#result-title').getByText('Import completed').waitFor()
      assert.deepEqual((await native()).filter(person => person.ref.startsWith(`screen-${width}-`)), records, 'the approved plan wrote exactly the reviewed people')
      assert.equal(await overflow(), true, 'no horizontal overflow at the result')

      await page.getByRole('button', { name: 'Reconcile native records', exact: true }).click()
      await notice.getByText(/Reconciled: 2 present/).waitFor()

      // The saved plan and its history survive a reload, from the same controls.
      await page.reload()
      await page.locator('#history').getByRole('button', { name: 'Open import' }).first().click()
      await page.locator('#result-title').getByText('Import completed').waitFor()
      await page.getByRole('button', { name: 'Undo import', exact: true }).click()
      await page.locator('#result-title').getByText('Import undone').waitFor()
      assert.deepEqual(await native(), before, 'undo removes what the import wrote')
      await page.locator('#history').getByText('undone').first().waitFor()

      const enabled = (await settings()).enabled
      await page.locator('#enabled').setChecked(!enabled)
      await page.getByRole('button', { name: 'Save import settings', exact: true }).click()
      await notice.getByText('Import settings saved.').waitFor()
      assert.equal((await settings()).enabled, !enabled, 'the Business setting is saved through the screen')
      assert.equal(await overflow(), true)
      assert.deepEqual(problems, [])
    } finally { await context.close() }
  }
})
