import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { readProcessTable, sameBirth } from './process-table.mjs'
import { uncheckedInspection } from './process-diagnostics.mjs'

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

test('an unreadable process table is unchecked within its bound', async () => {
  const started = Date.now()
  await assert.rejects(readProcessTable(100, undefined, async () => { throw transient() }), uncheckedInspection)
  await assert.rejects(readProcessTable(100, undefined, async () => new Promise(() => {})), uncheckedInspection)
  assert.ok(Date.now() - started < 1500, 'unresponsive readers cannot hang cleanup')
})

// A seed's test cleanup (Uptime's browser suites) reads the table to find what
// its run left behind. A slow read inside the deadline must still discover
// and stop the real stray, rather than merely return a synthetic table.
test('a slow process table does not fail a passing run and its stray child is still stopped', async () => {
  const slow = async () => { await delay(400); return readProcessTable() }
  const run = spawn(process.execPath, [new URL('./fixtures/stray-child-run.mjs', import.meta.url).pathname], { detached: true, stdio: ['ignore', 'pipe', 'inherit'] })
  const exited = once(run, 'exit')
  const stray = Number((await once(run.stdout, 'data'))[0].toString())
  try {
    const table = await readProcessTable(3000, undefined, slow)
    const owned = table.filter(row => row.pid === run.pid)
    for (const row of table) if (owned.some(parent => parent.pid === row.ppid)) owned.push(row)
    assert.ok(owned.some(row => row.pid === stray), 'the stray was found through the slow table')
    process.kill(-run.pid, 'SIGTERM')
    assert.deepEqual(await exited, [0, null], 'the run passed')
    for (const row of (await readProcessTable(3000, undefined, slow)).filter(row => owned.some(old => sameBirth(old, row)))) process.kill(row.pid, 'SIGTERM')
    const gone = Date.now() + 10000
    while ((await readProcessTable(3000, undefined, slow)).some(row => owned.some(old => sameBirth(old, row)) && !row.state.startsWith('Z')) && Date.now() < gone) await delay(50)
    assert.throws(() => process.kill(stray, 0), { code: 'ESRCH' }, 'the stray child was stopped')
  } finally {
    for (const pid of [-run.pid, stray]) try { process.kill(pid, 'SIGKILL') } catch {}
  }
})

test('a failure that is not transient is reported at once', async () => {
  let reads = 0
  await assert.rejects(readProcessTable(5000, undefined, async () => { reads++; throw new Error('boom') }), uncheckedInspection)
  assert.equal(reads, 1)
})
