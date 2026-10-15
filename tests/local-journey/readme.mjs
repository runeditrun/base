import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

// Execute the actual documented fences. Fail if their shape changes instead of
// silently testing a second, independently maintained command recipe.
export async function readmeCommands(root, owner, port) {
  const document = await readFile(join(root, 'README.md'), 'utf8')
  const local = document.split('## Run it on your computer')[1]?.split('\nThis is a technical reference')[0]
  assert.ok(local, 'README local instructions exist')
  const fences = [...local.matchAll(/```sh\s*\n([\s\S]*?)```/g)].map((match) => match[1].trim().split('\n').map((line) => line.trim()))
  const handled = new Set()
  function find(first, count) {
    const matches = fences.filter((lines) => lines[0] === first)
    assert.equal(matches.length, 1, `one documented ${first} fence`)
    assert.equal(matches[0].length, count, `documented ${first} fence line count`)
    handled.add(matches[0])
    return matches[0]
  }
  function pnpm(line) {
    assert.match(line, /^pnpm [\w@./ =:-]+$/, 'documented command has supported literal arguments')
    return line.split(/\s+/).slice(1)
  }
  const initial = find('pnpm run deps', 3)
  assert.equal(initial[1], 'pnpm run setup -- --owner-email you@example.com --port 8787 --non-interactive')
  assert.equal(initial[2], 'pnpm run dev -- --port 8787')
  const rebuild = find('pnpm run build', 2)
  assert.equal(rebuild[1], 'pnpm run dev -- --port 8787')
  const rerun = find('pnpm run setup -- --non-interactive', 1)
  const setupCommand = initial[1].replace('you@example.com', owner).replace('8787', String(port))
  const steps = {}
  function step(name, fence, line = 0, executed = fence[line]) {
    steps[name] = { fence: fences.indexOf(fence) + 1, line: line + 1, documented: fence[line], executed }
    return pnpm(executed)
  }
  const commands = {
    install: step('install', initial), setup: step('setup', initial, 1, setupCommand),
    dev: step('dev', initial, 2, initial[2].replace('8787', String(port))),
    rebuild: step('rebuild', rebuild), restart: step('restart', rebuild, 1, rebuild[1].replace('8787', String(port))),
    rerun: step('rerun', rerun), directory: 'default-seed', steps,
    fences: fences.map((lines) => lines.join('\n')),
    substitutions: { 'you@example.com': owner, '8787': String(port) },
  }
  assert.equal(handled.size, fences.length, 'every local README shell fence is handled')
  return commands
}

export function readmeReceipts(documented, record) {
  let sequence = 0
  const execution = documented.fences.map((text, index) => ({
    fence: index + 1, text,
    commands: Object.values(documented.steps).filter((step) => step.fence === index + 1)
      .sort((a, b) => a.line - b.line).map((step) => ({ ...step, executions: [] })),
  }))
  const phases = []
  function publish(receipt) { record(`README receipt: ${JSON.stringify(receipt)}\n`) }
  return {
    begin(name, phase, cwd) {
      const step = documented.steps[name]
      const receipt = { sequence: ++sequence, phase, cwd, command: step.executed, status: 'running' }
      execution[step.fence - 1].commands.find(({ line }) => line === step.line).executions.push(receipt)
      publish({ fence: step.fence, line: step.line, ...receipt })
      return receipt
    },
    finish(receipt, status, evidence = {}) {
      if (!receipt) return
      Object.assign(receipt, { status, completedSequence: ++sequence }, evidence)
      publish(receipt)
    },
    phase(phase, evidence = {}) {
      const receipt = { sequence: ++sequence, phase, status: 'passed', ...evidence }
      phases.push(receipt)
      publish(receipt)
    },
    report() {
      for (const fence of execution) {
        for (const command of fence.commands) {
          assert.ok(command.executions.length > 0, `README fence ${fence.fence} line ${command.line} executed`)
          for (const receipt of command.executions) assert.equal(receipt.status, 'passed', `README fence ${fence.fence} line ${command.line} passed`)
        }
      }
      return { fences: documented.fences, substitutions: documented.substitutions,
        execution: execution.map((fence) => ({ ...fence, status: 'passed' })), phases }
    },
  }
}

export async function assertDistExcludesSecrets(root, secrets) {
  const { readdir } = await import('node:fs/promises')
  let files = 0
  async function scan(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await scan(path)
      else if (entry.isFile()) {
        files++
        const bytes = await readFile(path)
        for (const secret of secrets) assert.equal(bytes.includes(Buffer.from(secret)), false, 'every emitted dist file excludes generated credentials')
      } else assert.fail('dist contains an unexpected nonregular entry')
    }
  }
  await scan(join(root, 'dist'))
  assert.ok(files > 0, 'built dist files were scanned recursively')
}
