import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { isProcessRunning as alive } from './process-liveness.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const execute = promisify(execFile)

// The real setup, build and dev fixture scripts run against a substitute pnpm and
// git. TEST_HANG holds the build open so the test can SIGKILL it mid-build, the
// way an out-of-memory kill or power loss would: no handler or finally runs.
const mock = `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
if (basename(process.argv[1]) === 'git') { console.log('owner@example.test'); process.exit(0); }
const args = process.argv.slice(2);
let varsPresent = true; try { readFileSync('.dev.vars') } catch { varsPresent = false }
appendFileSync('calls.jsonl', JSON.stringify({ args, varsPresent }) + '\\n');
if (process.env.TEST_HANG && args.includes('build')) { writeFileSync('command.pid', String(process.pid)); setInterval(() => {}, 1000); }
else if (args.includes('--json')) console.log(JSON.stringify([{ results: [{ claimed: 0 }] }]));
else console.log('child output');
`

export async function scriptFixture(t) {
  const parent = join(root, '.wrangler/local-setup-tests')
  await mkdir(parent, { recursive: true })
  const sandbox = await mkdtemp(join(parent, 'kill-'))
  const dir = join(sandbox, 'default-seed')
  await mkdir(join(dir, 'bin'), { recursive: true })
  await cp(join(root, 'scripts'), join(dir, 'scripts'), { recursive: true })
  await cp(join(root, 'tests/local-setup/fixtures'), join(dir, 'scripts'), { recursive: true })

  await cp(join(root, 'rer-setup.json'), join(dir, 'rer-setup.json'))
  await writeFile(join(dir, 'package.json'), '{"type":"module"}')
  for (const name of ['git', 'pnpm']) {
    await writeFile(join(dir, 'bin', name), mock)
    await chmod(join(dir, 'bin', name), 0o700)
  }
  const pids = new Set()
  t.after(async () => {
    for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL')
    await rm(sandbox, { recursive: true, force: true })
  })
  const env = (extra = {}) => ({ ...process.env, RER_LOCAL_OPERATION: '', ...extra, PATH: `${join(dir, 'bin')}:${process.env.PATH}` })
  const fixture = {
    dir,
    async run(script, args = [], extra = {}) {
      try {
        return { code: 0, ...await execute(process.execPath, [join(dir, `scripts/${script}.mjs`), ...args], { cwd: dir, env: env(extra) }) }
      } catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr } }
    },
    // Starts a build or setup and waits until its build command runs with
    // .dev.vars hidden. kill() then SIGKILLs the script and its build command.
    async hang(script, args = []) {
      await rm(join(dir, 'command.pid'), { force: true })
      const child = spawn(process.execPath, [join(dir, `scripts/${script}.mjs`), ...args], { cwd: dir, env: env({ TEST_HANG: '1' }), stdio: ['ignore', 'ignore', 'pipe'] })
      pids.add(child.pid)
      let stderr = ''
      child.stderr.on('data', (data) => { stderr += data })
      const exited = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal, stderr })))
      let commandPid
      for (let attempt = 0; attempt < 400 && !commandPid; attempt++) {
        commandPid = Number(await readFile(join(dir, 'command.pid'), 'utf8').catch(() => '')) || undefined
        if (!commandPid) await delay(25)
      }
      assert.ok(commandPid, `${script} reached its build command`)
      pids.add(commandPid)
      return {
        child, commandPid, exited,
        async kill() {
          child.kill('SIGKILL')
          process.kill(commandPid, 'SIGKILL')
          assert.equal((await exited).signal, 'SIGKILL')
          for (let attempt = 0; attempt < 200 && alive(commandPid); attempt++) await delay(25)
          assert.equal(alive(commandPid), false, 'killed build command stopped')
        },
      }
    },
    async hardKill(script, args = []) { await (await fixture.hang(script, args)).kill() },
    async calls() {
      return (await readFile(join(dir, 'calls.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse)
    },
  }
  return fixture
}
