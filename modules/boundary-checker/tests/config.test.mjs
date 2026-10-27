import { namedSteps } from '../../review-harness/tests/fold-steps.mjs';
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateConfig, loadConfig } from '../config.mjs'
import { checkBoundaries } from '../index.mjs'
import { project, put, findings, example, moduleRoot } from './helpers.mjs'
import { resolve } from 'node:path'

const bad = [
  ['unknown key', { version: 1, unknown: true }, /unknown key unknown/],
  ['unknown rule', { version: 1, rules: { R9: false } }, /unknown key R9/],
  ['unknown option', { version: 1, rules: { R6: { unknown: true } } }, /unknown key unknown/],
  ['bad pattern', { version: 1, rules: { R7: { pattern: '[' } } }, /invalid regular expression/],
  ['bad glob', { version: 1, rules: { R8: { files: ['src/['] } } }, /invalid glob/],
  ['bad globstar', { version: 1, rules: { R5: { importScopes: ['src/a**'] } } }, /invalid glob/],
  ['version', { version: 2 }, /version/],
  ['missing version', {}, /version/],
  ['path traversal', { version: 1, sourceRoot: '../src' }, /relative POSIX path/],
  ['absolute path', { version: 1, tsconfig: '/tsconfig.json' }, /relative POSIX path/],
  ['boolean', { version: 1, includeTypeOnly: 'yes' }, /boolean/],
  ['enabled boolean', { version: 1, rules: { R1: { enabled: 1 } } }, /boolean/],
  ['array', { version: 1, rules: { R3: { exceptions: 'src/a' } } }, /array/],
  ['mount pins', { version: 1, rules: { R2: { mounts: { 'src/mount.ts': 'src/ext/index.ts' } } } }, /array/],
  ['empty prefix', { version: 1, rules: { R8: { prefix: '' } } }, /nonempty string/],
]
test("checker configuration admission refuses malformed values and unavailable input paths", async t => {
  const step = namedSteps(t);
  await step("config rejects invalid input corpus", async t => {
    const step = namedSteps(t);
    for (const [name, config, message] of bad) await step(`config rejects ${name}`, () => assert.throws(() => validateConfig(config), message))
  })
  
  await step('missing and invalid tsconfig are configuration errors', async t => {
    const root = await project(t)
    await assert.rejects(checkBoundaries({ root, config: { version: 1, tsconfig: 'missing.json' } }), /Cannot read tsconfig missing.json/)
    await put(root, 'bad.json', '{')
    await assert.rejects(checkBoundaries({ root, config: { version: 1, tsconfig: 'bad.json' } }), /tsconfig/)
    await put(root, 'bad.json', '{"compilerOptions":{"module":"nonsense"}}')
    await assert.rejects(checkBoundaries({ root, config: { version: 1, tsconfig: 'bad.json' } }), /Invalid tsconfig/)
  })
  
  await step('missing sourceRoot and malformed JSON config are errors', async t => {
    const root = await project(t)
    await assert.rejects(checkBoundaries({ root, config: { version: 1, sourceRoot: 'missing' } }), /Cannot read source root/)
    await put(root, 'boundaries.json', '{')
    await assert.rejects(loadConfig(resolve(root, 'boundaries.json')), /Cannot read JSON config/)
  })
})


test('config is snapshotted without changing the caller', () => {
  const input = { version: 1, rules: { R1: { allowedPrefixes: ['src/core/shared'] } } }
  const result = validateConfig(input)
  result.rules.R1.allowedPrefixes.push('src/core/api')
  assert.deepEqual(input.rules.R1.allowedPrefixes, ['src/core/shared'])
})


const expected = {
  pencil: [['R2', 'src/core/app/bad.ts', 1], ['R5', 'src/core/features/a/bindings.ts', 1], ['R3', 'src/core/features/a/use.ts', 1], ['R6', 'src/core/shared/evaluate.ts', 1], ['R8', 'src/ext/config.ts', 1], ['R7', 'src/ext/index.client.ts', 1], ['R1', 'src/ext/private.ts', 1]],
  dial: [['R2', 'src/core/app/mount.server.ts', 2], ['R4', 'src/core/features/a/data.ts', 1], ['R4', 'src/core/features/a/data.ts', 2], ['R5', 'src/core/features/a/env.ts', 1], ['R3', 'src/core/features/a/use.ts', 1], ['R1', 'src/ext/private.ts', 1]],
  orbit: [['R2', 'src/core/app/bad.ts', 1], ['R4', 'src/core/features/a/use.ts', 1]],
}
test("worked config loads across documented consumers", async t => {
  const step = namedSteps(t);
  for (const name of Object.keys(expected)) await step(`${name} worked config loads and has exact findings`, async t => {
    const config = await loadConfig(resolve(moduleRoot, 'examples', `${name}.json`))
    assert.deepEqual(findings(await checkBoundaries({ root: await project(t, name), config })), expected[name])
    assert.equal((await example(name)).version, 1)
  })
})

