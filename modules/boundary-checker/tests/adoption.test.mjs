import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFile, mkdir, readFile, readdir, realpath, rm, symlink } from 'node:fs/promises'
import { dirname, resolve, relative, isAbsolute, sep } from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { project, put, run, moduleRoot } from './helpers.mjs'

async function copyList(readme) {
  readme ??= await readFile(resolve(moduleRoot, 'README.md'), 'utf8')
  const list = readme.split('<!-- copy-files:start -->')[1]?.split('<!-- copy-files:end -->')[0]
  assert.ok(list, 'README contains the Adopting file list')
  const files = [...list.matchAll(/^- `([^`]+)`$/gm)].map(match => match[1])
  assert.ok(files.length > 0)
  assert.equal(new Set(files).size, files.length)
  for (const file of files) assert.ok(!file.includes('tests') && !relative(moduleRoot, resolve(moduleRoot, file)).startsWith('..'))
  return files
}
function importSpecifiers(ts, file, text) {
  const specifiers = []
  const literal = node => node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && literal(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text)
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && literal(node.arguments[0])) {
      specifiers.push(node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }
  visit(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true))
  return specifiers
}
function inside(root, target) {
  const path = relative(root, target)
  return !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`)
}
async function copiedSeed(t, fixture, { readme, editCopy = async () => {} } = {}) {
  const root = await project(t, fixture)
  const destination = resolve(root, 'vendor/base/modules/boundary-checker')
  const files = await copyList(readme)
  for (const file of files) {
    const source = resolve(moduleRoot, file), target = resolve(destination, file)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(source, target)
    assert.deepEqual(await readFile(target), await readFile(source))
  }
  await editCopy(root, destination)
  const require = createRequire(resolve(root, 'package.json'))
  const ts = require('typescript')
  for (const file of files.filter(file => /\.(?:mjs|d\.[cm]?ts)$/.test(file))) {
    const source = await readFile(resolve(destination, file), 'utf8')
    for (const specifier of importSpecifiers(ts, file, source)) {
      if (specifier.startsWith('node:')) continue
      assert.ok(specifier.startsWith('.'), `No package dependency: ${file}`)
      const target = resolve(dirname(resolve(destination, file)), specifier)
      assert.ok(inside(destination, target), `No import escapes copied folder: ${file}`)
      assert.ok(inside(destination, await realpath(target)), `No import escapes copied folder: ${file}`)
      assert.ok(files.includes(relative(destination, target).split(sep).join('/')), `Needed file is in README list: ${specifier}`)
      await readFile(target)
    }
  }
  const consumer = await readFile(resolve(moduleRoot, 'tests/types.check.mts'), 'utf8')
  await put(root, 'boundary-consumer.mts', consumer.replace("from '../index.mjs'", "from './vendor/base/modules/boundary-checker/index.mjs'"))
  const checked = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'),
    '--noEmit', '--strict', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022', 'boundary-consumer.mts',
  ], { cwd: root, encoding: 'utf8', env: { ...process.env, TZ: 'UTC' } })
  assert.equal(checked.status, 0, `Copied API consumer type-checks:\n${checked.stdout}${checked.stderr}`)
  await put(root, 'boundaries.json', '{"version":1}')
  return { root, script: resolve(destination, 'cli.mjs') }
}
test('README copy list adopts a clean tree at a different path', async t => {
  const { root, script } = await copiedSeed(t, 'clean')
  const result = run(root, [], script)
  assert.equal(result.status, 0)
  assert.equal(result.stdout, 'Boundary check passed for 16 source files.\n')
  assert.equal(result.stderr, '')
  assert.deepEqual(await readdir(resolve(root, 'node_modules')), ['typescript'])
})
test('README copy list adopts a violating tree with exact CLI lines', async t => {
  const { root, script } = await copiedSeed(t, 'r3')
  const result = run(root, [], script)
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, 'Boundary check failed with 2 violation(s):\n- src/core/features/a/use.ts:1 R3: feature a must import b through its public index\n- src/core/features/a/use.ts:3 R3: feature a must import delivery through its public index\n')
})

const escapingForms = {
  static: specifier => `import * as outside from '${specifier}'`,
  'side-effect': specifier => `import '${specifier}'`,
  dynamic: specifier => `void import('${specifier}')`,
  'template dynamic': specifier => `void import(\`${specifier}\`)`,
  'named re-export': specifier => `export { outside } from '${specifier}'`,
  'star re-export': specifier => `export * from '${specifier}'`,
}
for (const [form, statement] of Object.entries(escapingForms)) {
  test(`adoption gate rejects an escaping ${form} import at the copied location`, async t => {
    await assert.rejects(copiedSeed(t, 'clean', {
      editCopy: async (root, destination) => {
        await put(root, 'outside.mjs', 'export const outside = 1\n')
        const reporter = await readFile(resolve(destination, 'reporter.mjs'), 'utf8')
        await put(destination, 'reporter.mjs', `${statement('../../../../outside.mjs')}\n${reporter}`)
      },
    }), /No import escapes copied folder: reporter\.mjs/)
  })
}
test('adoption gate rejects an import resolving through a symlink outside the copied folder', async t => {
  await assert.rejects(copiedSeed(t, 'clean', {
    editCopy: async (root, destination) => {
      await copyFile(resolve(destination, 'walk.mjs'), resolve(root, 'outside.mjs'))
      await rm(resolve(destination, 'walk.mjs'))
      await symlink(resolve(root, 'outside.mjs'), resolve(destination, 'walk.mjs'))
    },
  }), /No import escapes copied folder: index\.mjs/)
})
test('adoption gate ignores import text in comments and strings', async t => {
  const { root, script } = await copiedSeed(t, 'clean', {
    editCopy: async (_root, destination) => {
      const reporter = await readFile(resolve(destination, 'reporter.mjs'), 'utf8')
      await put(destination, 'reporter.mjs', `// export * from '../../../../outside.mjs'\nconst example = "import('../../../../outside.mjs')"\n${reporter}`)
    },
  })
  assert.equal(run(root, [], script).status, 0)
})
test('adoption gate requires every declaration in the README copy list', async t => {
  const readme = await readFile(resolve(moduleRoot, 'README.md'), 'utf8')
  const declarations = (await copyList(readme)).filter(file => /\.d\.[cm]?ts$/.test(file))
  assert.ok(declarations.length > 0)
  for (const file of declarations) {
    await assert.rejects(copiedSeed(t, 'clean', {
      readme: readme.replace(`- \`${file}\`\n`, ''),
    }), /Copied API consumer type-checks/)
  }
})
