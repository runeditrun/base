import { test } from 'node:test'
import { chromium } from '@playwright/test'
import { freshLocalProject } from './runtime.mjs'
import { journey } from './browser.mjs'

for (const width of [1440, 390]) {
  test(`fresh-copy local owner and outbox journey at ${width}px`, { timeout: 30 * 60_000 }, async () => {
    let runtime, browser
    const oldTemporary = Object.fromEntries(['TMPDIR', 'TMP', 'TEMP'].map((key) => [key, process.env[key]]))
    try {
      const owner = `owner-${width}@example.test`
      runtime = await freshLocalProject(owner)
      for (const key of Object.keys(oldTemporary)) process.env[key] = runtime.temporary
      browser = await chromium.launch({ headless: true })
      console.log(JSON.stringify({ localJourney: await journey(browser, runtime, width, owner) }))
    } catch (error) {
      // Playwright call logs may carry URLs. Keep credentials out of test output.
      let message = error instanceof Error ? error.message : 'Local journey failed'
      for (const value of Object.values(runtime?.vars ?? {})) if (value.length >= 32) message = message.replaceAll(value, '[redacted]')
      message = message.replace(/([?&]token=)[^\s"'<>]+/g, '$1[redacted]')
      throw new Error(`${message}${runtime ? `; private runtime diagnostics: ${runtime.logPath}` : ''}`)
    } finally {
      try { await browser?.close() } finally {
        try { await runtime?.close() } finally {
          for (const [key, value] of Object.entries(oldTemporary)) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
          }
        }
      }
    }
  })
}
