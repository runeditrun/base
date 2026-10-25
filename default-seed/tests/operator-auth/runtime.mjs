import { createRequire } from 'node:module'
import { readFile, readdir, mkdtemp, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const require = createRequire(await realpath(join(root, 'node_modules/wrangler/package.json')))
const { Miniflare, convertV4MiniflareOptions } = require('miniflare')
const { build } = require('esbuild')
const { unstable_splitSqlQuery: splitSql } = require('wrangler')
const output = await build({ entryPoints: [fileURLToPath(new URL('./worker.mjs', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:workers', 'node:*'] })

export async function openConsumerRuntime({ config, mailStatus, noMail, demo = false }) {
  const directory = await mkdtemp(join(tmpdir(), 'default-auth-conformance-'))
  const bindings = {
    AUTH_ORIGIN: config.origin, AUTH_LOCAL: String(config.local === true),
    OWNER_EMAIL: config.OWNER_EMAIL, SESSION_SECRET: config.SESSION_SECRET,
    INSTALLATION_KEY: crypto.getRandomValues(new Uint8Array(32)).reduce((s,b)=>s+b.toString(16).padStart(2,'0'),''),
    SETUP_TOKEN: config.SETUP_TOKEN, MAIL_FROM: config.MAIL_FROM,
    ...(demo ? { RER_DEMO: '1' } : {}),
    ...(config.allowList ? { AUTH_ALLOW_LIST: config.allowList.join(',') } : {}),
    ...(config.ipLimit ? { AUTH_IP_LIMIT: String(config.ipLimit) } : {}),
    ...(config.emailLimit ? { AUTH_EMAIL_LIMIT: String(config.emailLimit) } : {}),
    ...(config.review ? { AUTH_REVIEW_ENABLED: 'true', AUTH_REVIEW_EMAIL: config.review.operatorEmail } : {}),
    ...(!noMail ? { MAIL_PROVIDER: 'resend', MAIL_API_KEY: 'test-only-key' } : {}),
    TEST_MAIL_STATUS: mailStatus,
  }
  const mf = new Miniflare({ ...convertV4MiniflareOptions({
    modules: true, script: output.outputFiles[0].text, compatibilityDate: '2026-09-08', compatibilityFlags: ['nodejs_compat'],
    d1Databases: { DB: 'default-seed-auth' }, bindings, queueProducers: { JOBS: 'default-seed-jobs' },
  }), resourcePersistencePath: join(directory, 'state') })
  try {
    const db = await mf.getD1Database('DB')
    const migrationPath = join(root, 'migrations/core')
    for (const file of (await readdir(migrationPath)).filter((name) => name.endsWith('.sql')).sort()) {
      const sql = await readFile(join(migrationPath, file), 'utf8')
      // Every statement, as Wrangler applies a migration (0007 rebuilds a table).
      for (const statement of splitSql(sql)) await db.prepare(statement).run()
    }
    await db.exec('CREATE TABLE test_mail (id INTEGER PRIMARY KEY AUTOINCREMENT, message TEXT NOT NULL);')
    const call = async (path, { method = 'GET', input, body, cookie, headers = {}, ip = '192.0.2.1' } = {}) => {
      const url = new URL(path, config.origin)
      return mf.dispatchFetch('http://localhost/test-dispatch', { method: 'POST', redirect: 'manual', body: JSON.stringify({
        url: url.href, method,
        headers: { host: url.host, ...(method === 'POST' ? { origin: config.origin, 'content-type': 'application/json' } : {}), 'CF-Connecting-IP': ip, ...(cookie ? { cookie } : {}), ...headers },
        ...(body === undefined && input === undefined ? {} : { body: body ?? JSON.stringify(input) }),
      }) })
    }
    return {
      call, db,
      privateRequest: (cookie, options = {}) => call('/api/work', { ...options, cookie }),
      async mails() { return (await db.prepare('SELECT message FROM test_mail ORDER BY id').all()).results.map((row) => JSON.parse(row.message)) },
      async close() { await mf.dispose(); await rm(directory, { recursive: true, force: true }) },
    }
  } catch (error) { await mf.dispose(); await rm(directory, { recursive: true, force: true }); throw error }
}
