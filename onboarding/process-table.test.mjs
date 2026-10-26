import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { readProcessIdentity, readProcessTable, sameBirth } from './process-table.mjs'

const transient = () => Object.assign(new Error('Could not read process identities.'), { transient: true })
const table = [{ pid: 4242, ppid: 1, pgid: 4242, uid: 501, state: 'S', birth: 'Thu Oct 15 12:30:00 2026' }]

// The process edge is the reader: ps can hand back a half-written row while a
// process exits, which must not end a cleanup whose own processes are known.
test('a transient process-table read is retried until it succeeds', async () => {
  let reads = 0
  const read = async () => { if (++reads < 4) throw transient(); return table }
  assert.deepEqual(await readProcessTable(5000, undefined, read), table)
  assert.equal(reads, 4)
})

test('a process table that never reads fails after its bound and extension, not before', async () => {
  let reads = 0
  const started = Date.now()
  await assert.rejects(readProcessTable(100, undefined, async () => { reads++; throw transient() }, 200), /Could not read process identities/)
  assert.ok(reads > 3, 'kept retrying')
  assert.ok(Date.now() - started > 200, 'retried through the extension')
  assert.ok(Date.now() - started < 1500, 'stayed within the extension')
})

// A seed's test cleanup (Uptime's browser suites) reads the table to find what
// its run left behind. A busy machine reading slower than the bound must not
// fail a run that passed, and cleanup still stops the stray it found.
test('a slow process table does not fail a passing run and its stray child is still stopped', async () => {
  const warnings = []
  const warned = (warning) => { if (warning.code === 'RER_PROCESS_INSPECTION_SLOW') warnings.push(warning) }
  process.on('warning', warned)
  const slow = async () => { await delay(400); return readProcessTable() }
  const run = spawn(process.execPath, [new URL('./fixtures/stray-child-run.mjs', import.meta.url).pathname], { detached: true, stdio: ['ignore', 'pipe', 'inherit'] })
  const exited = once(run, 'exit')
  const stray = Number((await once(run.stdout, 'data'))[0].toString())
  try {
    const table = await readProcessTable(100, undefined, slow, 10000)
    const owned = table.filter(row => row.pid === run.pid)
    for (const row of table) if (owned.some(parent => parent.pid === row.ppid)) owned.push(row)
    assert.ok(owned.some(row => row.pid === stray), 'the stray was found through the slow table')
    process.kill(-run.pid, 'SIGTERM')
    assert.deepEqual(await exited, [0, null], 'the run passed')
    for (const row of (await readProcessTable(100, undefined, slow, 10000)).filter(row => owned.some(old => sameBirth(old, row)))) process.kill(row.pid, 'SIGTERM')
    const gone = Date.now() + 10000
    while ((await readProcessTable(100, undefined, slow, 10000)).some(row => owned.some(old => sameBirth(old, row)) && !row.state.startsWith('Z')) && Date.now() < gone) await delay(50)
    const stopped = await readProcessIdentity(stray)
    assert.ok(!stopped || stopped.state.startsWith('Z'), 'the stray child has exited')
    await delay(0)
    assert.ok(warnings.length > 0, 'the slow inspection was reported as a warning')
  } finally {
    process.off('warning', warned)
    for (const pid of [-run.pid, stray]) try { process.kill(pid, 'SIGKILL') } catch {}
  }
})

test('a failure that is not transient is reported at once', async () => {
  let reads = 0
  await assert.rejects(readProcessTable(5000, undefined, async () => { reads++; throw new Error('boom') }), /boom/)
  assert.equal(reads, 1)
})
