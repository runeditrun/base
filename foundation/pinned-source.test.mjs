import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { sourceRoots } from '../cli/export.mjs'
import { renderVerifySchedule } from './verify-schedule.mjs'

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

test('public foundation CLI renders pinned schedules and requires their committed installer', async () => {
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
    for (const name of await readdir(resolve(root, 'export'))) {
      if (/\.ya?ml$/.test(name) || name === 'VERIFY-WORKFLOW.md') {
        assert.doesNotMatch(await readFile(resolve(root, 'export', name), 'utf8'), /^\s*runs-on:\s*ubuntu-latest\b/m, name)
      }
    }
    for (const path of new Set([...sourceRoots, 'foundation', 'onboarding', 'export'])) {
      await cp(resolve(root, path), resolve(base, path), { recursive: true })
    }
    git('init', '-q')
    const helperPath = resolve(base, 'export/install-chromium-deps.py')
    const workflowPath = resolve(base, 'export/verify.yml')
    const helper = await readFile(helperPath)
    const workflow = await readFile(workflowPath, 'utf8')
    assert.doesNotMatch(workflow, /~\/\.cache\/(?:ms-playwright|rer-apt)/)
    await rm(helperPath)
    await writeFile(workflowPath, workflow.replace(/^.*python3 scripts\/install-chromium-deps\.py$/m, '          pnpm exec playwright install-deps chromium'))
    const nightlyPath = resolve(base, 'export/verify-nightly.yml')
    const nightly = await readFile(nightlyPath, 'utf8')
    await writeFile(nightlyPath, nightly.replace(/cron: '[^']+'/, "cron: '7 1 * * *'"))
    const older = commit()
    const before = await contents(generate(older, 'before'))

    await writeFile(helperPath, helper)
    await writeFile(workflowPath, workflow)
    await writeFile(nightlyPath, nightly)
    const current = commit()
    // Advancing the source checkout must not change an older pinned result.
    assert.deepEqual(await contents(generate(older, 'after')), before)
    const generated = generate(current, 'current')
    assert.deepEqual(await readFile(resolve(generated, 'editions/prior/scripts/install-chromium-deps.py')), helper)
    assert.equal(await readFile(resolve(generated, 'editions/prior/.github/workflows/verify.yml'), 'utf8'), workflow)
    assert.equal(await readFile(resolve(generated, 'editions/prior/.github/workflows/verify-nightly.yml'), 'utf8'), renderVerifySchedule(nightly, 'prior'))
    const provenance = JSON.parse(await readFile(resolve(generated, 'foundation.lock.json'), 'utf8'))
    const recorded = provenance.files['editions/prior/.github/workflows/verify-nightly.yml']
    assert.ok(recorded.transformation, 'rendered schedule declares its transformation')
    assert.equal(recorded.sha256, createHash('sha256').update(renderVerifySchedule(nightly, 'prior')).digest('hex'))

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
