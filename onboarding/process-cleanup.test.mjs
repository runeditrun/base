import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { readProcessIdentity } from './process-table.mjs'
import { stopOwnedGroup } from './process-cleanup.mjs'

async function zombieParent(t, { stubborn = false, count = 1 } = {}) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import {spawn} from 'node:child_process';
    ${stubborn ? "process.on('SIGTERM',()=>{});" : ''}
    const children=Array.from({length:${count}},()=>spawn('/bin/sh',['-c','exit 0'],{stdio:'ignore'}));
    console.log(JSON.stringify(children.map(child=>child.pid)));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
  `], { detached: true, stdio: ['ignore', 'pipe', 'inherit'] })
  const closed = once(child, 'close')
  t.after(async () => {
    if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL')
    await closed
  })
  const pids = JSON.parse((await once(child.stdout, 'data'))[0].toString())
  const deadline = Date.now() + 5000
  let zombies
  do {
    zombies = await Promise.all(pids.map(pid => readProcessIdentity(pid)))
    if (zombies.every(member => member?.state.startsWith('Z'))) return { child, closed, zombies }
    await delay(10)
  } while (Date.now() < deadline)
  assert.fail('The native parent did not leave its exited children unreaped')
}

test('zombie-only owned remains complete promptly without signalling their live parent', { timeout: 15000 }, async t => {
  const { child, zombies } = await zombieParent(t, { count: 8 })
  const start = Date.now()
  await stopOwnedGroup({ pid: zombies[0].pid, exitCode: 0, signalCode: null }, 'SIGTERM', zombies)
  assert.ok(Date.now() - start < 3000, 'exited children must not incur the cancellation wait')
  assert.equal(child.exitCode, null)
  assert.equal(child.signalCode, null)
  assert.ok(await readProcessIdentity(child.pid))
})

test('a live stubborn owner escalates despite zombie children and a denied kill fails loudly', { timeout: 15000 }, async t => {
  const first = await zombieParent(t, { stubborn: true })
  await stopOwnedGroup(first.child, 'SIGTERM')
  await first.closed
  assert.equal(first.child.signalCode, 'SIGKILL')

  const second = await zombieParent(t, { stubborn: true })
  const kill = process.kill
  let attempted = false
  process.kill = (pid, signal) => {
    if (pid === second.child.pid && signal === 'SIGKILL') {
      attempted = true
      throw Object.assign(new Error('Denied at the OS signal edge'), { code: 'EPERM' })
    }
    return kill(pid, signal)
  }
  try {
    await assert.rejects(stopOwnedGroup(second.child, 'SIGTERM'), /Could not send SIGKILL/)
    assert.equal(attempted, true)
    assert.ok((await readProcessIdentity(second.child.pid)) && second.child.exitCode === null)
  } finally { process.kill = kill }
})
