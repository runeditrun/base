import { installD1Preflight } from '../../scripts/base-cli/modules/container/adapters/d1-workerd-setup.mjs';
import { createRequire } from 'node:module'
import { mkdtemp, readdir, readFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { testProvider } from './oidc-provider.mjs'
import { drainingResponse, emittedListener } from './emitted-listener.mjs'

export const root = fileURLToPath(new URL('../../', import.meta.url))
const reactRequire = createRequire(await realpath(join(root, 'node_modules/@tanstack/react-start/package.json')))
const startRequire = createRequire(reactRequire.resolve('@tanstack/start-client-core/package.json'))
const { fromCrossJSON } = startRequire('seroval')
const { defaultSerovalPlugins } = startRequire('@tanstack/router-core')
export const decodeStart = (body) => fromCrossJSON(JSON.parse(body), { plugins: defaultSerovalPlugins })
const require = createRequire(await realpath(join(root, 'node_modules/wrangler/package.json')))
const { Miniflare, convertV4MiniflareOptions, D1_PLUGIN } = require('miniflare');
installD1Preflight(D1_PLUGIN)
export const { unstable_splitSqlQuery: splitSql } = require('wrangler')
export const owner = 'owner@example.test'
export const setupToken = 'disposable-test-only-owner-setup-token-00001'

export async function migrate(db, filename) {
  const sql = await readFile(join(root, 'migrations/core', filename), 'utf8')
  // One request per file: a request per statement opens hundreds of loopback
  // connections per start, which exhausts the ephemeral port range under load.
  await db.batch(splitSql(sql).map((statement) => db.prepare(statement)))
}
export async function emittedRuntime({ prior = false, noMail = false, oidc = false, devKey, demo = false, demoHost = demo, hostname = '127.0.0.1', bindings = {}, files = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'default-auth-emitted-'))
  const config = JSON.parse(await readFile(join(root, 'dist/server/wrangler.json'), 'utf8'))
  // Mail flows exercise production HTTPS; explicit local runtimes suppress mail.
  const production = !noMail
  let origin = demoHost ? 'https://demo.example.test' : `${production ? 'https' : 'http'}://${hostname}`
  const forwardHost = demoHost || hostname !== '127.0.0.1'
  const mails = []
  const networkRequests = []
  const active = new Set()
  let provider, mf, deploying
  const listener = emittedListener(Miniflare, convertV4MiniflareOptions, {
    https: production, compatibilityDate: config.compatibility_date,
    async fetch(request) {
      // A request arriving during redeploy waits for the new generation. The
      // ingress listener remains owned while D1 changes hands between workers.
      while (deploying) await deploying
      let finish
      const done = new Promise(resolve => { finish = resolve })
      active.add(done)
      const finished = () => { active.delete(done); finish() }
      try { return drainingResponse(await mf.dispatchFetch(request, { redirect: 'manual' }), finished) }
      catch (error) { finished(); throw error }
    },
  })
  const modules = [config.main, ...(await readdir(join(root, 'dist/server/assets'))).filter((file) => file.endsWith('.js')).map((file) => `assets/${file}`)]
    .map((file) => ({ type: 'ESModule', path: join(root, 'dist/server', file) }))
  // Preserve the requested URL and Host through Miniflare's loopback proxy, as the
  // demo front does when forwarding into this visitor's container.
  modules.unshift({ type: 'ESModule', path: join(root, 'dist/server/test-demo-entry.mjs'),
    contents: `import worker from ${JSON.stringify('./' + config.main)};
      export default { ...worker, async fetch(envelope, env, execution) {
        const forwarded = new Headers(envelope.headers);
        const url = forwarded.get('x-base-test-url');
        forwarded.set('host', forwarded.get('x-base-test-host'));
        forwarded.delete('x-base-test-url');
        forwarded.delete('x-base-test-host');
        const received = new Request(url, new Request(envelope, { headers: forwarded }));
        const request = ${forwardHost ? 'await received.json().then(({ url, ...init }) => new Request(url, init))' : 'received'};
        // workerd does not synthesize Host for in-process dispatch. Preserve an
        // explicit Host so origin-admission tests still exercise hostile hosts.
        const headers = new Headers(request.headers);
        if (!headers.has('host')) headers.set('host', new URL(request.url).host);
        return worker.fetch(new Request(request, { headers }), env, execution);
      } };` })
  const legacyOptions = {
    host: '127.0.0.1', port: 0, https: production, modulesRoot: join(root, 'dist/server'),
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
      INSTALLATION_KEY: crypto.getRandomValues(new Uint8Array(32)).reduce((s,b)=>s+b.toString(16).padStart(2,'0'),''),
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
  }
  const start = (modules) => new Miniflare({ ...convertV4MiniflareOptions({ ...legacyOptions, modules }), resourcePersistencePath: join(directory, 'state') })
  try {
    const address = await listener.ready
    if (!demoHost) origin = `${production ? 'https' : 'http'}://${hostname}:${address.port}`
    provider = oidc ? await testProvider(origin, owner) : undefined
    legacyOptions.bindings = { ...legacyOptions.bindings, AUTH_ORIGIN: origin, ...provider?.configuration, ...bindings }
    // The application starts with the already-bound ingress origin. Neither
    // runtime is reconfigured to publish bindings after it has started.
    mf = start(modules)
    await mf.ready
    const port = address.port
    let db = await mf.getD1Database('DB')
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
      return forwardHost ? listener.dispatchFetch(`${production ? 'https' : 'http'}://127.0.0.1:${port}/test-dispatch`, {
        method: 'POST', redirect: 'manual', body: JSON.stringify({ url: origin + path, ...init }),
      }) : listener.dispatchFetch(origin + path, { ...init, redirect: 'manual' })
    }
    return { origin, call, get db() { return db }, mails, get mf() { return mf }, provider, networkRequests,
      // Deploy changed real Worker source against the same persisted D1. This
      // models policy edits without an application-only test endpoint/binding.
      async redeploy(transform = source => source) {
        const changed = await Promise.all(modules.map(async module => ({ ...module,
          contents: transform(module.contents ?? await readFile(module.path, 'utf8'), module.path) })))
        deploying = (async () => {
          await Promise.all(active)
          await mf.dispose()
          mf = start(changed)
          await mf.ready
          db = await mf.getD1Database('DB')
        })()
        try { await deploying } finally { deploying = undefined }
      }, async close() {
        await listener.dispose()
        try { await deploying } finally { await mf.dispose(); await rm(directory, { recursive: true, force: true }) }
      } }
  } catch (error) { await Promise.allSettled([listener.dispose(), mf?.dispose()]); await rm(directory, { recursive: true, force: true }); throw error }
}
