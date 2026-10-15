import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const root = fileURLToPath(new URL('../../', import.meta.url))
const module = import.meta.resolve('../../scripts/base-onboarding/local/operation.mjs')
const { localOperation } = await import(module)

// Each starter is its own process, imports the real lock, then waits for one
// shared start signal. A holder keeps the lock until every starter has
// answered, so two answers of "held" mean two simultaneous owners.
const starter = `
import { localOperation } from ${JSON.stringify(module)};
import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin });
let operation;
console.log('ready');
for await (const line of lines) {
  if (line === 'go') {
    try { operation = await localOperation(process.argv[1]); console.log('held') }
    catch (error) { console.log(error.code === 'LOCAL_OPERATION_BUSY' ? 'busy' : 'error ' + error.message) }
  } else if (line === 'release') { await operation?.release(); process.exit(0) }
}
`

function start(dir) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', starter, dir], { stdio: ['pipe', 'pipe', 'inherit'] })
  const lines = createInterface({ input: child.stdout })
  const answers = []
  let waiting = []
  lines.on('line', (line) => { answers.push(line); for (const resolve of waiting) resolve(); waiting = [] })
  const next = async (count) => { while (answers.length < count) await new Promise((resolve) => waiting.push(resolve)) ; return answers[count - 1] }
  const exited = new Promise((resolve) => child.once('close', resolve))
  return { child, next, exited }
}

test('six simultaneous starters take over a stale lock with exactly one owner', { timeout: 120000 }, async (t) => {
  const parent = join(root, '.wrangler/local-setup-tests')
  await mkdir(parent, { recursive: true })
  const dir = await mkdtemp(join(parent, 'lock-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const directory = join(dir, '.wrangler/local-operation')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const lock = join(directory, 'active.json')
  for (let trial = 0; trial < 12; trial++) {
    // Alternate a lock whose process is gone with an old half-written one.
    if (trial % 2 === 0) await writeFile(lock, JSON.stringify({ pid: 2 ** 22 + 12345, token: 'dead' }), { mode: 0o600 })
    else {
      await writeFile(lock, '', { mode: 0o600 })
      const old = new Date(Date.now() - 60000)
      await utimes(lock, old, old)
    }
    const starters = Array.from({ length: 6 }, () => start(dir))
    try {
      await Promise.all(starters.map(({ next }) => next(1)))
      for (const { child } of starters) child.stdin.write('go\n')
      const answers = await Promise.all(starters.map(({ next }) => next(2)))
      assert.deepEqual(answers.filter((answer) => !['held', 'busy'].includes(answer)), [], `trial ${trial} answers`)
      assert.equal(answers.filter((answer) => answer === 'held').length, 1, `trial ${trial}: exactly one owner, got ${answers.join(', ')}`)
      await assert.rejects(localOperation(dir), { code: 'LOCAL_OPERATION_BUSY' }, 'the live winner excludes another caller')
      const winner = starters[answers.indexOf('held')]
      const owner = await readFile(lock)
      assert.equal(JSON.parse(owner).pid, winner.child.pid, `trial ${trial} lock belongs to the successful starter`)
      const refused = starters.filter(starter => starter !== winner)
      for (const { child } of refused) child.stdin.end('release\n')
      await Promise.all(refused.map(({ exited }) => exited))
      assert.ok(owner.equals(await readFile(lock)), `trial ${trial} refused starters cannot release the owner's lock`)
    } finally {
      for (const { child } of starters) if (child.exitCode === null) child.stdin.end('release\n')
      await Promise.all(starters.map(({ exited }) => exited))
    }
    const next = await localOperation(dir)
    await next.release()
  }
})
