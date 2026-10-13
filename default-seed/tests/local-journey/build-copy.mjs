import assert from 'node:assert/strict'
import { copyProject } from './copy.mjs'
import { mkdir, mkdtemp, rm, statfs } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnOwnedProcess, stopOwnedProcess } from '../owned-process.mjs'

// A fresh, installed copy of the reference, so real builds can be interrupted
// and repeated without touching the developer's own default-seed state.
export async function freshBuildCopy() {
  const disk = await statfs(tmpdir())
  assert.ok(disk.bavail * disk.bsize >= 10 * 1024 ** 3, 'real build copy requires 10 GiB free disk')
  const directory = await mkdtemp(join(tmpdir(), 'default-seed-build-copy-'))
  const root = join(directory, 'default-seed')
  const temporary = join(directory, '.temporary')
  const env = {
    ...Object.fromEntries(['HTTP_PROXY','HTTPS_PROXY','NO_PROXY','NODE_EXTRA_CA_CERTS','SSL_CERT_FILE'].filter(name=>process.env[name]).map(name=>[name,process.env[name]])),
    PATH: process.env.PATH, HOME: process.env.HOME, CI: 'true',
    RER_JOBS_DIR: join(directory, 'jobs'), RER_JOBS_LOAD_THRESHOLD: '100000', RER_JOBS_MIN_FREE_MEMORY_BYTES: '0',
    RER_SERVERS_LOAD_THRESHOLD: '100000',
    RER_SERVERS_MIN_MEMORY_BYTES: '0',
    npm_config_child_concurrency: '1', npm_config_network_concurrency: '2',
    TMPDIR: temporary, TMP: temporary, TEMP: temporary,
    WRANGLER_LOG_PATH: join(temporary, 'wrangler.log'), WRANGLER_SEND_METRICS: 'false',
  }
  const children = new Set()
  // Runs a command in the copy and returns its exit code and combined output.
  // start() returns the owned child for callers that interrupt it.
  function start(command, args, cwd = root) {
    const child = spawnOwnedProcess('nice', ['-n', '15', command, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    children.add(child)
    child.output = ''
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (data) => { child.output += data })
    child.done = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => resolve({ code, signal, output: child.output }))
    })
    return child
  }
  async function run(command, args, cwd) {
    const child = start(command, args, cwd)
    try { return await child.done } finally { await stopOwnedProcess(child) }
  }
  async function close() {
    try { for (const child of children) await stopOwnedProcess(child) } finally { await rm(directory, { recursive: true, force: true }) }
  }
  try {
    await mkdir(temporary, { mode: 0o700 })
    await copyProject(root)
    const install = await run('pnpm', ['install', '--frozen-lockfile'], root)
    assert.equal(install.code, 0, `install in the build copy failed:\n${install.output.slice(-4000)}`)
    return { root, start, run, close }
  } catch (error) { await close(); throw error }
}
