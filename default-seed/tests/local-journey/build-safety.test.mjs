import { runRows } from '../rows.mjs'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { after, before, test } from 'node:test'
import { freshBuildCopy } from './build-copy.mjs'
import { assertDistExcludesSecrets } from './readme.mjs'
import { liveOwnedGroup } from '../owned-process-group.mjs'

const buildRows = []


const execute = promisify(execFile)
let copy
before(async () => { copy = await freshBuildCopy() }, { timeout: 20 * 60_000 })
after(async () => { await copy?.close() })

async function credentials() {
  const secrets = [randomBytes(32).toString('hex'), randomBytes(32).toString('hex')]
  const bytes = Buffer.from(`OWNER_EMAIL=owner@example.test\nAUTH_LOCAL=true\nAUTH_ORIGIN=http://127.0.0.1:8787\nSESSION_SECRET=${secrets[0]}\nSETUP_TOKEN=${secrets[1]}\nMAIL_PROVIDER=development\nMAIL_FROM=auth@localhost.test\n`)
  const path = join(copy.root, '.dev.vars')
  await rm(path, { force: true })
  await writeFile(path, bytes, { mode: 0o600 })
  return { path, bytes, secrets, status: await stat(path) }
}

const tail = (output, secrets) => secrets.reduce((text, secret) => text.replaceAll(secret, '[redacted]'), output.slice(-4000))

async function localVariableFiles(directory) {
  const found = []
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
    if (entry.name.startsWith('.dev.vars')) found.push(join(entry.parentPath, entry.name))
  }
  return found
}

for (const command of [['pnpm', 'exec', 'vite', 'build'], ['npx', 'vite', 'build']]) {
  buildRows.push([`a direct \`${command.join(' ')}\` with .dev.vars present succeeds and emits no local credentials`, { timeout: 15 * 60_000 }, async () => {
    const { path, bytes, secrets } = await credentials()
    await rm(join(copy.root, 'dist'), { recursive: true, force: true })
    const result = await copy.run(command[0], command.slice(1))
    assert.equal(result.code, 0, tail(result.output, secrets))
    assert.match(result.output, /Prerendered 1 pages/, 'prerender ran with .dev.vars present')
    assert.deepEqual(await localVariableFiles(join(copy.root, 'dist')), [], 'no .dev.vars in dist')
    await assertDistExcludesSecrets(copy.root, secrets)
    assert.ok((await readFile(path)).equals(bytes), '.dev.vars itself is untouched')
  }])
}

buildRows.push(['a SIGKILLed real build strands nothing: the next pnpm build restores .dev.vars', { timeout: 15 * 60_000 }, async () => {
  const { path, bytes, secrets, status } = await credentials()
  const build = copy.start('pnpm', ['build'])
  // Wait until local-build has hidden .dev.vars and Vite is building.
  let vite
  for (let attempt = 0; attempt < 6000 && !vite; attempt++) {
    assert.equal(build.exitCode, null, `build ended before it could be interrupted:\n${tail(build.output, secrets)}`)
    if (/vite v\d|transforming|building/i.test(build.output) && !await stat(path).catch(() => undefined)) {
      // runCommand starts Vite in its own process group under local-build.
      const { stdout } = await execute('ps', ['-Ao', 'pid=,ppid=,pgid='])
      const rows = stdout.trim().split('\n').map((line) => line.trim().split(/\s+/).map(Number))
      const inGroup = new Set(rows.filter(([, , group]) => group === build.pid).map(([pid]) => pid))
      vite = rows.find(([pid, parent, group]) => inGroup.has(parent) && group === pid)?.[0]
    }
    if (!vite) await delay(50)
  }
  assert.ok(vite, 'found the running Vite build group')
  // A hard kill of everything: no signal handler, finally block or restore runs.
  for (const group of [build.pid, vite]) process.kill(-group, 'SIGKILL')
  assert.equal((await build.done).signal, 'SIGKILL')
  for (let attempt = 0; attempt < 200 && (await liveOwnedGroup(vite, 1000) || await liveOwnedGroup(build.pid, 1000)); attempt++) await delay(50)
  assert.equal(await liveOwnedGroup(vite, 1000), false, 'Vite build group stopped')

  await assert.rejects(stat(path), { code: 'ENOENT' }, 'the hard kill stranded .dev.vars')
  const runs = await readdir(join(copy.root, '.wrangler/local-build'))
  assert.equal(runs.length, 1)
  const run = join(copy.root, '.wrangler/local-build', runs[0])
  const originals = (await readdir(run)).filter(name => name.startsWith('original.'))
  assert.equal(originals.length, 1, 'one private original was retained')
  const hidden = join(run, originals[0])
  assert.ok((await readFile(hidden)).equals(bytes), 'the original waits privately under .wrangler')

  const next = await copy.run('pnpm', ['build'])
  assert.equal(next.code, 0, tail(next.output, secrets))
  assert.ok(next.output.includes(`Restored .dev.vars from an interrupted build or setup (${hidden}).`), tail(next.output, secrets))
  assert.ok((await readFile(path)).equals(bytes), 'exact bytes restored')
  const restored = await stat(path)
  assert.equal(restored.ino, status.ino)
  assert.equal(restored.mode & 0o777, 0o600)
  assert.equal(restored.nlink, 1)
  await assert.rejects(stat(hidden), { code: 'ENOENT' })
  await assertDistExcludesSecrets(copy.root, secrets)
}])

test('real builds retain private credentials through direct commands and interrupted recovery', async t => {
  await runRows(t, buildRows)
})
