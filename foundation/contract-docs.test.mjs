import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseContract } from './runtime/seed-contract.mjs'

const fixtures = join(import.meta.dirname, 'fixtures/contract-docs')
const generatedFiles = ['CONTRACT.md', 'ACCEPTANCE.md', 'docs/CLAIMS.md']
const read = (root, path) => readFile(join(root, path), 'utf8')
const edit = (root, path, contents) => writeFile(join(root, path), contents)
const snapshot = root => Promise.all(generatedFiles.map(path => read(root, path)))
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
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
const refuses = (root, path, ...args) => {
  const result = cli(root, ...args)
  assert.notEqual(result.status, 0, `${args.join(' ')} unexpectedly passed`)
  assert.ok(result.output.includes(path), `${path} was not named:\n${result.output}`)
}

async function installation(fixture) {
  const root = await mkdtemp(join(tmpdir(), 'contract-docs-'))
  await cp(join(fixtures, fixture), root, { recursive: true })
  await mkdir(join(root, 'src/base'), { recursive: true })
  await Promise.all(['contract-docs.mjs', 'seed-contract.mjs'].map(file =>
    cp(join(import.meta.dirname, 'runtime', file), join(root, 'src/base', file))))
  git(root, 'init', '-q')
  git(root, 'add', '.')
  git(root, '-c', 'user.name=Synthetic author', '-c', 'user.email=synthetic@example.invalid', 'commit', '-qm', 'Synthetic source')
  return root
}

async function generatedJourney(root) {
  succeeds(root, 'write')
  succeeds(root, 'check')
  const first = await snapshot(root)
  succeeds(root, 'write')
  assert.deepEqual(await snapshot(root), first, 'regenerating changed already generated documents')
  const acceptance = await read(root, 'ACCEPTANCE.md')
  await edit(root, 'ACCEPTANCE.md', acceptance.replace(/^1\..+$/m, '$& Hand-edited outcome.'))
  refuses(root, 'ACCEPTANCE.md', 'check')
  succeeds(root, 'write')
  succeeds(root, 'check')
  assert.equal(await read(root, 'ACCEPTANCE.md'), acceptance)
}

async function nonProductJourney() {
  const sources = [
    [
      [6, '"100% free, open source alternative to Expensify, SAP Concur and Emburse"', 'OWN', 'license/public-repository ownership'],
      [51, '"100% free and open source. MIT licensed."', 'OWN', 'license/public-repository ownership'],
    ],
    [
      [6, '"100% free, open source alternative to Stripe Billing, Chargebee and Recurly"', '—', 'license/public-repository ownership'],
      [71, 'Terminal: `npx -y @runeditrun/rer dev just-every/run-nectar` starts Nectar', '—', 'launcher identity'],
      [73, '"100% free and open source. MIT licensed."', '—', 'license/public-repository ownership'],
      [76, '"Try the demo" opens the hosted demo', '—', 'hosted-demo action'],
    ],
  ]
  for (const facts of sources) {
    const root = await installation('legacy')
    try {
      await rm(join(root, 'docs/CLAIMS.md'))
      const initial = await read(root, 'CONTRACT.md')
      const table = [
        '| # | Section | Claim | Clause(s) | Status |', '| --- | --- | --- | --- | --- |',
        "| 1 | Hero | Publish the studio's entries | PUBLISH-01 | done |",
        ...facts.map(([number, claim, reference]) => `| ${number} | Closing | ${claim} | ${reference} | done |`),
      ].join('\n')
      await edit(root, 'CONTRACT.md', initial.replace(/\| # \| Claim \| Clauses \|[\s\S]*?(?=\n## Status)/, table + '\n'))
      git(root, 'add', '.')
      git(root, 'commit', '-qm', 'Synthetic historical homepage source')
      const old = git(root, 'rev-parse', 'HEAD'), before = parseContract(await read(root, 'CONTRACT.md'))
      const lines = (await read(root, 'CONTRACT.md')).split('\n')
      const claims = facts.map(([, claim, , nonProduct]) => ({ file: 'CONTRACT.md', line: lines.findIndex(line => line.includes(`| ${claim} |`)) + 1, claim, nonProduct }))
      await edit(root, 'claim-map.json', JSON.stringify({ schema: 1, old, claims }))
      succeeds(root, 'convert', '--old', old, '--claim-map', 'claim-map.json')
      succeeds(root, 'check')
      succeeds(root, 'id-map', '--old', old)
      succeeds(root, 'coverage', 'check', '--old', old)
      assert.deepEqual(parseContract(await read(root, 'CONTRACT.md')).clauses.map(({ id, status }) => ({ id, status })), before.clauses.map(({ id, status }) => ({ id, status })))
    } finally { await rm(root, { recursive: true, force: true }) }
  }
}

test('contract docs convert handwritten contracts and keep generated documents and migration maps accountable', async () => {
  const roots = await Promise.all(['standard', 'legacy'].map(installation))
  try {
    const results = await Promise.allSettled([
      nonProductJourney(),
      (async () => {
        const root = roots[0]
        const original = parseContract(await read(root, 'CONTRACT.md'))
        await generatedJourney(root)
        assert.deepEqual(parseContract(await read(root, 'CONTRACT.md')), original)
        git(root, 'add', '.')
        git(root, '-c', 'user.name=Synthetic author', '-c', 'user.email=synthetic@example.invalid', 'commit', '-qm', 'Generated documents')
        succeeds(root, 'write')
        assert.equal(git(root, 'status', '--porcelain'), '', 'a second write leaves the committed checkout clean')
        const acceptance = await read(root, 'ACCEPTANCE.md')
        for (const clause of original.clauses) {
          assert.ok(acceptance.includes(`#### ${clause.id} — ${clause.title}`), clause.id)
          assert.ok(acceptance.includes(clause.gap || '**Gap.** None.'), clause.id)
        }
        const source = await read(root, 'CONTRACT.md')
        const requirement = '**Requirement.** A visitor reads the studio\'s published entries.'
        const revised = `${requirement} Titles remain searchable.`
        await edit(root, 'CONTRACT.md', source.replace(requirement, revised))
        refuses(root, 'ACCEPTANCE.md', 'check')
        succeeds(root, 'write')
        succeeds(root, 'check')
        assert.ok((await read(root, 'ACCEPTANCE.md')).includes(revised))
        assert.ok((await read(root, 'docs/CLAIMS.md')).includes('Section'))
      })(),
      (async () => {
        const root = roots[1]
        const oldSource = await read(root, 'CONTRACT.md')
        const old = parseContract(oldSource)
        const oldCommit = git(root, 'rev-parse', 'HEAD')
        const claimSource = await read(root, 'docs/CLAIMS.md')
        const claimMap = { schema: 1, old: oldCommit, claims: [
          ["Keep each entry's identity", 'E1'],
          ['Draft entries stay private', 'PUBLISH-01'],
          ['Archived entries remain readable', 'AUTH-HOST-01'],
        ].map(([claim, id]) => ({ file: 'docs/CLAIMS.md', line: claimSource.split('\n').findIndex(line => line.includes(`| ${claim} |`)) + 1, claim, clauses: [id] })) }
        await edit(root, 'claim-map.json', JSON.stringify(claimMap))
        succeeds(root, 'convert', '--old', 'HEAD', '--claim-map', 'claim-map.json')
        succeeds(root, 'coverage', 'check', '--old', 'HEAD')
        succeeds(root, 'id-map', '--old', 'HEAD')
        const converted = parseContract(await read(root, 'CONTRACT.md'))
        assert.deepEqual(converted.clauses.map(({ id, status, evidence, gap, kind }) => ({ id, status, evidence, gap, kind })),
          old.clauses.map(({ id, status, evidence, gap, kind }) => ({ id, status, evidence, gap, kind })))
        assert.equal(converted.commit, old.commit)
        assert.equal(converted.date, old.date)
        const idMap = JSON.parse(await read(root, 'docs/contract/ID-MAP.json'))
        assert.equal(idMap.old, oldCommit)
        for (const clause of old.clauses) assert.ok(idMap.ids[clause.id].to.includes(clause.id), clause.id)
        const coveragePath = 'docs/contract/COVERAGE.json'
        const coverageText = await read(root, coveragePath)
        const coverage = JSON.parse(coverageText)
        assert.equal(coverage.old.commit, oldCommit)
        const statusTableLines = oldSource.split('\n').flatMap((line, index) => /^\| (Clauses|Published|Target and push further|All|Clause) \|/.test(line) ? [index + 1] : [])
        assert.ok(statusTableLines.length >= 5, 'the legacy fixture lost its Status tables')
        assert.ok(!coverage.fragments.some(fragment => fragment.file === 'CONTRACT.md' && statusTableLines.includes(fragment.line)), 'Status table headers and summary rows are carried by the ID map and status, not coverage')
        const claimsSource = await readFile(join(fixtures, 'legacy/docs/CLAIMS.md'), 'utf8')
        const optOutLine = claimsSource.split('\n').findIndex(line => line.includes('Do not sell entries')) + 1
        const optOut = coverage.fragments.filter(fragment => fragment.file === 'docs/CLAIMS.md' && fragment.line === optOutLine)
        assert.ok(optOut.length, 'the opt-out table row was not covered')
        assert.ok(optOut.every(fragment => fragment.section !== 'Homepage claims' && fragment.to !== 'generated'))
        const convertedText = await read(root, 'CONTRACT.md')
        const homepage = convertedText.split('## Homepage claims')[1].split('\n## ')[0]
        assert.ok(homepage.includes('Keep each entry\'s identity'), 'the larger handwritten homepage claims table was lost')
        assert.ok(!homepage.includes('Do not sell entries'), 'the opt-out row became a homepage claim')
        const verification = await read(root, 'docs/verify.md')
        assert.ok(verification.includes('The observer records any confusing empty states in the installation notes.'))
        const history = await read(root, 'CHANGELOG.md')
        assert.ok(history.includes('The studio keeps its original catalogue outside the installation.'))
        await generatedJourney(root)
        succeeds(root, 'coverage', 'check', '--old', 'HEAD')
        coverage.fragments.splice(0, 1)
        await edit(root, coveragePath, `${JSON.stringify(coverage, null, 2)}\n`)
        refuses(root, 'COVERAGE.json', 'coverage', 'check', '--old', 'HEAD')
        await edit(root, coveragePath, coverageText)
        succeeds(root, 'coverage', 'check', '--old', 'HEAD')
      })(),
    ])
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason)
    if (failures.length) throw new AggregateError(failures, failures.map(error => error.message).join('\n'))
  } finally {
    await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })))
  }
})
