import { completeFirstRun } from './first-run.mjs'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { root, owner, setupToken } from './emitted-runtime.mjs'
import { advertisedOrigin, listenerConfig } from '../worker-listener.mjs'
import { chromium } from '@playwright/test'
import { spawnOwnedProcess, stopOwnedProcess } from '../owned-process.mjs'

export async function nativeWranglerProof() {
  const state = await mkdtemp(join(tmpdir(), 'default-auth-wrangler-'))
  const config = join(root, 'dist/server/wrangler.json')
  let origin
  let worker, output = ''
  const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_API_KEY: '' }
  const command = (args) => new Promise((resolve, reject) => {
    const process = spawn('pnpm', args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let text = ''
    process.stdout.on('data', (value) => { text += value })
    process.stderr.on('data', (value) => { text += value })
    process.on('error', reject)
    process.on('exit', (code) => code === 0 ? resolve(text) : reject(new Error(`Local command failed (${code}): ${text}`)))
  })
  try {
    await command(['exec', 'wrangler', 'd1', 'migrations', 'apply', 'default-seed-reference', '--local', '--persist-to', state, '--config', config])
    const servingConfig = await listenerConfig(config, state)
    worker = spawnOwnedProcess('pnpm', ['exec', 'wrangler', 'dev', '--inspector-port', '0', '--config', servingConfig, '--local', '--persist-to', state, '--ip', '127.0.0.1', '--port', '0', '--show-interactive-dev-session=false', '--var', `OWNER_EMAIL:${owner}`, '--var', `SESSION_SECRET:disposable-native-test-secret-32-bytes`, '--var', `SETUP_TOKEN:${setupToken}`, '--var', 'AUTH_ORIGIN:http://127.0.0.1:0', '--var', 'AUTH_LOCAL:true'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    worker.stdout.on('data', (value) => { output += value })
    worker.stderr.on('data', (value) => { output += value })
    let ready = false
    for (let i = 0; i < 150; i++) {
      if (worker.exitCode !== null) throw new Error('Wrangler exited during startup')
      origin ??= advertisedOrigin(output)
      try { if (origin && (await fetch(`${origin}/health`)).status === 200) { ready = true; break } } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.ok(ready, 'emitted Wrangler became healthy')
    const call = (path, options = {}) => fetch(`${origin}${path}`, { redirect: 'manual', ...options })
    assert.equal((await call('/api/work')).status, 401)
    const signed = await call('/auth/bootstrap', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ token: setupToken, displayName: 'Native Owner' }) })
    assert.equal(signed.status, 303)
    const cookie = signed.headers.get('set-cookie').split(';')[0]
    await completeFirstRun(origin, cookie)
    assert.equal((await call('/api/work', { headers: { cookie } })).status, 200)
    for (const path of ['/missing-document', '/assets/missing.js', '/@vite/client', '/@id/virtual:tanstack-start-entry']) {
      assert.equal((await call(path, { headers: { 'sec-fetch-mode': 'navigate' } })).status, 404, path)
    }
    const unsupported = await new Promise((resolve, reject) => {
      const request = httpRequest(origin, { headers: { host: 'unsupported.example.test' } }, (response) => { response.resume(); response.on('end', () => resolve(response.statusCode)) })
      request.on('error', reject); request.end()
    })
    assert.equal(unsupported, 404)
    assert.equal((await call('/api/work/unknown/deep', { headers: { cookie } })).status, 404)
    const asset = (await readdir(join(root, 'dist/client/assets'))).find((name) => name.startsWith('index-') && name.endsWith('.js'))
    const assetResponse = await call(`/assets/${asset}`)
    assert.equal(assetResponse.status, 200)
    assert.match(assetResponse.headers.get('content-type'), /javascript/)
    const publicBefore = await call('/records').then((response) => response.text())
    assert.doesNotMatch(publicBefore, /Native SSR marker/)
    await command(['exec', 'wrangler', 'd1', 'execute', 'default-seed-reference', '--local', '--persist-to', state, '--config', config, '--command', "INSERT INTO articles VALUES ('native-article','native','Native SSR marker','Current D1 content','2026-10-06T00:00:00Z')"])
    assert.match(await call('/records').then((response) => response.text()), /Native SSR marker/)
    const browser = await chromium.launch({ headless: true })
    try {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
      const page = await context.newPage()
      const consoleErrors = [], pageErrors = [], failures = [], responses = []
      page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })
      page.on('pageerror', (error) => pageErrors.push(error.message))
      page.on('requestfailed', (request) => failures.push(new URL(request.url()).pathname))
      page.on('response', (response) => { if (response.status() >= 400) responses.push({ path: new URL(response.url()).pathname, status: response.status() }) })
      const [name, value] = cookie.split('=')
      await context.addCookies([{ name, value, url: origin }])
      await page.goto(origin + '/records', { waitUntil: 'networkidle' })
      const before = await page.evaluate(() => performance.timeOrigin)
      await page.getByRole('link', { name: 'Prerendered reference' }).click()
      await page.getByRole('heading', { name: 'Reference snapshot' }).waitFor()
      await page.getByRole('link', { name: 'Operator app' }).click()
      await page.getByRole('heading', { name: 'Native session protected operator app' }).waitFor()
      await page.waitForLoadState('networkidle')
      assert.equal(await page.evaluate(() => performance.timeOrigin), before)
      assert.deepEqual(pageErrors, [])
      assert.deepEqual(failures, [])
      const favicon404 = (await call('/favicon.ico')).status === 404
      console.log(JSON.stringify({ nativeWranglerBrowser: { consoleErrors, pageErrors, failures, responses, faviconEndpoint404: favicon404, normalNavigationFavicon404: responses.some((response) => response.path === '/favicon.ico'), sameDocumentNavigation: true } }))
      assert.deepEqual(responses.filter((response) => response.path !== '/favicon.ico'), [])
      assert.deepEqual(consoleErrors.filter((value) => !value.includes('404')), [])
    } finally { await browser.close() }
    for (const file of await readdir(join(root, 'dist/client/assets'))) {
      const source = await readFile(join(root, 'dist/client/assets', file), 'utf8')
      for (const forbidden of ['cloudflare:workers', 'drizzle-orm/d1', 'SESSION_SECRET', 'MAIL_API_KEY', 'SETUP_TOKEN', 'oa_sessions', 'admitVerifiedIdentity']) assert.equal(source.includes(forbidden), false, `${file} excludes ${forbidden}`)
    }
  } finally {
    await stopOwnedProcess(worker)
    await rm(state, { recursive: true, force: true })
  }
}
