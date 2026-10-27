import { loopbackFetch as fetch } from '../../scripts/base-onboarding/loopback-fetch.mjs'
import assert from 'node:assert/strict'
import { copyProject } from './copy.mjs'
import { mkdir, mkdtemp, open, readFile, rm, statfs, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { StringDecoder } from 'node:string_decoder'
import { assertDistExcludesSecrets, readmeCommands } from './readme.mjs'
import { spawnOwnedProcess, stopOwnedProcess } from '../owned-process.mjs'
import { freePort } from '../ports.mjs'
import { servingLoadThreshold } from '../../scripts/base-cli/cli/server-resources.mjs'

const execute = promisify(execFile)
const repo = fileURLToPath(new URL('../../../', import.meta.url))

async function resources(env) {
  const disk = await statfs(tmpdir())
  assert.ok(disk.bavail * disk.bsize >= 15 * 1024 ** 3, 'fresh-copy journey requires 15 GiB free disk')
  if (process.platform !== 'darwin') return
  await execute('vm_stat')
  const threshold = servingLoadThreshold(env)
  for (let attempt = 0; attempt <= 20; attempt++) {
    const { stdout } = await execute('sysctl', ['-n', 'vm.loadavg'])
    if (Number(stdout.match(/[\d.]+/)[0]) <= threshold) return
    assert.ok(attempt < 20, `machine load stayed above ${threshold} for 20 minutes`)
    await delay(60_000)
  }
}

export async function freshLocalProject(owner) {
  const servingEnvironment = { RER_SERVERS_LOAD_THRESHOLD: '100000', RER_SERVERS_MIN_MEMORY_BYTES: '0' }
  await resources(servingEnvironment)
  const directory = await mkdtemp(join(tmpdir(), 'default-seed-local-journey-'))
  const root = join(directory, 'default-seed')
  const temporary = join(directory, '.temporary')
  await mkdir(temporary, { mode: 0o700 })
  const logs = join(repo, 'default-seed/.wrangler/local-journey-logs')
  await mkdir(logs, { recursive: true, mode: 0o700 })
  const logDirectory = await mkdtemp(join(logs, 'run-'))
  const logPath = join(logDirectory, 'commands.log')
  const log = await open(logPath, 'wx', 0o600)
  const secrets = []
  let writes = Promise.resolve()
  function record(text) {
    for (const secret of secrets) text = text.replaceAll(secret, '[redacted]')
    text = text.replace(/([?&]token=)[^\s"'<>]+/g, '$1[redacted]')
      .replace(/((?:SESSION_SECRET|SETUP_TOKEN|MAIL_API_KEY)\s*[:=]\s*)[^\s]+/g, '$1[redacted]')
    writes = writes.then(() => log.writeFile(text))
  }
  function capture(child, collect) {
    for (const stream of [child.stdout, child.stderr]) {
      const decoder = new StringDecoder('utf8')
      let pending = ''
      stream.on('data', (chunk) => {
        pending += decoder.write(chunk)
        const end = pending.lastIndexOf('\n')
        if (end >= 0) { const line = pending.slice(0, end + 1); record(line); collect?.(line); pending = pending.slice(end + 1) }
      })
      stream.on('end', () => { const tail = pending + decoder.end(); record(tail); collect?.(tail) })
    }
  }
  const env = {
    ...servingEnvironment,
    ...Object.fromEntries(['HTTP_PROXY','HTTPS_PROXY','NO_PROXY','NODE_EXTRA_CA_CERTS','SSL_CERT_FILE'].filter(name=>process.env[name]).map(name=>[name,process.env[name]])),
    PATH: process.env.PATH, HOME: process.env.HOME, CI: 'true',
    RER_JOBS_DIR: join(directory, 'jobs'), RER_JOBS_LOAD_THRESHOLD: '100000', RER_JOBS_MIN_FREE_MEMORY_BYTES: '0',
    RER_SERVERS_DIR: join(directory, 'servers'),
    npm_config_child_concurrency: '1', npm_config_network_concurrency: '2',
    TMPDIR: temporary, TMP: temporary, TEMP: temporary,
    WRANGLER_LOG_PATH: join(temporary, 'wrangler.log'),
    WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false',
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
  }
  let worker
  async function command(args, cwd = root) {
    await resources(env)
    record(`Phase: pnpm ${args.join(' ')}\n`)
    const child = spawnOwnedProcess('nice', ['-n', '15', 'pnpm', ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    capture(child, (text) => { output += text })
    try {
      const code = await new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('close', resolve)
      })
      if (code !== 0) {
        record(await readFile(join(root,'.seed/installer/install.log'),'utf8').catch(()=>''))
        throw new Error(`local journey command ${args[0]} failed (${code}); private diagnostics: ${logPath}`)
      }
      return output
    } finally { await stopOwnedProcess(child) }
  }
  async function stop() { const current = worker; worker = undefined; await stopOwnedProcess(current) }
  let documented
  async function start(origin, args = documented.dev) {
    await resources(env)
    record(`Phase: pnpm ${args.join(' ')}\n`)
    worker = spawnOwnedProcess('nice', ['-n', '15', 'pnpm', ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    capture(worker)
    for (let attempt = 0; attempt < 1200; attempt++) {
      assert.equal(worker.exitCode, null, `the documented dev server remains running; private diagnostics: ${logPath}`)
      try { if ((await fetch(`${origin}/health`)).status === 200) return } catch {}
      await delay(100)
    }
    assert.fail(`the documented dev server did not become healthy; private diagnostics: ${logPath}`)
  }
  async function close() {
    try { await stop() } finally {
      try { await writes; await log.close() } finally { await rm(directory, { recursive: true, force: true }) }
    }
  }
  try {
    await copyProject(root)
    const port = await freePort()
    documented = await readmeCommands(root, owner, port)
    assert.equal(join(directory, documented.directory), root, 'README cd command selects the tested working directory')
    record(`README fences: ${JSON.stringify(documented.fences)}\nREADME example substitutions: ${JSON.stringify(documented.substitutions)}\n`)
    await execute('git', ['init', '--quiet'], { cwd: directory, env })
    const ignores = ['.dev.vars', '.dev.vars.previous', '.wrangler/probe', 'dist/probe'].map((path) => `default-seed/${path}`)
    const ignored = await execute('git', ['check-ignore', '--no-index', ...ignores], { cwd: directory, env })
    assert.deepEqual(ignored.stdout.trim().split('\n'), ignores, 'credentials, backup, persistence and dist are ignored in a fresh checkout')
    await command(documented.install)
    await command(documented.setup)
    const vars = Object.fromEntries((await readFile(join(root, '.dev.vars'), 'utf8')).trim().split('\n').map((line) => {
      const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]
    }))
    assert.equal(vars.AUTH_ORIGIN, `http://127.0.0.1:${port}`)
    assert.equal(vars.MAIL_PROVIDER, 'development')
    assert.equal(vars.AUTH_LOCAL, 'true')
    assert.notEqual(vars.SESSION_SECRET, vars.SETUP_TOKEN)
    assert.ok(vars.SESSION_SECRET.length >= 32 && vars.SETUP_TOKEN.length >= 32)
    // Setup writes the checkout's dev key beside, not inside, the private settings.
    vars.RER_DEV_KEY = /^RER_DEV_KEY=(.+)$/m.exec(await readFile(join(root, '.rer/local/dev-key.env'), 'utf8'))[1]
    secrets.push(vars.SESSION_SECRET, vars.SETUP_TOKEN, vars.RER_DEV_KEY)
    await assertDistExcludesSecrets(root, secrets)
    // This is the README's source-edit/rebuild/restart procedure, with .dev.vars
    // already present. The changed page proves the dev server serves the new build.
    const sourcePath = join(root, 'src/routes/reference.tsx')
    const source = await readFile(sourcePath, 'utf8')
    assert.ok(source.includes('Reference snapshot'))
    await writeFile(sourcePath, source.replace('Reference snapshot', 'Local rebuilt reference'))
    const originalVars = await readFile(join(root, '.dev.vars'))
    await command(documented.rebuild)
    assert.ok((await readFile(join(root, '.dev.vars'))).equals(originalVars), 'ordinary documented rebuild preserves credentials exactly')
    await assertDistExcludesSecrets(root, secrets)
    await start(vars.AUTH_ORIGIN, documented.restart)
    assert.match(await (await fetch(`${vars.AUTH_ORIGIN}/reference`)).text(), /Local rebuilt reference/, 'documented rebuild serves edited source')
    return { root, origin: vars.AUTH_ORIGIN, vars, command, stop, start, close, logPath, temporary,
      rerunSetup: () => command(documented.rerun),
      readme: { fences: documented.fences, substitutions: documented.substitutions },
      assertDist: () => assertDistExcludesSecrets(root, secrets) }
  } catch (error) { await close(); throw error }
}
