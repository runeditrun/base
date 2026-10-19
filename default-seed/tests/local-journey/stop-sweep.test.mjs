// DIAGNOSTIC ONLY (gr-base-268 draft PR, never merged). Stops the documented dev server at
// fixed delays after /health answers, i.e. inside rer dev's startup tail.
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { readFile } from 'node:fs/promises'
import { freshLocalProject } from './runtime.mjs'

test('scratch stop race sweep', { timeout: 30 * 60_000 }, async (t) => {
  const runtime = await freshLocalProject('stop-race-owner@example.test')
  try {
    const delays = (process.env.SWEEP ?? Array.from({ length: 21 }, (_, i) => i * 150).join(',')).split(',').map(Number)
    for (const wait of delays) {
      await runtime.stop()
      await runtime.start(runtime.origin)
      await delay(wait)
      const started = performance.now()
      let outcome = 'ok'
      try { await runtime.stop() } catch (error) { outcome = error.message }
      await delay(500)
      const log = (await readFile(runtime.logPath, 'utf8')).split('Phase: pnpm run dev').at(-1)
      const reached = ['Opening your application', 'Building the run site', '"pages"', 'RER_READY', 'RER_SITE'].filter((mark) => log.includes(mark)).join('>')
      t.diagnostic(`delay=${wait}ms stop=${Math.round(performance.now() - started)}ms reached=${reached} ${outcome}`)
    }
  } finally { await runtime.close() }
})
