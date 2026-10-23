import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { sourceRoots } from '../cli/export.mjs'

const root = resolve(import.meta.dirname, '..')
async function contents(directory) {
  const files = {}
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const path = resolve(entry.parentPath, entry.name)
      files[path.slice(directory.length + 1)] = await readFile(path)
    }
  }
  return files
}

test('public foundation CLI preserves pinned workflows and requires their committed installer', async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'rer-pinned-foundation-'))
  const base = resolve(temporary, 'base')
  const git = (...args) => execFileSync('git', ['-C', base, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()
  const commit = () => {
    git('add', '.')
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'source fixture')
    return git('rev-parse', 'HEAD')
  }
  const generate = (ref, name) => {
    const output = resolve(temporary, name)
    execFileSync(process.execPath, [resolve(root, 'foundation/cli.mjs'), '--base-repo', base, '--ref', ref,
      '--output', output, '--family', 'history', '--edition', 'prior', '--repository', 'test/history'],
    { stdio: ['ignore', 'pipe', 'pipe'] })
    return output
  }
  try {
    for (const path of new Set([...sourceRoots, 'foundation', 'onboarding', 'export'])) {
      await cp(resolve(root, path), resolve(base, path), { recursive: true })
    }
    git('init', '-q')
    const helperPath = resolve(base, 'export/install-chromium-deps.py')
    const workflowPath = resolve(base, 'export/verify.yml')
    const helper = await readFile(helperPath)
    const workflow = await readFile(workflowPath, 'utf8')
    await rm(helperPath)
    await writeFile(workflowPath, workflow.replace(/^.*python3 scripts\/install-chromium-deps\.py$/m, '          pnpm exec playwright install-deps chromium'))
    const older = commit()
    const before = await contents(generate(older, 'before'))

    await writeFile(helperPath, helper)
    await writeFile(workflowPath, workflow)
    const current = commit()
    // Advancing the source checkout must not change an older pinned result.
    assert.deepEqual(await contents(generate(older, 'after')), before)
    const generated = generate(current, 'current')
    assert.deepEqual(await readFile(resolve(generated, 'editions/prior/scripts/install-chromium-deps.py')), helper)
    assert.equal(await readFile(resolve(generated, 'editions/prior/.github/workflows/verify.yml'), 'utf8'), workflow)

    await rm(helperPath)
    const broken = commit()
    // A dirty working-tree copy cannot supply a committed source dependency.
    await writeFile(helperPath, helper)
    assert.throws(() => generate(broken, 'broken'), /Missing source: export\/install-chromium-deps\.py/)
    await assert.rejects(readdir(resolve(temporary, 'broken')), { code: 'ENOENT' })
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})
