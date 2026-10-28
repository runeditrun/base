import { loopbackFetch as fetch } from '../../scripts/base-onboarding/loopback-fetch.mjs'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile, rm, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium } from '@playwright/test'
import { owner, setupToken } from './emitted-runtime.mjs'
import { listenerEntry } from '../worker-listener.mjs'
import { copyProject } from '../local-journey/copy.mjs'
import { spawnOwnedProcess, stopOwnedProcess } from '../owned-process.mjs'
import { BODY_SUCCEEDED, finishWithCleanup } from '../cleanup-errors.mjs'
import { createRedaction, credentialValues } from '../../../onboarding/redaction.mjs'
import { viteListening } from './vite-ready.mjs'

function startupDiagnostic(redaction, child, lastHealth, output) {
  // Redact the complete capture before taking its tail, so truncation cannot
  // separate a credential from the field or URL that identifies it as private.
  const safe = (value) => redaction.redact(String(value)).replace(/[?#][^\s"'<>]*/g, '[REDACTED]')
  const lines = safe(output).trim().split('\n').slice(-40).join('\n')
  return `exit=${child.exitCode}, signal=${child.signalCode}; last health: ${safe(lastHealth)}\nLast child output (up to 40 lines):\n${lines || '(no output)'}`
}

export async function devBrowserProof() {
  const directory = await mkdtemp(join(tmpdir(),'default-auth-vite-'))
  const root = join(directory,'seed')
  let origin
  const vars = join(root, '.dev.vars')
  let child, bodyError = BODY_SUCCEEDED, output = ''
  const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_API_KEY: '' }
  const sessionSecret = ['disposable', 'dev', 'test', 'secret', 'at', 'least', '32'].join('-')
  const redaction = createRedaction()
  redaction.addSecrets([owner, setupToken, sessionSecret, ...credentialValues(env)])
  try {
    await copyProject(root)
    await promisify(execFile)('pnpm', ['install','--frozen-lockfile'], { cwd: root, env })
    // Exclusive disposable checkout: never overwrite the operator's settings.
    await writeFile(vars, `AUTH_ORIGIN=http://127.0.0.1:0\nAUTH_LOCAL=true\nOWNER_EMAIL=${owner}\nSESSION_SECRET=${sessionSecret}\nSETUP_TOKEN=${setupToken}\n`, { flag: 'wx', mode: 0o600 })
    await promisify(execFile)('pnpm', ['exec', 'wrangler', 'd1', 'migrations', 'apply', 'default-seed-reference', '--local', '--persist-to','.wrangler/state','--config', 'wrangler.jsonc'], { cwd: root, env })
    // Wrap only this disposable checkout's dev entry; Vite and its HMR client
    // still use the actual listener selected by Vite itself.
    const entry = join(root, 'src/server.dev.ts')
    await writeFile(join(root, 'src/server.dev.native.ts'), await readFile(entry))
    await writeFile(entry, listenerEntry('./server.dev.native'))
    child = spawnOwnedProcess('pnpm', ['exec','vite','dev', '--host', '127.0.0.1', '--port', '0', '--strictPort'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', (value) => { output += value })
    child.stderr.on('data', (value) => { output += value })
    child.on('error', (error) => { output += `\nChild spawn error: ${error.message}\n` })
    let lastHealth = 'No health response yet'
    const startupSignal = AbortSignal.timeout(12000)
    try {
      origin = await viteListening(child, { signal: startupSignal })
      const response = await fetch(`${origin}/health`, { signal: startupSignal })
      lastHealth = `HTTP ${response.status}`
      assert.equal(response.status, 200)
    } catch (error) {
      lastHealth += `; ${redaction.redact(error?.message ?? String(error))}`
      if (error?.cause !== undefined) lastHealth += `; cause: ${redaction.redact(error.cause?.message ?? String(error.cause))}`
      throw new Error(`vite dev did not become healthy; ${startupDiagnostic(redaction, child, lastHealth, output)}`)
    }
    const browser = await chromium.launch({ headless: true })
    let browserBodyError = BODY_SUCCEEDED
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
      const errors = [], failed = [], responses = [], scripts = []
      page.on('pageerror', (error) => errors.push(error.message))
      page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
      page.on('requestfailed', (request) => failed.push(new URL(request.url()).pathname))
      page.on('response', (response) => {
        const path = new URL(response.url()).pathname
        if (response.status() >= 400) responses.push({ path, status: response.status() })
        if (response.request().resourceType() === 'script' && response.ok()) scripts.push(path)
      })
      await page.goto(`${origin}/reference`, { waitUntil: 'networkidle' })
      await page.getByRole('heading', { name: 'Reference snapshot' }).waitFor()
      const before = await page.evaluate(() => performance.timeOrigin)
      await page.getByRole('link', { name: 'Public record', exact: true }).click()
      await page.getByRole('heading', { name: 'Server-rendered public record' }).waitFor()
      assert.equal(await page.evaluate(() => performance.timeOrigin), before)
      assert.ok(scripts.some((path) => path.includes('/@vite/client')))
      assert.ok(scripts.some((path) => path.includes('start') || path.includes('router')))
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
      console.log(JSON.stringify({ viteDevBrowser: { scriptsLoaded: scripts.length, errors, failed, responses, hydratedNavigation: true } }))
      assert.deepEqual(failed, [])
      assert.deepEqual(responses.filter((response) => response.path !== '/favicon.ico'), [])
      assert.deepEqual(errors.filter((value) => !(responses.some((response) => response.path === '/favicon.ico') && value.includes('404'))), [])
    } catch (error) {
      browserBodyError = error
    } finally { await finishWithCleanup(browserBodyError, [() => browser.close()]) }
  } catch (error) {
    bodyError = error
  } finally {
    await finishWithCleanup(bodyError, [() => stopOwnedProcess(child), () => rm(vars, { force: true }), () => rm(directory,{recursive:true,force:true})])
  }
}
