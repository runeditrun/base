import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { readProcessIdentity } from './process-table.mjs'
import { createCommands } from './commands.mjs'

async function commands(t) {
  const root = await mkdtemp(join(tmpdir(), 'zombie-command-'))
  const store = await createCommands(root, { logs: [] }, { terminal: () => {} })
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  return { root, store }
}

const program = release => `
  const {spawn}=require('node:child_process'),fs=require('node:fs');
  process.on('SIGTERM',()=>{});
  const pids=Array.from({length:8},()=>spawn('/bin/sh',['-c','exit 0'],{stdio:'ignore'}).pid);
  console.log(JSON.stringify(pids));
  while(!${release ? `fs.existsSync(${JSON.stringify(release)})` : 'false'}) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);
  process.exit(0);
`
async function zombies(child) {
  const pids = JSON.parse((await once(child.stdout, 'data'))[0].toString())
  const deadline = Date.now() + 5000
  do {
    const rows = await Promise.all(pids.map(pid => readProcessIdentity(pid)))
    if (rows.every(member => member?.state.startsWith('Z'))) return pids
    await delay(10)
  } while (Date.now() < deadline)
  assert.fail('The native command did not leave its exited children unreaped')
}
function collect(t, child) {
  const closed = once(child, 'close')
  t.after(async () => {
    if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL')
    await closed
  })
  return closed
}

test('a successful command with only exited children closes promptly without signalling zombies', { timeout: 15000 }, async t => {
  const { root, store } = await commands(t)
  const release = join(root, 'release')
  let child
  const running = store.run('Zombie children', process.execPath, ['-e', program(release)], { onChild: value => { child = value } })
  collect(t, child)
  t.after(() => store.closeCommands())
  const pids = await zombies(child)
  const kill = process.kill, signals = []
  process.kill = (pid, signal) => { signals.push({ pid, signal }); return kill(pid, signal) }
  const start = Date.now()
  try {
    await writeFile(release, '')
    await running
    await store.closeCommands()
  } finally { process.kill = kill }
  assert.equal(child.exitCode, 0)
  assert.ok(Date.now() - start < 3000, 'exited children must not incur the cancellation wait')
  assert.deepEqual(signals.filter(row => pids.includes(row.pid)), [])
})

test('command cancellation escalates a live stubborn child and a denied kill fails loudly', { timeout: 15000 }, async t => {
  const { store } = await commands(t)
  const first = store.spawn('Stubborn owner', process.execPath, ['-e', program()])
  const closed = collect(t, first)
  await zombies(first)
  await store.stop(first)
  await closed
  assert.equal(first.signalCode, 'SIGKILL')

  const second = store.spawn('Denied termination', process.execPath, ['-e', program()])
  const secondClosed = collect(t, second)
  await zombies(second)
  const kill = process.kill
  let attempted = false
  process.kill = (pid, signal) => {
    if (pid === second.pid && signal === 'SIGKILL') {
      attempted = true
      throw Object.assign(new Error('Denied at the OS signal edge'), { code: 'EPERM' })
    }
    return kill(pid, signal)
  }
  try {
    await assert.rejects(store.stop(second), /Could not send SIGKILL/)
    assert.equal(attempted, true)
    assert.ok((await readProcessIdentity(second.pid)) && second.exitCode === null)
  } finally {
    process.kill = kill
    second.kill('SIGKILL')
    await secondClosed
    await assert.rejects(store.closeCommands(), /Could not send SIGKILL/)
  }
})
