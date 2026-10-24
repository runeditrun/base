import { completeFirstRun } from '../operator-auth/first-run.mjs'
import { queuedEntrypoint } from '../../../onboarding/queued-entry.mjs';
const queuedExit=await queuedEntrypoint(import.meta.url,'verify:browser');
if(queuedExit!==null)process.exit(queuedExit);
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { spawnOwnedProcess, stopOwnedProcess } from '../owned-process.mjs'
import { advertisedOrigin, listenerConfig } from '../worker-listener.mjs'
import { readableActivity, refreshSafeCreate } from './people-page.mjs'
import { freshSeedImportDoor } from './import-door.mjs'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const email = 'operator@example.test'
const setupToken = 'reference-test-only-setup-token-32-bytes'
const sessionSecret = 'reference-test-only-session-secret-32-bytes'

function command(name, args, options = {}) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(name, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], ...options })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    child.once('error', rejectCommand)
    child.once('exit', (code) => {
      if (code === 0) resolveCommand(output)
      else rejectCommand(new Error(`${name} ${args.join(' ')} exited ${code}\n${output}`))
    })
  })
}

async function waitForHealth(child, output) {
  let baseUrl
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited early\n${output()}`)
    baseUrl ??= advertisedOrigin(output())
    try {
      if (!baseUrl) throw new Error('Waiting for listener')
      const response = await fetch(`${baseUrl}/health`)
      if (response.ok) return baseUrl
    } catch {
      // The local workerd listener is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  throw new Error(`Timed out waiting for local workerd\n${output()}`)
}

function sessionCookie(response, port) {
  const value = response.headers.get('set-cookie')
  assert(value, 'sign-in must set a native session cookie')
  const [cookie] = value.split(';')
  assert.match(cookie, new RegExp(`^operator_session_local_${port}=[A-Za-z0-9_-]{32,}$`))
  assert.match(value, /HttpOnly/)
  assert.match(value, /SameSite=Lax/)
  return cookie
}

function withoutReactSeparators(html) {
  return html.replaceAll('<!-- -->', '')
}

async function serverFunctionId(name) {
  const assets = join(root, 'dist/server/assets')
  for (const file of await readdir(assets)) {
    if (!file.startsWith('loaders-') || !file.endsWith('.js')) continue
    const source = await readFile(join(assets, file), 'utf8')
    const match = source.match(new RegExp(`id: "([a-f0-9]{64})",\\n\\s*name: "${name}"`))
    if (match) return match[1]
  }
  throw new Error(`No emitted server-function id for ${name}`)
}

async function browserNavigationCheck(baseUrl, cookie) {
  const browser = await chromium.launch({ headless: true, args: ["--use-mock-keychain", "--password-store=basic"] })
  try {
    const context = await browser.newContext()
    const page = await context.newPage()
    const documents = []
    const pageErrors = []
    const consoleErrors = []
    page.on('request', (request) => {
      if (request.resourceType() === 'document') documents.push(request.url())
    })
    page.on('pageerror', (error) => pageErrors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    const [name, value] = cookie.split('=')
    await context.addCookies([{ name, value, url: baseUrl, httpOnly: true, sameSite: 'Lax' }])
    await page.goto(`${baseUrl}/records`, { waitUntil: 'networkidle' })
    const before = await page.evaluate(() => performance.timeOrigin)
    await page.getByRole('link', { name: 'Prerendered reference' }).click()
    await page.waitForURL('**/reference')
    await page.waitForLoadState('networkidle')
    const afterReference = await page.evaluate(() => performance.timeOrigin)
    assert.equal(await page.getByRole('heading', { name: 'Reference snapshot' }).textContent(), 'Reference snapshot')
    await page.getByRole('link', { name: 'Operator app' }).click()
    await page.waitForURL('**/app')
    await page.waitForLoadState('networkidle')
    const afterApp = await page.evaluate(() => performance.timeOrigin)
    assert.equal(await page.getByRole('heading', { name: 'Native session protected operator app' }).textContent(), 'Native session protected operator app')
    assert.equal(before, afterReference, 'TanStack Link navigation keeps the document alive')
    assert.equal(before, afterApp, 'authenticated app navigation keeps the document alive')
    assert.deepEqual(documents, [`${baseUrl}/records`])
    assert.deepEqual(pageErrors, [], 'hydration must not raise page errors')
    assert.deepEqual(consoleErrors, [], 'hydration must not emit console errors')
    return { documentRequests: documents.length, sameTimeOrigin: before === afterApp, pageErrors: pageErrors.length, consoleErrors: consoleErrors.length }
  } finally {
    await browser.close()
  }
}

async function main() {
  const staticReference = await readFile(join(root, 'dist/client/reference/index.html'), 'utf8')
  assert.match(staticReference, /Reference snapshot/)
  const clientFiles = await readdir(join(root, 'dist/client/assets'))
  const clientSource = await Promise.all(clientFiles.map((file) => readFile(join(root, 'dist/client/assets', file), 'utf8')))
  assert.equal(clientSource.join('\n').includes('cloudflare:workers'), false)
  assert.equal(clientSource.join('\n').includes('drizzle-orm/d1'), false)

  const persistPath = await mkdtemp(join(tmpdir(), 'default-seed-reference-'))
  const config = join(root, 'dist/server/wrangler.json')
  let worker
  let workerOutput = ''

  try {
    await command('pnpm', [
      'exec', 'wrangler', 'd1', 'migrations', 'apply', 'default-seed-reference',
      '--local', '--persist-to', persistPath, '--config', config,
    ])
    await command('pnpm', [
      'exec', 'wrangler', 'd1', 'execute', 'default-seed-reference',
      '--local', '--persist-to', persistPath, '--config', config,
      '--file', join(root, 'tests/e2e/fixtures.sql'),
    ])
    const servingConfig = await listenerConfig(config, persistPath)
    worker = spawnOwnedProcess('pnpm', [
      'exec', 'wrangler', 'dev', '--inspector-port', '0', '--config', servingConfig, '--local', '--persist-to', persistPath,
      '--show-interactive-dev-session=false', '--ip', '127.0.0.1', '--port', '0',
      '--var', `OWNER_EMAIL:${email}`, '--var', `SETUP_TOKEN:${setupToken}`,
      '--var', `SESSION_SECRET:${sessionSecret}`, '--var', 'AUTH_ORIGIN:http://127.0.0.1:0', '--var', 'AUTH_LOCAL:true',
    ], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    worker.stdout.on('data', (chunk) => { workerOutput += chunk })
    worker.stderr.on('data', (chunk) => { workerOutput += chunk })
    const baseUrl = await waitForHealth(worker, () => workerOutput)
    const port = new URL(baseUrl).port

    const health = await fetch(`${baseUrl}/health`)
    assert.equal(health.status, 200)
    assert.equal(health.headers.get('x-reference-dispatch'), 'hono')

    const publicFeed = await fetch(`${baseUrl}/api/public/feed`)
    assert.equal(publicFeed.headers.get('x-reference-dispatch'), 'hono')
    assert.equal((await publicFeed.json()).articles[0].slug, 'worker-boundaries')

    const publicPage = await fetch(`${baseUrl}/records`)
    assert.equal(publicPage.status, 200)
    assert.match(await publicPage.text(), /Worker boundaries/)
    const prerenderedPage = await fetch(`${baseUrl}/reference`)
    assert.equal(prerenderedPage.status, 200)
    assert.match(await prerenderedPage.text(), /Reference snapshot/)

    const privateTransport = await serverFunctionId('loadPrivateDashboard')
    const directPrivateWithoutOrigin = await fetch(`${baseUrl}/_serverFn/${privateTransport}`, {
      headers: { 'x-tsr-serverFn': 'true', accept: 'application/json' },
    })
    assert.equal(directPrivateWithoutOrigin.status, 403)
    const directPrivateCrossOrigin = await fetch(`${baseUrl}/_serverFn/${privateTransport}`, {
      headers: {
        'x-tsr-serverFn': 'true',
        accept: 'application/json',
        origin: 'https://attacker.example',
      },
    })
    assert.equal(directPrivateCrossOrigin.status, 403)
    const directPrivate = await fetch(`${baseUrl}/_serverFn/${privateTransport}`, {
      headers: {
        'x-tsr-serverFn': 'true',
        accept: 'application/json',
        origin: baseUrl,
      },
    })
    const directPrivateBody = await directPrivate.text()
    assert.equal(directPrivate.status, 200)
    assert.match(directPrivateBody, /"href":"\/signin\?returnTo=%2Fapp"/)
    assert.doesNotMatch(directPrivateBody, /latestJob|latestSchedule|Native session protected/)

    const privateDocument = await fetch(`${baseUrl}/app`, { redirect: 'manual' })
    assert.equal(privateDocument.status, 307)
    assert.equal(privateDocument.headers.get('location'), '/signin?returnTo=%2Fapp')
    assert.equal(await privateDocument.text(), '')

    for (const path of ['/missing-document', '/assets/missing.js']) {
      const missing = await fetch(`${baseUrl}${path}`, {
        headers: { 'sec-fetch-mode': 'navigate' },
      })
      assert.equal(missing.status, 404, `${path} must be a real HTTP 404`)
    }
    const unknownApi = await fetch(`${baseUrl}/api/unknown`)
    assert.equal(unknownApi.status, 404)
    assert.equal(unknownApi.headers.get('x-reference-dispatch'), 'hono')
    const apiBase = await fetch(`${baseUrl}/api`)
    assert.equal(apiBase.status, 404)
    assert.equal(apiBase.headers.get('x-reference-dispatch'), 'hono')

    const noOriginSignIn = await fetch(`${baseUrl}/auth/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: setupToken, displayName: 'Reference Owner' }),
    })
    assert.equal(noOriginSignIn.status, 403)
    const signIn = await fetch(`${baseUrl}/auth/bootstrap`, {
      method: 'POST', redirect: 'manual',
      headers: { origin: baseUrl, 'content-type': 'application/json' },
      body: JSON.stringify({ token: setupToken, displayName: 'Reference Owner' }),
    })
    assert.equal(signIn.status, 303)
    const cookie = sessionCookie(signIn, port)
    await completeFirstRun(baseUrl, cookie)

    const importDoor = await freshSeedImportDoor({ baseUrl, cookie })

    const authenticatedPrivate = await fetch(`${baseUrl}/app`, { headers: { cookie } })
    assert.equal(authenticatedPrivate.status, 200)
    assert.match(await authenticatedPrivate.text(), /Native session protected operator app/)

    const noOriginWork = await fetch(`${baseUrl}/api/work`, {
      method: 'POST',
      headers: { cookie },
    })
    assert.equal(noOriginWork.status, 403)
    const crossOriginWork = await fetch(`${baseUrl}/api/work`, {
      method: 'POST',
      headers: { cookie, origin: 'https://attacker.example' },
    })
    assert.equal(crossOriginWork.status, 403)
    const sameOriginWork = await fetch(`${baseUrl}/api/work`, {
      method: 'POST',
      headers: { cookie, origin: baseUrl },
    })
    assert.equal(sameOriginWork.status, 202)
    const { id: jobId } = await sameOriginWork.json()
    let job
    for (let attempt = 0; attempt < 30; attempt += 1) {
      job = await fetch(`${baseUrl}/api/work/${jobId}`, { headers: { cookie } }).then((response) => response.json())
      if (job.state === 'completed') break
      await new Promise((resolveWait) => setTimeout(resolveWait, 100))
    }
    assert.equal(job.state, 'completed', 'Queue consumer completes a persisted job')

    const schedule = await fetch(`${baseUrl}/cdn-cgi/local/scheduled?cron=*+*+*+*+*`)
    assert.equal(schedule.status, 200)
    const dashboard = withoutReactSeparators(await fetch(`${baseUrl}/app`, { headers: { cookie } }).then((response) => response.text()))
    assert.match(dashboard, /Latest job: completed/)
    assert.match(dashboard, /Latest cron: \* \* \* \* \*/)

    await command('pnpm', [
      'exec', 'wrangler', 'd1', 'execute', 'default-seed-reference',
      '--local', '--persist-to', persistPath, '--config', config,
      '--command', "UPDATE articles SET title = 'Updated Worker boundaries' WHERE slug = 'worker-boundaries'",
    ])
    const freshSsr = await fetch(`${baseUrl}/records`)
    assert.equal(freshSsr.status, 200)
    assert.match(await freshSsr.text(), /Updated Worker boundaries/)

    const execute = (sql) => command('pnpm', ['exec', 'wrangler', 'd1', 'execute', 'default-seed-reference', '--local', '--persist-to', persistPath, '--config', config, '--command', sql])
    const refreshSafe = await refreshSafeCreate({ baseUrl, cookie, persistPath })
    const activity = await readableActivity({ baseUrl, cookie, persistPath, execute })
    const browser = await browserNavigationCheck(baseUrl, cookie)
    console.log(JSON.stringify({
      status: 'passed',
      staticReference: true,
      ssrD1: true,
      privateTransport: '/_serverFn/<generated-id>',
      queueCompleted: true,
      cronPersisted: true,
      importDoor,
      refreshSafe,
      activity,
      browser,
    }))
  } finally {
    await stopOwnedProcess(worker)
    await rm(persistPath, { recursive: true, force: true })
  }
}

await main()
