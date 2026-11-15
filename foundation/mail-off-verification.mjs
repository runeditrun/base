import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawnSync, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { userInfo } from 'node:os'
import { deployEnvironment } from '../cli/deploy-inputs.mjs'
import { secretBindings } from '../modules/deploy-kit/worker.mjs'
import { serveHosted } from '../cli/hosted-output.mjs'
import { productionSender } from '../cli/fixtures/production-sender.mjs'

// A composed foundation through the public deploy command and its real built
// Worker. Only disposable local state is used; no provider is contacted.
export async function verifyMailOff(root) {
 const directory = join(root, '.rer/mail-off-check')
 await mkdir(directory, { recursive: true })
 const envFile = '.rer/mail-off-check/inputs.env'
 const env = { PATH: process.env.PATH, HOME: process.env.HOME, CI: 'true', RER_NODE_AUTO: '0', WRANGLER_SEND_METRICS: 'false' }
 for (const name of ['RER_JOBS_DIR', 'RER_SERVERS_DIR', 'RER_DOOR_DIR', 'PLAYWRIGHT_BROWSERS_PATH']) if (process.env[name]) env[name] = process.env[name]
 const run = (expectedFailure, dryRun = false) => {
  // writeFile is awaited by the caller before launching this command.
  const result = spawnSync(process.execPath, ['scripts/rer.mjs', 'deploy', '--env-file', envFile, '--non-interactive', '--owner-name', 'Morgan Ellis', ...(dryRun ? ['--dry-run'] : ['--json'])], { cwd: root, env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  assert.ifError(result.error)
  assert.equal(result.status, dryRun ? 0 : 4, result.stdout + result.stderr)
  if (dryRun) return result.stdout + result.stderr
  const events = result.stdout.trim().split('\n').filter(Boolean).map(JSON.parse)
  assert.match(events.find(event => event.event === 'error')?.message ?? '', expectedFailure)
  return events
 }
 const inputs = values => writeFile(join(root, envFile), values, { mode: 0o600 })
 for (const values of ['', 'MAIL_PROVIDER=resend\n', `MAIL_PROVIDER=resend\nMAIL_FROM=${productionSender}\n`]) {
  await inputs(values)
  run(/Production sign-in is not configured/)
 }
 await inputs('MAIL_PROVIDER=none\nMAIL_API_KEY=synthetic-conflicting-credential\n')
 run(/MAIL_PROVIDER=.*turns outbound email off.*MAIL_API_KEY/)
 await inputs('MAIL_PROVIDER=none\nOWNER_EMAIL=morgan@example.test\n')
 const text = run(undefined, true)
 assert.match(text, /Outbound email is off/)
 assert.match(text, /rer signin/)
 assert.doesNotMatch(text, /production sign-in mail/)

 // Use the actual deployment binding resolver, not a no-op mail adapter.
 const declaration = JSON.parse(await readFile(join(root, 'deploy.json'), 'utf8'))
 const setupManifest = JSON.parse(await readFile(join(root, 'rer-setup.json'), 'utf8'))
 const production = await deployEnvironment({ root, declaration, setupManifest, options: { envFile } })
 const planned = await secretBindings({ request() { assert.fail('first-deploy bindings need no provider call') } }, 'mail-off-check', { secrets: declaration.secrets }, production.env, false)
 const bindings = Object.fromEntries(planned.bindings.map(item => [item.name, item.text]))
 assert.equal(bindings.MAIL_PROVIDER, 'none')
 assert.equal(bindings.MAIL_API_KEY, undefined)
 assert.equal(bindings.MAIL_FROM, undefined)
 // Clear hosted-check stand-ins too: this journey must run without a sender
 // or credential, just as the real deployment binding resolver above does.
 const hosted = await serveHosted(root, { bindings: { ...bindings, MAIL_FROM: '', MAIL_API_KEY: '' } })
 try {
  assert.equal((await hosted.fetch('health')).status, 200)
  assert.equal((await hosted.fetch('')).status, 200)
  assert.equal((await hosted.fetch('app')).status, 303)
  assert.equal((await hosted.fetch('auth/session')).status, 401)
  for (const email of ['morgan@example.test', 'unknown@example.test']) {
   const result = await hosted.fetch('auth/magic-link', { method: 'POST', headers: { Origin: hosted.origin, 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.40' }, body: JSON.stringify({ email }) })
   assert.equal(result.status, 503)
   assert.equal((await result.json()).error, 'mail_unavailable')
  }
  const headers = { Origin: hosted.origin, 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.41' }
  const claimed = await hosted.fetch('auth/bootstrap', { method: 'POST', headers, body: JSON.stringify({ token: bindings.SETUP_TOKEN, displayName: 'Morgan Ellis' }) })
  assert.equal(claimed.status, 303)
  const cookie = claimed.headers.get('set-cookie').split(';')[0]
  const session = await hosted.fetch('auth/session', { headers: { Cookie: cookie } })
  assert.equal(session.status, 200)
  assert.equal((await session.json()).operator.email, 'morgan@example.test')
  const renamed = await hosted.fetch('auth/display-name', { method: 'POST', headers: { ...headers, Cookie: cookie }, body: JSON.stringify({ displayName: 'Morgan Ellis, Operations' }) })
  assert.equal(renamed.status, 200)
  const invitation = await hosted.fetch('auth/invite', { method: 'POST', headers: { ...headers, Cookie: cookie }, body: JSON.stringify({ email: 'sam@example.test', displayName: 'Sam Chen', role: 'member' }) })
  assert.equal(invitation.status, 503)
  assert.equal((await invitation.json()).error, 'mail_unavailable')
  if (process.env.RER_MAIL_OFF_SCREENSHOTS) {
   const server = createServer(async (request, response) => {
    try {
     const answer = await hosted.fetch(request.url.slice(1), { headers: { ...request.headers, 'accept-encoding': 'identity' } })
     const headers = new Headers(answer.headers)
     // Fetch decodes transfer/content encodings before arrayBuffer().
     for (const name of ['content-encoding', 'content-length', 'transfer-encoding', 'connection']) headers.delete(name)
     response.writeHead(answer.status, Object.fromEntries(headers))
     response.end(Buffer.from(await answer.arrayBuffer()))
    } catch { response.writeHead(500); response.end() }
   })
   await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
   try {
    const browser = spawn(process.execPath, [new URL('./mail-off-browser.mjs', import.meta.url).pathname, root, `http://127.0.0.1:${server.address().port}`, process.env.RER_MAIL_OFF_SCREENSHOTS], { stdio: 'inherit', env: { ...process.env, HOME: userInfo().homedir } })
    const code = await new Promise((resolve, reject) => { browser.once('error', reject); browser.once('exit', resolve) })
    assert.equal(code, 0)
   } finally { await new Promise(resolve => server.close(resolve)) }
  }
 } finally { await hosted.close() }
 console.log('Foundation mail-off public flow passed: offline deploy, actual none binding without mail credentials, healthy nonmail HTTP, unavailable delivery, enabled/missing and conflicting inputs refused; private routes remain protected.')
}
