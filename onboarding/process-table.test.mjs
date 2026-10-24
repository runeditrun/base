import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { readProcessTable } from './process-table.mjs'
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

test('a slow successful read still returns the observed table', async () => {
  assert.deepEqual(await readProcessTable(1000, undefined, async () => { await delay(100); return table }), table)
})

test('a failure that is not transient is reported at once', async () => {
  let reads = 0
  await assert.rejects(readProcessTable(5000, undefined, async () => { reads++; throw new Error('boom') }), uncheckedInspection)
  assert.equal(reads, 1)
})
