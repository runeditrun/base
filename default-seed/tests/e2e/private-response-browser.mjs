import { completeFirstRun } from '../operator-auth/first-run.mjs'
import assert from 'node:assert/strict'
import { chromium } from '@playwright/test'
import { emittedRuntime, owner, setupToken } from '../operator-auth/emitted-runtime.mjs'
import { assertSelectChevron } from './select-chevron.mjs'

export async function privateResponseBrowser(functions) {
  const runtime = await emittedRuntime({ noMail: true })
  let browser
  try {
    browser = await chromium.launch({ headless: true, args: ['--use-mock-keychain', '--password-store=basic'] })
    const signed = await runtime.call('/auth/bootstrap', { method: 'POST', input: { token: setupToken, displayName: 'Browser Cache Owner' } })
    assert.equal(signed.status, 303)
    await completeFirstRun(runtime.origin, signed.headers.get('set-cookie').split(';')[0])
    const [name, value] = signed.headers.get('set-cookie').split(';')[0].split('=')
    for (const width of [1440, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } })
      try {
        await context.addCookies([{ name, value, url: runtime.origin }])
        const page = await context.newPage()
        const errors = [], failures = [], badResponses = [], documents = [], privateResponses = []
        page.on('pageerror', (error) => errors.push(error.message))
        page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
        page.on('requestfailed', (request) => failures.push(request.url()))
        page.on('request', (request) => { if (request.resourceType() === 'document') documents.push(request.url()) })
        page.on('response', (response) => {
          const path = new URL(response.url()).pathname
          if (response.status() >= 400) badResponses.push({ path, status: response.status() })
          if (Object.values(functions).includes(path)) privateResponses.push(response)
        })
        const response = await page.goto(`${runtime.origin}/app`, { waitUntil: 'networkidle' })
        assert.equal(response.status(), 200)
        assert.equal(response.headers()['cache-control'], 'no-store, no-transform')
        await page.getByText(`${owner} · owner`, { exact: true }).waitFor()
        assert.ok(await assertSelectChevron(page, `${width}px /app`) > 0, 'the operator app renders its role selects')
        // Start a fresh public document before testing client navigation, so the
        // private loaders cannot be satisfied by the first document's router cache.
        await page.goto(`${runtime.origin}/records`, { waitUntil: 'networkidle' })
        const timeOrigin = await page.evaluate(() => performance.timeOrigin)
        await page.getByRole('link', { name: 'Prerendered reference', exact: true }).click()
        await page.getByRole('heading', { name: 'Reference snapshot' }).waitFor()
        await page.getByRole('link', { name: 'Operator app', exact: true }).click()
        await page.getByText(`${owner} · owner`, { exact: true }).waitFor()
        await page.waitForLoadState('networkidle')
        assert.equal(await page.evaluate(() => performance.timeOrigin), timeOrigin)
        assert.equal(documents.length, 2)
        for (const path of Object.values(functions)) {
          const responses = privateResponses.filter((item) => new URL(item.url()).pathname === path)
          assert.ok(responses.length > 0, `browser called ${path}`)
          for (const item of responses) {
            assert.equal(item.status(), 200)
            assert.equal(item.headers()['cache-control'], 'no-store, no-transform')
            assert.equal(item.headers()['x-tss-serialized'], 'true')
          }
        }
        assert.deepEqual(failures, [])
        assert.deepEqual(badResponses.filter((item) => item.path !== '/favicon.ico'), [])
        const favicon404 = badResponses.some((item) => item.path === '/favicon.ico' && item.status === 404)
        assert.deepEqual(errors.filter((message) => !(favicon404 && message.includes('404'))), [])
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
      } finally { await context.close() }
    }
  } finally { await browser?.close(); await runtime.close() }
}
