import { namedSteps, caseRows } from '../../review-harness/tests/fold-steps.mjs';
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { project, put, run } from './helpers.mjs'

const passed = 'Boundary check passed for 16 source files.\n'

test("boundary CLI reports malformed invocation or configuration with exact exit and diagnostics", async t => {
  await caseRows(t, [["boundary CLI reports malformed invocation or configuration with exact exit and diagnostics", async t => {
  const step = namedSteps(t);
  await step('CLI exit 2 names invalid configuration with exact output', async t => {
    const root = await project(t)
    await put(root, 'boundaries.json', '{"version":1,"unknown":true}')
    const result = run(root)
    assert.equal(result.status, 2)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, 'Boundary check configuration error: config: unknown key unknown\n')
  })

  await step('CLI usage errors have exact output', async t => {
    const root = await project(t)
    for (const args of [['--unknown'], ['--config']]) {
      const result = run(root, args)
      assert.equal(result.status, 2)
      assert.equal(result.stderr, `Boundary check configuration error: Unknown or incomplete argument: ${args[0]}. Usage: node cli.mjs [--config <path>] [--json]\n`)
    }
  })

  await step('CLI missing config and tsconfig exit 2', async t => {
    const root = await project(t)
    let result = run(root)
    assert.equal(result.status, 2)
    assert.match(result.stderr, /Cannot read JSON config .*boundaries.json: ENOENT/)
    await put(root, 'boundaries.json', '{"version":1,"tsconfig":"missing.json"}')
    result = run(root)
    assert.equal(result.status, 2)
    assert.match(result.stderr, /Cannot read tsconfig missing.json/)
  })

  }]]);
})



test('CLI JSON is the complete result for both pass and fail', async t => {
  for (const fixture of ['clean', 'r6']) {
    const root = await project(t, fixture)
    await put(root, 'boundaries.json', '{"version":1}')
    const result = run(root, ['--json'])
    assert.equal(result.status, fixture === 'clean' ? 0 : 1)
    const value = JSON.parse(fixture === 'clean' ? result.stdout : result.stderr)
    assert.equal(value.files, fixture === 'clean' ? 16 : 2)
    assert.equal(value.violations.length, fixture === 'clean' ? 0 : 5)
    if (fixture !== 'clean') assert.deepEqual(value.violations[0], { rule: 'R6', file: 'src/use.ts', line: 1, column: 1, specifier: null, target: null, message: 'runtime code evaluation is not allowed' })
  }
})
test("boundary CLI selects the consumer project for local or external configuration", async t => {
  await caseRows(t, [["boundary CLI selects the consumer project for local or external configuration", async t => {
  const step = namedSteps(t);
  await step('CLI uses the config directory as root from another working directory', async t => {
    const root = await project(t)
    await put(root, 'boundaries.json', '{"version":1}')
    const other = await mkdtemp(resolve(tmpdir(), 'boundary-cwd-'))
    t.after(() => rm(other, { recursive: true, force: true }))
    const result = run(other, ['--config', resolve(root, 'boundaries.json')])
    assert.equal(result.status, 0)
    assert.equal(result.stdout, passed)
    assert.equal(result.stderr, '')
  })

  await step('CLI external config checks the working project without writing into it', async t => {
    const root = await project(t)
    const other = await mkdtemp(resolve(tmpdir(), 'boundary-config-'))
    t.after(() => rm(other, { recursive: true, force: true }))
    await put(other, 'defaults.json', '{"version":1}')
    const result = run(root, ['--config', resolve(other, 'defaults.json')])
    assert.equal(result.status, 0)
    assert.equal(result.stdout, passed)
  })

  }]]);
})
