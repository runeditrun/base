import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { cp, mkdir, mkdtemp, open, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { advertisedOrigin } from '../worker-listener.mjs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

export const nativeBindingRows = []


const root = fileURLToPath(new URL('../../', import.meta.url))

async function stop(child, closed) {
  if (!child.pid) return
  const signal = (name) => {
    // macOS answers EPERM, not ESRCH, for a group whose members have all exited but are not yet reaped.
    try { process.kill(-child.pid, name) } catch (error) { if (error.code !== 'ESRCH' && error.code !== 'EPERM') throw error }
  }
  signal('SIGTERM')
  await Promise.race([closed, delay(3000)])
  // Include pnpm, Wrangler and workerd in cleanup, even if the launcher exited.
  signal('SIGKILL')
  await closed
}

nativeBindingRows.push(['native Wrangler receives only explicit private file bindings despite inherited loader settings', { timeout: 60000 }, async () => {
  const parent = join(root, '.wrangler/local-setup-tests')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const dir = await mkdtemp(join(parent, 'native-'))
  let child
  let closed
  let output
  try {
    await cp(join(root, 'scripts'), join(dir, 'scripts'), { recursive: true })
  await cp(join(root, 'tests/local-setup/fixtures'), join(dir, 'scripts'), { recursive: true })
  await cp(join(root, 'rer-setup.json'), join(dir, 'rer-setup.json'))
    await symlink(join(root, 'node_modules'), join(dir, 'node_modules'))
    await writeFile(join(dir, 'package.json'), '{"type":"module","private":true}')
    await mkdir(join(dir, 'dist/server'), { recursive: true })
    await writeFile(join(dir, 'dist/server/wrangler.json'), JSON.stringify({
      name: 'local-setup-native-bindings', main: 'worker.mjs', compatibility_date: '2026-09-01',
    }))
    // A real minimal Worker fixture: compare request expectations in workerd,
    // returning only booleans, never credentials or their derived values.
    await writeFile(join(dir, 'dist/server/worker.mjs'), `export default {
      fetch(request, env) {
        return Response.json({
          session: typeof env.SESSION_SECRET === 'string' && env.SESSION_SECRET === request.headers.get('x-expected-session'),
          setup: typeof env.SETUP_TOKEN === 'string' && env.SETUP_TOKEN === request.headers.get('x-expected-setup'),
          local: env.AUTH_LOCAL === 'true',
          origin: env.AUTH_ORIGIN === request.headers.get('x-expected-origin'),
          owner: env.OWNER_EMAIL === 'owner@example.test',
          provider: env.MAIL_PROVIDER === 'development',
          from: env.MAIL_FROM === 'auth@localhost.test',
          processExcluded: !('LOCAL_SETUP_PROCESS_SENTINEL' in env),
          dotenvExcluded: !('LOCAL_SETUP_DOTENV_SENTINEL' in env),
        })
      }
    }`)
    const configuredOrigin = 'http://127.0.0.1:0'
    const session = randomBytes(32).toString('hex')
    const setup = randomBytes(32).toString('hex')
    const vars = `AUTH_LOCAL=true\nAUTH_ORIGIN=${configuredOrigin}\nOWNER_EMAIL=owner@example.test\nMAIL_PROVIDER=development\nMAIL_FROM=auth@localhost.test\nSESSION_SECRET=${session}\nSETUP_TOKEN=${setup}\n`
    const varsPath = join(dir, '.dev.vars')
    await writeFile(varsPath, vars, { mode: 0o600 })
    await writeFile(join(dir, '.env'), 'LOCAL_SETUP_DOTENV_SENTINEL=must-not-be-bound\n', { mode: 0o600 })
    output = await open(join(dir, 'launcher.log'), 'wx', 0o600)
    child = spawn(process.execPath, [join(dir, 'scripts/local-dev.mjs')], {
      cwd: dir, detached: true, stdio: ['ignore', output.fd, output.fd],
      env: {
        ...process.env, RER_LOCAL_OPERATION: '', CI: 'true', WRANGLER_SEND_METRICS: 'false',
        WRANGLER_LOG_PATH: join(dir, 'wrangler.log'),
        CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
        CLOUDFLARE_INCLUDE_PROCESS_ENV: 'true',
        LOCAL_SETUP_PROCESS_SENTINEL: 'must-not-be-bound',
        SESSION_SECRET: 'inherited-value-must-not-override-file',
      },
    })
    let exited = false
    closed = new Promise((resolve) => {
      child.once('error', () => { exited = true; resolve() })
      child.once('close', () => { exited = true; resolve() })
    })
    let response, origin
    const deadline = Date.now() + 40000
    while (!exited && Date.now() < deadline) {
      try {
        origin ??= advertisedOrigin(await readFile(join(dir, 'launcher.log'), 'utf8'))
        if (!origin) { await delay(200); continue }
        response = await fetch(origin, {
          headers: { 'x-expected-session': session, 'x-expected-setup': setup, 'x-expected-origin': configuredOrigin },
          signal: AbortSignal.timeout(1000),
        })
        break
      } catch { await delay(200) }
    }
    assert.ok(response, 'native Wrangler must start and serve the fixture')
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      session: true, setup: true, local: true, origin: true, owner: true,
      provider: true, from: true, processExcluded: true, dotenvExcluded: true,
    })
    assert.ok((await readFile(varsPath, 'utf8')) === vars, 'private credentials must remain unchanged')
    assert.equal((await stat(varsPath)).mode & 0o777, 0o600)
    await stop(child, closed)
    child = undefined
    const log = await readFile(join(dir, 'launcher.log'), 'utf8')
    assert.ok(!log.includes(session) && !log.includes(setup), 'launcher output must not expose credentials')
    const config = await readFile(join(dir, 'dist/server/wrangler.json'), 'utf8')
    const worker = await readFile(join(dir, 'dist/server/worker.mjs'), 'utf8')
    assert.ok(!`${config}${worker}`.includes(session) && !`${config}${worker}`.includes(setup), 'emitted files must not contain credentials')
  } finally {
    if (child) await stop(child, closed)
    await output?.close()
    await rm(dir, { recursive: true, force: true })
  }
}])
