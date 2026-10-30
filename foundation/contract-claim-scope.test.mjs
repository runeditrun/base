import test from 'node:test'
import {githubApiEdge} from '../edition-authoring/tests/github-api.mjs'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const fixtures = join(import.meta.dirname, 'fixtures/contract-docs')
const read = (root, path) => readFile(join(root, path), 'utf8')
const edit = (root, path, contents) => writeFile(join(root, path), contents)
const git = (root, ...args) => execFileSync('git', ['-c', 'user.name=Base test', '-c', 'user.email=base-test@example.invalid', ...args], { cwd: root, encoding: 'utf8' }).trim()
const cli = (root, ...args) => {
  const result = spawnSync(process.execPath, ['src/base/contract-docs.mjs', ...args], { cwd: root, encoding: 'utf8' })
  assert.ifError(result.error)
  return { ...result, output: result.stdout + result.stderr }
}
const succeeds = (root, ...args) => {
  const result = cli(root, ...args)
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.output}`)
  return result
}
async function installation(fixture) {
  const root = await mkdtemp(join(tmpdir(), 'contract-docs-'))
  await cp(join(fixtures, fixture), root, { recursive: true })
  await mkdir(join(root, 'src/base'), { recursive: true })
  await Promise.all(['contract-docs.mjs', 'contract-anchor.mjs', 'contract-prose.mjs', 'contract-prose-patterns.mjs', 'seed-contract.mjs'].map(file =>
    cp(join(import.meta.dirname, 'runtime', file), join(root, 'src/base', file))))
  git(root, 'init', '-q')
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'Synthetic source')
  return root
}

test('source claims survive conversion and Base copies record through the public API command', async () => {
  const root = await installation('legacy'), base = await installation('legacy')
  try {
    await rm(join(root, 'docs/CLAIMS.md'))
    const original = (await read(root, 'CONTRACT.md'))
      .replace('| # | Claim | Clauses |', '| Claim # | What the page claims | Clause id(s) | Status | Backing |')
      .replace('| --- | --- | --- |', '| --- | --- | --- | --- | --- |')
      .replace("| 1 | Publish the studio's entries | PUBLISH-01 |", '| 1 | Publish entries \\| keep identity | PUBLISH-01 | partly | Provider acceptance does not prove delivery. |')
      .replace('  Draft entries stay private.', '  Draft entries stay private.\n\n> Preserve the original decision.')
    await edit(root, 'CONTRACT.md', original)
    git(root, 'add', '.')
    git(root, 'commit', '-qm', 'Synthetic observed source')
    succeeds(root, 'convert', '--old', 'HEAD')
    succeeds(root, 'check')
    succeeds(root, 'id-map', '--old', 'HEAD')
    succeeds(root, 'coverage', 'check', '--old', 'HEAD')
    assert.ok((await read(root, 'docs/CLAIMS.md')).includes('| partly | done |'))
    const converted = await read(root, 'CONTRACT.md')
    assert.ok((await read(root, 'docs/CLAIMS.md')).includes('Provider acceptance does not prove delivery.'))
    await edit(root, 'CONTRACT.md', converted.replace('Provider acceptance does not prove delivery.', 'Provider acceptance proves delivery.'))
    assert.match(cli(root, 'check').output, /current screen\/backing provenance must match the original/)
    await edit(root, 'CONTRACT.md', converted)
    const row = converted.split('\n').find(line => line.startsWith('| 1 |'))
    await edit(root, 'CONTRACT.md', converted.replace(row + '\n', ''))
    assert.notEqual(cli(root, 'check').status, 0, 'a dropped source claim passed')
    await edit(root, 'CONTRACT.md', converted)
    const revision = git(base, 'rev-parse', 'HEAD'), tree = git(base, 'rev-parse', 'HEAD^{tree}')
    const bytes = await readFile(join(base, 'README.md'))
    const object = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
    const response = {
      [`git/commits/${revision}`]: { sha: revision, tree: { sha: tree } },
      [`git/trees/${tree}?recursive=1`]: { sha: tree, truncated: false, tree: [{ path: 'README.md', type: 'blob', mode: '100644', sha: object }] },
      [`git/blobs/${object}`]: { sha: object, encoding: 'base64', size: bytes.length, content: bytes.toString('base64') },
    }
    const tools = join(root, 'tools')
    githubApiEdge(tools, response)
    const record = (...args) => spawnSync(process.execPath, [join(import.meta.dirname, '../edition-authoring/cli.mjs'), 'record-base', 'README.md', 'README.md', revision, ...args], {
      cwd: root, encoding: 'utf8', env: { ...process.env, PATH: tools + ':' + process.env.PATH },
    })
    let result = record('--base', base)
    assert.equal(result.status, 0, result.stderr)
    const expected = await read(root, 'base-copies.json')
    result = record('--from-api')
    assert.equal(result.status, 0, result.stderr)
    assert.equal(await read(root, 'base-copies.json'), expected, 'API and checkout records differ')
  } finally { await Promise.all([root, base].map(root => rm(root, { recursive: true, force: true }))) }
})
