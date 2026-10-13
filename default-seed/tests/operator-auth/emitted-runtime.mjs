import { createRequire } from 'node:module'
import { mkdtemp, readdir, readFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { testProvider } from './oidc-provider.mjs'

export const root = fileURLToPath(new URL('../../', import.meta.url))
const reactRequire = createRequire(await realpath(join(root, 'node_modules/@tanstack/react-start/package.json')))
const startRequire = createRequire(reactRequire.resolve('@tanstack/start-client-core/package.json'))
const { fromCrossJSON } = startRequire('seroval')
const { defaultSerovalPlugins } = startRequire('@tanstack/router-core')
export const decodeStart = (body) => fromCrossJSON(JSON.parse(body), { plugins: defaultSerovalPlugins })
const require = createRequire(await realpath(join(root, 'node_modules/wrangler/package.json')))
const { Miniflare, convertV4MiniflareOptions } = require('miniflare')
export const { unstable_splitSqlQuery: splitSql } = require('wrangler')
export const owner = 'owner@example.test'
export const setupToken = 'disposable-test-only-owner-setup-token-00001'

export async function freePort() {
  const server = createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}
export async function migrate(db, filename) {
  const sql = await readFile(join(root, 'migrations/core', filename), 'utf8')
  for (const statement of splitSql(sql)) await db.prepare(statement).run()
}
export async function emittedRuntime({ prior = false, noMail = false, oidc = false, devKey } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'default-auth-emitted-'))
  const config = JSON.parse(await readFile(join(root, 'dist/server/wrangler.json'), 'utf8'))
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const mails = []
  const networkRequests = []
  const provider = oidc ? await testProvider(origin, owner) : undefined
  const options = convertV4MiniflareOptions({
    host: '127.0.0.1', port, modulesRoot: join(root, 'dist/server'),
    modules: [config.main, ...(await readdir(join(root, 'dist/server/assets'))).filter((file) => file.endsWith('.js')).map((file) => `assets/${file}`)].map((file) => ({ type: 'ESModule', path: join(root, 'dist/server', file) })),
    compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags,
    assets: { directory: join(root, 'dist/client'), routerConfig: { has_user_worker: true } },
    d1Databases: { DB: 'default-seed-emitted' },
    queueProducers: { JOBS: 'reference-jobs' }, queueConsumers: { 'reference-jobs': { maxBatchTimeout: 0 } },
    bindings: {
      AUTH_ORIGIN: origin, AUTH_LOCAL: 'true', OWNER_EMAIL: owner, SETUP_TOKEN: setupToken,
      SESSION_SECRET: 'disposable-test-only-session-secret-00001',
      AUTH_REVIEW_ENABLED: 'true',
      ...(devKey ? { RER_DEV_KEY: devKey } : {}),
      ...provider?.configuration,
      ...(!noMail ? { MAIL_PROVIDER: 'resend', MAIL_FROM: 'Auth <auth@example.test>', MAIL_API_KEY: 'test-only-key' } : {}),
    },
    // Test-only outbound capture: emitted application and real mail facade are
    // unchanged. This callback can never contact a provider.
    outboundService: async (request) => {
      networkRequests.push({ origin: new URL(request.url).origin, path: new URL(request.url).pathname })
      if (provider && new URL(request.url).origin === provider.issuer) return provider.fetch(request)
      if (request.url !== 'https://api.resend.com/emails') throw new Error('Unexpected test network destination')
      mails.push(await request.json())
      return Response.json({ id: `test-receipt-${mails.length}` })
    },
  })
  const mf = new Miniflare({ ...options, resourcePersistencePath: join(directory, 'state') })
  try {
    await mf.ready
    const db = await mf.getD1Database('DB')
    await migrate(db, '0001_reference.sql')
    if (prior) {
      await db.prepare("INSERT INTO operators VALUES ('old-operator','previous@example.test','2026-09-08T00:00:00Z')").run()
      await db.prepare("INSERT INTO sessions VALUES ('old-session','old-hash','previous@example.test','2099-01-01T00:00:00Z','2026-09-08T00:00:00Z',NULL)").run()
      await db.prepare("INSERT INTO articles VALUES ('old-article','previous','Previous data','Preserved body','2026-09-08T00:00:00Z')").run()
    }
    for (const file of (await readdir(join(root, 'migrations/core'))).filter((file) => file.endsWith('.sql') && file !== '0001_reference.sql').sort()) await migrate(db, file)
    const call = (path, { method = 'GET', input, cookie, headers = {} } = {}) => fetch(`${origin}${path}`, {
      method, redirect: 'manual', headers: {
        ...(method === 'POST' ? { origin, 'content-type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}), ...headers,
      }, ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    })
    return { origin, call, db, mails, mf, provider, networkRequests, async close() { await mf.dispose(); await rm(directory, { recursive: true, force: true }) } }
  } catch (error) { await mf.dispose(); await rm(directory, { recursive: true, force: true }); throw error }
}
