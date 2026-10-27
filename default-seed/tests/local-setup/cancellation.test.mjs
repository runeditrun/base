import { runRows } from '../rows.mjs'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'

const root = fileURLToPath(new URL('../../', import.meta.url))
import { isProcessRunning as alive } from './process-liveness.mjs'

const cancellationRows = []

async function until(check, message) {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    if (await check()) return
    await delay(25)
  }
  assert.fail(message)
}

function pidExists(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}

async function fixture(t, phase, script = 'local-setup') {
  const parent = join(root, '.wrangler/local-setup-tests')
  await mkdir(parent, { recursive: true })
  const sandbox = await mkdtemp(join(parent, 'cancel-'))
  const dir = join(sandbox, 'default-seed')
  await mkdir(dir)
  await cp(join(root, 'scripts'), join(dir, 'scripts'), { recursive: true })
  await cp(join(root, 'tests/local-setup/fixtures'), join(dir, 'scripts'), { recursive: true })

  await cp(join(root, 'rer-setup.json'), join(dir, 'rer-setup.json'))
  await writeFile(join(dir, 'package.json'), '{"type":"module"}')
  await mkdir(join(dir, 'bin'))
  // Only the test substitutes pnpm. The real CLI, filesystem handling and
  // shared mail validator run against a child and a signal-resistant grandchild.
  await writeFile(join(dir, 'bin/pnpm'), `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
const phase = process.argv.includes('build') ? 'build' : 'migrations';
appendFileSync('calls.jsonl', JSON.stringify({phase}) + '\\n');
if (phase !== process.env.TEST_PENDING_PHASE) process.exit(0);
const descendant = spawn(process.execPath, ['-e', \`
  const { writeFileSync } = require('node:fs');
  process.on('SIGTERM', () => {});
  process.on('SIGINT', () => {});
  writeFileSync('descendant.pid', String(process.pid));
  setInterval(() => {}, 1000);
\`], { stdio: 'ignore' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  process.stdout.write('private stdout tail');
  process.stderr.write('private stderr tail');
  process.exit(0);
});
writeFileSync('command.pid', String(process.pid));
setInterval(() => {}, 1000);
`)
  await chmod(join(dir, 'bin/pnpm'), 0o700)
  let child
  let commandPid
  let descendantPid
  const survivor = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true })
  const survivorDone = new Promise((resolve) => survivor.once('close', resolve))
  let done
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    // PIDs here belong exclusively to this fixture; never search or kill by name.
    for (const pid of [descendantPid, commandPid, survivor.pid]) {
      if (pid && alive(pid)) process.kill(pid, 'SIGKILL')
    }
    await done
    await survivorDone
    await rm(sandbox, { recursive: true, force: true })
  })
  return { dir, survivor, start: async () => {
    let stdout = ''
    let stderr = ''
    child = spawn(process.execPath, [join(dir, `scripts/${script}.mjs`), ...(script === 'local-setup' ? ['--force', '--owner-email', 'owner@example.test'] : [])], {
      cwd: dir,
      env: { ...process.env, RER_LOCAL_OPERATION: '', PATH: `${join(dir, 'bin')}:${process.env.PATH}`, TEST_PENDING_PHASE: phase },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (data) => { stdout += data })
    child.stderr.on('data', (data) => { stderr += data })
    done = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
    })
    await until(async () => {
      try {
        commandPid = Number(await readFile(join(dir, 'command.pid'), 'utf8'))
        descendantPid = Number(await readFile(join(dir, 'descendant.pid'), 'utf8'))
        return true
      } catch (error) { if (error.code === 'ENOENT') return false; throw error }
    }, 'Pending command and descendant did not become ready')
    return { child, done, commandPid, descendantPid }
  } }
}

for (const phase of ['build', 'migrations']) {
  for (const signal of ['SIGTERM', 'SIGINT']) {
    cancellationRows.push([`${signal} during ${phase} restores exact credentials and stops only the owned process group`, { timeout: 15000 }, async (t) => {
      const { dir, survivor, start } = await fixture(t, phase)
      const varsPath = join(dir, '.dev.vars')
      const secret = randomBytes(32).toString('hex')
      const original = Buffer.from(`SESSION_SECRET=${secret}\nSETUP_TOKEN=${randomBytes(32).toString('hex')}\n`)
      await writeFile(varsPath, original, { mode: 0o640 })
      const originalStat = await stat(varsPath)
      const { child, done, commandPid, descendantPid } = await start()
      await assert.rejects(stat(varsPath), { code: 'ENOENT' })
      child.kill(signal)
      // A repeated signal must not bypass restoration while children settle.
      await delay(50)
      child.kill(signal)
      const result = await done
      assert.equal(result.code, 1)
      assert.equal(result.signal, null)
      assert.match(result.stderr, new RegExp(`Cancelled by ${signal}`))
      assert.match(result.stderr, phase === 'build' ? /during build/ : /during local migrations/)
      assert.ok(!result.stdout.includes('Local setup ready'))
      assert.ok((await readFile(varsPath)).equals(original), 'Original bytes restored')
      const restored = await stat(varsPath)
      assert.equal(restored.mode & 0o777, 0o640)
      assert.equal(restored.ino, originalStat.ino)
      assert.equal(restored.nlink, 1)
      await until(() => !alive(commandPid) && !alive(descendantPid), 'Owned command or descendant survived cancellation')
      await until(() => !pidExists(commandPid) && !pidExists(descendantPid), 'Owned command or descendant PID remained after cancellation')
      assert.ok(alive(survivor.pid), 'Unrelated process must survive')
      const runs = await readdir(join(dir, '.wrangler/local-setup'))
      assert.equal(runs.length, 1)
      const work = join(dir, '.wrangler/local-setup', runs[0])
      assert.deepEqual(await readdir(work), ['commands.log'])
      const log = await readFile(join(work, 'commands.log'), 'utf8')
      assert.match(log, /private stdout tail/)
      assert.match(log, /private stderr tail/)
      assert.equal((await stat(join(work, 'commands.log'))).mode & 0o777, 0o600)
      assert.ok(!`${result.stdout}${result.stderr}`.includes('private stdout tail'))
      assert.ok(!`${result.stdout}${result.stderr}`.includes('private stderr tail'))
      assert.ok(!`${result.stdout}${result.stderr}${log}`.includes(secret), 'Credentials must remain private')
      const calls = (await readFile(join(dir, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
      assert.deepEqual(calls.map((call) => call.phase), phase === 'build' ? ['build'] : ['build', 'migrations'])
    }])
  }
}

cancellationRows.push(['cancellation preserves a concurrent file and keeps the original privately for recovery', { timeout: 15000 }, async (t) => {
  const { dir, start } = await fixture(t, 'build')
  const path = join(dir, '.dev.vars')
  const original = randomBytes(48)
  const concurrent = randomBytes(48)
  await writeFile(path, original, { mode: 0o640 })
  const { child, done, commandPid, descendantPid } = await start()
  await writeFile(path, concurrent, { mode: 0o600 })
  child.kill('SIGTERM')
  const result = await done
  assert.equal(result.code, 1)
  assert.equal(result.signal, null)
  assert.match(result.stderr, /Original .dev.vars retained privately/)
  assert.ok((await readFile(path)).equals(concurrent), 'Concurrent file must not be replaced')
  const runs = await readdir(join(dir, '.wrangler/local-setup'))
  const backup = join(dir, '.wrangler/local-setup', runs[0], 'previous.dev.vars')
  assert.ok((await readFile(backup)).equals(original), 'Original backup must be retained')
  assert.equal((await stat(backup)).mode & 0o777, 0o640)
  await until(() => !alive(commandPid) && !alive(descendantPid), 'Owned command or descendant survived cancellation')
  await until(() => !pidExists(commandPid) && !pidExists(descendantPid), 'Owned command or descendant PID remained after cancellation')
}])

for (const signal of ['SIGINT', 'SIGTERM']) {
  cancellationRows.push([`ordinary build ${signal} restores exact credentials and stops its descendants`, { timeout: 15000 }, async (t) => {
    const { dir, survivor, start } = await fixture(t, 'build', 'local-build')
    const path = join(dir, '.dev.vars')
    const original = Buffer.from(`SESSION_SECRET=${randomBytes(32).toString('hex')}\nSETUP_TOKEN=${randomBytes(32).toString('hex')}\n`)
    await writeFile(path, original, { mode: 0o640 })
    const before = await stat(path)
    const { child, done, commandPid, descendantPid } = await start()
    await assert.rejects(stat(path), { code: 'ENOENT' })
    child.kill(signal)
    const result = await done
    assert.equal(result.code, 1)
    assert.match(result.stderr, new RegExp(`Cancelled by ${signal}`))
    assert.ok((await readFile(path)).equals(original), 'exact build credentials restored')
    const restored = await stat(path)
    assert.equal(restored.ino, before.ino)
    assert.equal(restored.mode & 0o777, 0o640)
    assert.equal(restored.nlink, 1)
    assert.deepEqual(await readdir(join(dir, '.wrangler/local-build')), [], 'build recovery directory cleaned')
    await until(() => !pidExists(commandPid) && !pidExists(descendantPid), 'Build descendants survived cancellation')
    assert.ok(alive(survivor.pid), 'Unrelated process survives')
  }])
}

test("cancelled local operations restore private credentials and stop only their descendants", async t => {
  await runRows(t, cancellationRows)
})
