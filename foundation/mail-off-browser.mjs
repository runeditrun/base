import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

// Invoked by the real Worker journey with the runner's real HOME. This process
// owns and closes its browser; it never uses a profile or a saved session.
const [root, origin, directory] = process.argv.slice(2)
const require = createRequire(join(root, 'package.json'))
const { chromium } = require('@playwright/test')
await mkdir(directory, { recursive: true })
const browser = await chromium.launch({ headless: true, args: ['--use-mock-keychain', '--password-store=basic'] })
try {
 const context = await browser.newContext()
 const page = await context.newPage()
 for (const width of [1440, 390]) {
  await page.setViewportSize({ width, height: 900 })
  const response = await page.goto(origin + '/signin', { waitUntil: 'networkidle' })
  await page.screenshot({ path: join(directory, `mail-off-signin-${width}.png`), fullPage: true })
  assert.equal(response.status(), 200)
  assert.equal(await page.locator('form[action="/auth/magic-link"]').count(), 0)
  assert.equal(await page.locator('[role="alert"]').count(), 1, await page.locator('body').innerText())
 }
 await context.close()
} finally { await browser.close() }
