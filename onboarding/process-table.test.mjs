import assert from 'node:assert/strict'
import test from 'node:test'
import { readProcessTable } from './process-table.mjs'

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

test('a process table that never reads fails within its bound, not before it', async () => {
  let reads = 0
  const started = Date.now()
  await assert.rejects(readProcessTable(300, undefined, async () => { reads++; throw transient() }), /Could not read process identities/)
  assert.ok(reads > 3, 'kept retrying')
  assert.ok(Date.now() - started < 1500, 'stayed within the bound')
})

test('a failure that is not transient is reported at once', async () => {
  let reads = 0
  await assert.rejects(readProcessTable(5000, undefined, async () => { reads++; throw new Error('boom') }), /boom/)
  assert.equal(reads, 1)
})
