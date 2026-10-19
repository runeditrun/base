import { createRequire } from 'node:module'
import { mkdtemp, readdir, readFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { testProvider } from './oidc-provider.mjs'
import { startOnFreePort } from '../ports.mjs'

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

export async function migrate(db, filename) {
  const sql = await readFile(join(root, 'migrations/core', filename), 'utf8')
  // One request per file: a request per statement opens hundreds of loopback
  // connections per start, which exhausts the ephemeral port range under load.
  await db.batch(splitSql(sql).map((statement) => db.prepare(statement)))
}
export const emittedRuntime = (options = {}) => startOnFreePort((port) => startEmittedRuntime(port, options))
async function startEmittedRuntime(port, { prior = false, noMail = false, oidc = false, devKey, demo = false, demoHost = demo, hostname = '127.0.0.1', bindings = {}, files = false }) {
  const directory = await mkdtemp(join(tmpdir(), 'default-auth-emitted-'))
  const config = JSON.parse(await readFile(join(root, 'dist/server/wrangler.json'), 'utf8'))
  // Mail flows exercise production HTTPS; explicit local runtimes suppress mail.
  const production = !noMail
  const origin = demoHost ? 'https://demo.example.test' : `${production ? 'https' : 'http'}://${hostname}:${port}`
  const forwardHost = demoHost || hostname !== '127.0.0.1'
  const mails = []
  const networkRequests = []
  const provider = oidc ? await testProvider(origin, owner) : undefined
  const modules = [config.main, ...(await readdir(join(root, 'dist/server/assets'))).filter((file) => file.endsWith('.js')).map((file) => `assets/${file}`)]
    .map((file) => ({ type: 'ESModule', path: join(root, 'dist/server', file) }))
  // Preserve the requested URL and Host through Miniflare's loopback proxy, as the
  // demo front does when forwarding into this visitor's container.
  if (forwardHost) modules.unshift({ type: 'ESModule', path: join(root, 'dist/server/test-demo-entry.mjs'),
    contents: `import worker from ${JSON.stringify('./' + config.main)};
      export default { ...worker, async fetch(envelope, env, execution) {
        const { url, ...init } = await envelope.json();
        return worker.fetch(new Request(url, init), env, execution);
      } };` })
  const options = convertV4MiniflareOptions({
    host: '127.0.0.1', port, https: production, modulesRoot: join(root, 'dist/server'),
    modules,
    compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags,
    assets: { directory: join(root, 'dist/client'), routerConfig: { has_user_worker: true } },
    d1Databases: { DB: 'default-seed-emitted' },
    // Person erasure clears the Worker's file bucket; tests that erase opt in.
    ...(files ? { r2Buckets: { FILES: 'default-seed-emitted-files' } } : {}),
    queueProducers: { JOBS: 'reference-jobs' }, queueConsumers: { 'reference-jobs': { maxBatchTimeout: 0 } },
    bindings: {
      AUTH_ORIGIN: origin, AUTH_LOCAL: production ? 'false' : 'true', OWNER_EMAIL: owner, SETUP_TOKEN: setupToken,
      SESSION_SECRET: 'disposable-test-only-session-secret-00001',
      AUTH_REVIEW_ENABLED: 'true',
      ...(devKey ? { RER_DEV_KEY: devKey } : {}),
      ...(demo ? { RER_DEMO: '1' } : {}),
      ...(demo ? { MAIL_FROM: 'Auth <auth@example.test>' } : {}),
      ...provider?.configuration,
      ...(!noMail ? { MAIL_PROVIDER: 'resend', MAIL_FROM: 'Auth <auth@example.test>', MAIL_API_KEY: 'test-only-key' } : {}),
      ...bindings,
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
    const call = (path, { method = 'GET', input, body, cookie, headers = {} } = {}) => {
      const init = { method, headers: {
        ...(forwardHost ? { host: new URL(origin).host, 'CF-Connecting-IP': demoHost ? '192.0.2.1' : '127.0.0.1' } : {}),
        ...(method === 'POST' ? { origin, 'content-type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}), ...headers,
      }, ...(body !== undefined ? { body } : input === undefined ? {} : { body: JSON.stringify(input) }) }
      return forwardHost ? mf.dispatchFetch(`${production ? 'https' : 'http'}://127.0.0.1:${port}/test-dispatch`, {
        method: 'POST', redirect: 'manual', body: JSON.stringify({ url: origin + path, ...init }),
      }) : mf.dispatchFetch(origin + path, { ...init, redirect: 'manual' })
    }
    return { origin, call, db, mails, mf, provider, networkRequests, async close() { await mf.dispose(); await rm(directory, { recursive: true, force: true }) } }
  } catch (error) { await Promise.allSettled([mf.dispose(), rm(directory, { recursive: true, force: true })]); throw error }
}
