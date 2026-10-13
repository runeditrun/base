import assert from 'node:assert/strict'
import { chromium } from '@playwright/test'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { emittedRuntime, setupToken, owner, root } from './emitted-runtime.mjs'

export async function browserProof() {
  const captureDir = process.env.OPERATOR_AUTH_CAPTURE_DIR
  let sha = null
  try { sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim() } catch { /* Downloaded source need not have Git metadata. */ }
  const source = sha ? { sha } : { sha: null, inventorySha256: createHash('sha256').update(await readFile(join(root,'reference-export.json'))).digest('hex') }
  const manifest = { ...source, capturedAt: new Date().toISOString(), captures: [], browsers: [] }
  const browser = await chromium.launch({ headless: true })
  try {
    if (captureDir) await mkdir(captureDir, { recursive: true })
    for (const width of [1440, 390]) {
      const runtime = await emittedRuntime()
      const context = await browser.newContext({ viewport: { width, height: 900 } })
      const page = await context.newPage()
      const errors = [], failed = [], badResponses = [], documents = [], fetches = new Set()
      page.on('request', (request) => { if (request.resourceType() === 'fetch') fetches.add(request) })
      page.on('pageerror', (error) => errors.push(error.message))
      page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
      page.on('requestfailed', (request) => failed.push({ path: new URL(request.url()).pathname, error: request.failure()?.errorText }))
      page.on('response', (response) => { if (response.status() >= 400) badResponses.push({ path: new URL(response.url()).pathname, status: response.status() }) })
      page.on('request', (request) => { if (request.resourceType() === 'document') documents.push(new URL(request.url()).pathname) })
      async function capture(name) {
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${name} has no horizontal overflow`)
        if (captureDir) {
          const filename = `${width}-${name}.jpg`
          const file = join(captureDir, filename)
          await page.screenshot({ path: file, type: 'jpeg', quality: 85, fullPage: true })
          manifest.captures.push({ file: filename, width, sha256: createHash('sha256').update(await readFile(file)).digest('hex') })
        }
      }
      try {
        await page.goto(`${runtime.origin}/signin`, { waitUntil: 'networkidle' })
        await capture('setup')
        await page.getByLabel('Your name').fill('Browser Owner')
        await page.getByLabel('Setup token').fill(setupToken)
        await page.getByRole('button', { name: 'Create owner and sign in' }).click()
        await page.waitForURL('**/setup')
        await capture('first-run')
        await page.getByRole('checkbox').check()
        await page.getByRole('button', { name: 'Finish setup', exact: true }).click()
        await page.waitForURL('**/app')
        await page.getByText(`${owner} · owner`, { exact: true }).waitFor()
        assert.equal(runtime.mails.length, 0)
        await page.getByRole('button', { name: 'Revoke', exact: true }).waitFor()
        await capture('owner')
        await page.goto(runtime.origin+'/auth/settings/identity')
        await capture('identity-settings')
        await page.getByLabel('Allow provider sign-in').check()
        await page.getByRole('button',{name:'Save settings'}).click()
        await page.waitForURL('**/auth/settings/identity')
        assert.equal(await page.getByLabel('Allow provider sign-in').isChecked(),true)
        await page.getByLabel('Allow provider sign-in').uncheck()
        await page.getByRole('button',{name:'Save settings'}).click()
        await page.waitForURL('**/auth/settings/identity')
        assert.equal(await page.getByLabel('Allow provider sign-in').isChecked(),false)
        await page.goto(runtime.origin+'/app')
        const before = await page.evaluate(() => performance.timeOrigin)
        const count = documents.length
        await page.getByRole('link', { name: 'Public record', exact: true }).click()
        await page.getByRole('heading', { name: 'Server-rendered public record' }).waitFor()
        await page.getByRole('link', { name: 'Prerendered reference', exact: true }).click()
        await page.getByRole('heading', { name: 'Reference snapshot' }).waitFor()
        await page.getByRole('link', { name: 'Operator app', exact: true }).click()
        await page.getByText(`${owner} · owner`, { exact: true }).waitFor()
        // The panel loads the session, operators and sessions in turn, and the cached
        // /app match revalidates its loader in the background. Signing out before they
        // answer makes them answer 401 or redirect, so let the page settle first.
        await page.getByRole('button', { name: 'Revoke', exact: true }).waitFor()
        await Promise.all([...fetches].map(async (request) => (await request.response())?.finished()))
        assert.equal(await page.evaluate(() => performance.timeOrigin), before)
        assert.equal(documents.length, count)
        await page.getByRole('button', { name: 'Sign out', exact: true }).click()
        await page.waitForURL((url) => url.pathname === '/signin')
        await page.getByLabel('Email', { exact: true }).fill(owner)
        await page.getByRole('button', { name: 'Email a sign-in link' }).click()
        await page.getByRole('status').filter({ hasText: 'If this address' }).waitFor()
        const link = new URL(runtime.mails.at(-1).text.match(/https?:\/\/[^\s]+/)[0])
        const sessionsBefore = (await runtime.db.prepare('SELECT count(*) AS n FROM oa_sessions').first()).n
        await page.goto(link.href, { waitUntil: 'networkidle' })
        await capture('confirm')
        assert.equal((await runtime.db.prepare('SELECT count(*) AS n FROM oa_sessions').first()).n, sessionsBefore)
        const confirming = page.waitForResponse((response) => new URL(response.url()).pathname === '/auth/confirm' && response.request().method() === 'POST')
        await page.getByRole('button', { name: 'Confirm', exact: true }).click()
        const confirmed = await confirming
        if (confirmed.status() !== 303) assert.fail(`confirmation response ${await confirmed.text()}; Origin ${confirmed.request().headers().origin}`)
        await page.waitForURL('**/app')
        await page.getByText(`${owner} · owner`, { exact: true }).waitFor()
        await page.getByRole('button', { name: 'Revoke', exact: true }).waitFor()
        await capture('magic-signed-in')
        assert.equal((await runtime.call('/auth/confirm', { method: 'POST', input: { token: link.searchParams.get('token') } })).status, 400)
        await page.getByRole('button', { name: 'Revoke', exact: true }).click()
        await page.waitForURL((url) => url.pathname === '/signin')
        await page.getByRole('heading', { name: /^Sign in to / }).waitFor()
        const afterRevoke = await context.request.get(`${runtime.origin}/api/work`)
        assert.equal(afterRevoke.status(), 401)
        const unexpected = badResponses
        const favicon = unexpected.filter((item) => item.path === '/favicon.ico')
        const unrelated = unexpected.filter((item) => item.path !== '/favicon.ico')
        assert.deepEqual(unrelated, [])
        assert.deepEqual(failed, [])
        assert.deepEqual(errors.filter((error) => !(favicon.length && error.includes('404'))), [])
        manifest.browsers.push({ width, documents: documents.length, sameDocumentNavigation: true, pageErrors: errors, failedRequests: failed, responses: badResponses, currentSessionRevoked: afterRevoke.status() === 401, favicon404Reproduced: favicon.length > 0 })
      } finally { await context.close(); await runtime.close() }
    }
    if (captureDir) await writeFile(join(captureDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
    console.log(JSON.stringify({ browserEvidence: manifest.browsers }))
  } finally { await browser.close() }
}
