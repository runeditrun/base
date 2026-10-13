import assert from 'node:assert/strict'
import { chmod, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { after, before, test } from 'node:test'
import { freshBuildCopy } from './build-copy.mjs'
import { assertDistExcludesSecrets } from './readme.mjs'

// The reference's own installer adapter on the shared Base kit, run natively:
// a forced failing first attempt, resume, real build and migrations, the
// running Worker's /health, operator-auth bootstrap, sign-in through the
// development outbox, private diagnostics, a rerun that keeps the owner's
// settings, and teardown.
let copy
before(async () => { copy = await freshBuildCopy() }, { timeout: 20 * 60_000 })
after(async () => { await copy?.close() })

const answers = { displayName: 'Installer Owner', OWNER_EMAIL: 'installer-owner@example.test', IDENTITY_PROVIDER: '' }

async function open(resume) {
  const { startInstaller } = await import(pathToFileURL(join(copy.root, 'scripts/base-onboarding/server.mjs')))
  const { createSeed } = await import(pathToFileURL(join(copy.root, 'scripts/installer/seed.mjs')))
  const server = await startInstaller(copy.root, { seed: createSeed(), ...(resume ? { resume: true } : { noPrefill: true }) })
  const page = await fetch(server.origin)
  const html = await page.text()
  const headers = { Origin: server.origin, Cookie: page.headers.get('set-cookie').split(';')[0], 'X-Installer-Token': html.match(/name="installer-token" content="([a-f0-9]+)"/)[1], 'Content-Type': 'application/json' }
  const state = async () => (await fetch(server.origin + '/api/state', { headers })).json()
  const start = async (body) => {
    const response = await fetch(server.origin + '/api/start', { method: 'POST', headers, body: JSON.stringify(body) })
    assert.equal(response.status, 202, await response.text())
    for (let attempt = 0; attempt < 1200; attempt++) {
      const current = await state()
      if (['failed', 'complete'].includes(current.phase)) return current
      await delay(500)
    }
    assert.fail('the installer did not finish')
  }
  const openApp = async () => fetch(server.origin + '/api/open-app', { headers })
  return { server, state, start, openApp }
}

const portFree = (port) => new Promise((resolve) => {
  const socket = createServer()
  socket.once('error', () => resolve(false))
  socket.listen(port, '127.0.0.1', () => socket.close(() => resolve(true)))
})

test('the reference installer fails, resumes, claims the owner and signs in through the outbox', { timeout: 30 * 60_000 }, async () => {
  const path = process.env.PATH
  const queueEnvironment = Object.fromEntries(['RER_JOBS_DIR', 'RER_JOBS_LOAD_THRESHOLD', 'RER_JOBS_MIN_FREE_MEMORY_BYTES', 'RER_SERVERS_LOAD_THRESHOLD', 'RER_SERVERS_MIN_MEMORY_BYTES', 'RER_JOB_POLICY', 'RER_JOB_MEMBERSHIP'].map(name => [name, process.env[name]]))
  const shim = join(copy.root, '../.temporary/failing-bin')
  await mkdir(shim, { recursive: true })
  // Let public CLI tool preflight use the real pinned pnpm; fail the intended
  // dependency installation itself, before any network action.
  await writeFile(join(shim, 'pnpm'), `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');\nif(process.argv[2]==='install'){console.log('forced dependency failure for the installer proof');process.exit(1);}\nconst result=spawnSync('pnpm',process.argv.slice(2),{stdio:'inherit',env:{...process.env,PATH:${JSON.stringify(path)}}});process.exit(result.status??1);\n`)
  await chmod(join(shim, 'pnpm'), 0o700)
  let installer
  try {
    process.env.RER_JOBS_DIR = join(shim, '../jobs')
    process.env.RER_JOBS_LOAD_THRESHOLD = '100000'
    process.env.RER_JOBS_MIN_FREE_MEMORY_BYTES = '0'
    process.env.RER_SERVERS_LOAD_THRESHOLD = '100000'
    process.env.RER_SERVERS_MIN_MEMORY_BYTES = '0'
    delete process.env.RER_JOB_POLICY
    delete process.env.RER_JOB_MEMBERSHIP
    // 1. A forced failing first attempt keeps the answers and shows the
    //    captured command failure with the canned guidance.
    process.env.PATH = `${shim}:${path}`
    installer = await open(false)
    const expectedDraft = { ...(await installer.state()).draft, ...answers }
    const failed = await installer.start(answers)
    process.env.PATH = path
    assert.equal(failed.phase, 'failed')
    const installEvents = failed.error.split('\n').flatMap(line => {
      try {
        const event = JSON.parse(line)
        return event.version === 1 && event.verb === 'install' ? [event] : []
      } catch { return [] }
    })
    assert.ok(installEvents.some(event => event.event === 'error' && event.exitCode === 1), 'the actual install command failed after tool preflight')
    const result = installEvents.find(event => event.event === 'result')
    assert.ok(result && result.ok === false && result.exitCode === 1, 'the public install result reports the dependency failure')
    assert.ok(failed.error.includes('forced dependency failure for the installer proof'), 'the intended dependency command produced the failure')
    assert.deepEqual((await installer.state()).draft, expectedDraft, 'the failed attempt retains defaults and supplied setup answers')
    await installer.server.close()

    // 2. Resume from saved answers and install for real.
    installer = await open(true)
    assert.deepEqual((await installer.state()).draft, expectedDraft)
    const complete = await installer.start(answers)
    assert.equal(complete.phase, 'complete', complete.error)
    const varsPath = join(copy.root, '.dev.vars')
    const varsBytes = await readFile(varsPath)
    const vars = Object.fromEntries(varsBytes.toString().trim().split('\n').map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]))
    assert.equal((await stat(varsPath)).mode & 0o777, 0o600)
    assert.equal(vars.OWNER_EMAIL, answers.OWNER_EMAIL)
    const origin = vars.AUTH_ORIGIN
    const appUrl = new URL(complete.appUrl)
    assert.equal(appUrl.origin, origin)
    assert.equal(appUrl.pathname, '/__dev/outbox')
    // The outbox opens through the key gate; the key never enters installer state.
    assert.equal(complete.devOpen, true)
    const key = { 'x-rer-dev-key': /^RER_DEV_KEY=(.+)$/m.exec(await readFile(join(copy.root, '.rer/local/dev-key.env'), 'utf8'))[1] }
    // Only the authenticated installer page receives the open link, key in its fragment.
    const opened = new URL((await (await installer.openApp()).json()).url)
    assert.deepEqual([opened.origin, opened.pathname, opened.search], [origin, '/__dev/key', ''])
    assert.equal(new URLSearchParams(opened.hash.slice(1)).get('rer-dev'), key['x-rer-dev-key'])
    assert.equal((await fetch(installer.server.origin + '/api/open-app')).status, 403, 'the open link needs the installer session')

    // 3. The running Worker is healthy and the bootstrap made the owner.
    assert.equal((await fetch(origin + '/health')).status, 200)
    assert.equal((await fetch(origin + '/__dev/outbox')).status, 404, 'the outbox needs the key gate')
    // Follow the newest captured message, just as the owner does, before
    // opening the ordinary sign-in link.
    const outbox = await (await fetch(origin + '/__dev/outbox', { headers: key })).text()
    const messageUrl = new URL(outbox.match(/<article>[\s\S]*?<a href="([^"]+\?message=[^"]+)"/)[1].replaceAll('&amp;', '&'), origin)
    assert.equal(messageUrl.origin + messageUrl.pathname, origin + '/__dev/outbox')
    const message = await (await fetch(messageUrl, { headers: key })).text()
    const link = new URL(message.match(/<a class="open" href="([^"]+)"/)[1].replaceAll('&amp;', '&'))
    assert.equal(link.origin + link.pathname, origin + '/auth/confirm')
    assert.equal((await fetch(link)).status, 200, 'the confirmation preview opens without signing in')
    const confirmed = await fetch(origin + '/auth/confirm', { method: 'POST', redirect: 'manual', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: link.searchParams.get('token') }) })
    assert.equal(confirmed.status, 303)
    const cookie = confirmed.headers.get('set-cookie').split(';')[0]
    const session = await (await fetch(origin + '/auth/session', { headers: { Cookie: cookie } })).json()
    assert.equal(session.operator.email, answers.OWNER_EMAIL)
    assert.equal(session.operator.role, 'owner')
    assert.equal(session.operator.displayName, answers.displayName)

    // 4. Diagnostics stay private and contain no generated credential.
    const logPath = join(copy.root, '.seed/installer/install.log')
    assert.equal((await stat(logPath)).mode & 0o777, 0o600)
    const log = await readFile(logPath, 'utf8')
    for (const secret of [vars.SESSION_SECRET, vars.SETUP_TOKEN, key['x-rer-dev-key']]) {
      assert.ok(secret && !log.includes(secret), 'the install log omits generated credentials')
      assert.ok(!JSON.stringify(complete).includes(secret), 'installer state omits generated credentials')
    }
    assert.match(log, /First owner claimed/)
    assert.deepEqual((await readdir(join(copy.root, 'dist'), { recursive: true })).filter((name) => name.includes('.dev.vars')), [])
    await assertDistExcludesSecrets(copy.root, [vars.SESSION_SECRET, vars.SETUP_TOKEN])
    await installer.server.close()
    assert.equal(await portFree(Number(new URL(origin).port)), true, 'closing the installer stops the application')

    // 5. A rerun keeps the owner's exact settings and the claimed owner.
    installer = await open(true)
    const rerun = await installer.start(answers)
    assert.equal(rerun.phase, 'complete', rerun.error)
    assert.ok((await readFile(varsPath)).equals(varsBytes), 'the rerun kept .dev.vars byte for byte')
    assert.equal(new URL(rerun.appUrl).origin, origin)
    assert.match(await readFile(logPath, 'utf8'), /An owner is already claimed; the existing owner was kept/)
    await installer.server.close()
    installer = undefined
    assert.equal(await portFree(Number(new URL(origin).port)), true)
  } finally {
    process.env.PATH = path
    await installer?.server.close()
    for (const [name, value] of Object.entries(queueEnvironment)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})
