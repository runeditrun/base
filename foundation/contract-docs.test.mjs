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
  // Small public-command reproductions of the two immutable source forms:
  // Coaster's OWN alias and Nectar's explicit em-dash exemptions. These facts
  // have no product duty; a real product promise remains beside them.
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
        '| 1 | Hero | Publish the studio\'s entries | PUBLISH-01 | done |',
        ...facts.map(([number, claim, reference]) => `| ${number} | Closing | ${claim} | ${reference} | done |`),
        '| 2 | Catalogue | Publish entries as open source | — | partial |',
      ].join('\n')
      await edit(root, 'CONTRACT.md', initial.replace(/\| # \| Claim \| Clauses \|[\s\S]*?(?=\n## Status)/, table + '\n'))
      git(root, 'add', '.')
      git(root, 'commit', '-qm', 'Synthetic non-product source forms')
      const old = git(root, 'rev-parse', 'HEAD'), originalText = await read(root, 'CONTRACT.md'), original = parseContract(originalText)
      const claims = facts.map(([, claim, , nonProduct]) => ({ file: 'CONTRACT.md', line: originalText.split('\n').findIndex(line => line.includes(`| ${claim} |`)) + 1, claim, nonProduct }))
      const productAlias = { file: 'CONTRACT.md', line: originalText.split('\n').findIndex(line => line.startsWith('| 2 | Catalogue |')) + 1, claim: 'Publish entries as open source', clauses: ['PUBLISH-01'] }
      claims.push(productAlias)
      const map = { schema: 1, old, claims }
      refuses(root, 'Homepage claim', 'convert', '--old', old)
      for (const [change, explanation] of [
        [{ old: '0'.repeat(40) }, 'old'],
        [{ claims: [{ ...claims[0], claim: 'Changed source text' }, ...claims.slice(1)] }, 'claim'],
        [{ claims: claims.slice(1) }, 'Homepage claim'],
        [{ claims: [{ ...claims[0], nonProduct: 'arbitrary exemption' }, ...claims.slice(1)] }, 'non-product basis'],
        [{ claims: [{ ...claims[0], clauses: ['PUBLISH-01'] }, ...claims.slice(1)] }, 'cannot also supply clauses'],
        [{ claims: [...claims.slice(0, -1), { ...productAlias, clauses: undefined, nonProduct: 'license/public-repository ownership' }] }, 'product promises need real clauses'],
        [{ claims: [...claims, { file: 'CONTRACT.md', line: originalText.split('\n').findIndex(line => line.includes('| 1 | Hero |')) + 1, claim: "Publish the studio's entries", nonProduct: 'license/public-repository ownership' }] }, 'product promises need real clauses'],
      ]) {
        await edit(root, 'claim-map.json', JSON.stringify({ ...map, ...change }))
        refuses(root, explanation, 'convert', '--old', old, '--claim-map', 'claim-map.json')
        assert.equal(await read(root, 'CONTRACT.md'), originalText, 'refusal changed the immutable-source working copy')
      }
      await edit(root, 'claim-map.json', JSON.stringify(map))
      succeeds(root, 'convert', '--old', old, '--claim-map', 'claim-map.json')
      succeeds(root, 'check')
      succeeds(root, 'id-map', '--old', old)
      succeeds(root, 'coverage', 'check', '--old', old)
      const converted = await read(root, 'CONTRACT.md'), after = parseContract(converted)
      for (const key of ['counts', 'commit', 'date']) assert.deepEqual(after[key], original[key])
      assert.deepEqual(after.clauses.map(({ id, kind, status, evidence, gap }) => ({ id, kind, status, evidence, gap })), original.clauses.map(({ id, kind, status, evidence, gap }) => ({ id, kind, status, evidence, gap })))
      const view = await read(root, 'docs/CLAIMS.md')
      for (const [number, claim, , basis] of facts) {
        assert.ok(view.includes(`| ${number} | Closing | ${claim} |  | Non-product: ${basis} | done | unassessed |`))
        const record = JSON.parse(converted.match(/<!-- contract-claim-source\n([\s\S]*?)\n-->/)[1])
        const source = record.claims.find(row => row.number === String(number))
        assert.equal(record.old, old)
        assert.equal(source.text, originalText.split('\n')[source.line - 1])
        assert.equal(source.status, 'done')
        assert.equal(source.claim, claim)
      }
      assert.ok(view.includes(`Claims: ${facts.length + 2}; 2 done, 0 partial, 0 missing. Non-product: ${facts.length} unassessed.`))
      const mutateRecord = change => converted.replace(/(<!-- contract-claim-source\n)([\s\S]*?)(\n-->)/, (_, start, body, end) => {
        const record = JSON.parse(body); change(record); return start + JSON.stringify(record, null, 2) + end
      })
      const first = facts[0], row = converted.split('\n').find(line => line.startsWith(`| ${first[0]} | Closing |`))
      for (const [text, explanation] of [
        [converted.replace(row + '\n', ''), 'retain every original claim'],
        [converted.replace(row, row.replace(first[1], 'Changed claim meaning')), 'current claim number/text'],
        [mutateRecord(record => { record.old = '0'.repeat(40) }), 'old'],
        [mutateRecord(record => { record.claims[1].claim = 'Forged historical claim' }), 'immutable original'],
        [mutateRecord(record => { record.claims[1].status = 'missing' }), 'immutable original'],
        [mutateRecord(record => { record.claims[1].line++ }), 'immutable original'],
        [converted.replace('| PUBLISH-01 | Product |', '|  | Product |'), 'existing clause ids'],
        [converted.replace('| PUBLISH-01 | Product |', '| ABSENT-001 | Product |'), 'existing clause ids'],
        [converted.replace('| PUBLISH-01 | Product |', '|  | Non-product: license/public-repository ownership |'), 'product claim cannot acquire'],
        [mutateRecord(record => { record.claims[0].nonProduct = 'license/public-repository ownership' }).replace('| PUBLISH-01 | Product |', '|  | Non-product: license/public-repository ownership |'), 'product promises need real clauses'],
        [converted.replace(/<!-- contract-claim-source\n[\s\S]*?\n-->/, ''), 'require a contract-claim-source'],
      ]) {
        await edit(root, 'CONTRACT.md', text)
        refuses(root, explanation, 'write')
      }
      await edit(root, 'CONTRACT.md', converted)
      await generatedJourney(root)
      succeeds(root, 'coverage', 'check', '--old', old)
      const coveragePath = 'docs/contract/COVERAGE.json', coverageText = await read(root, coveragePath)
      await edit(root, coveragePath, coverageText.replace(old, '0'.repeat(40)))
      refuses(root, 'original SHA', 'check')
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
        const claimsSource = await read(root, 'docs/CLAIMS.md')
        const claims = [
          ["Keep each entry's identity", 'E1'],
          ['Draft entries stay private', 'PUBLISH-01'],
          ['Archived entries remain readable', 'AUTH-HOST-01'],
        ].map(([claim, id]) => ({ file: 'docs/CLAIMS.md', line: claimsSource.split('\n').findIndex(line => line.includes(`| ${claim} |`)) + 1, claim, clauses: [id] }))
        const claimMap = { schema: 1, old: oldCommit, claims }
        const before = await snapshot(root)
        refuses(root, 'Homepage claim', 'convert', '--old', oldCommit)
        assert.deepEqual(await snapshot(root), before, 'refusal changed the original documents')
        // Editing the working copy cannot repair the immutable --old input.
        await edit(root, 'docs/CLAIMS.md', claimsSource.replace('OWN-01', 'E1').replace('Honest boundaries', 'PUBLISH-01').replace('—', 'AUTH-HOST-01'))
        refuses(root, 'Homepage claim', 'convert', '--old', oldCommit)
        await edit(root, 'docs/CLAIMS.md', claimsSource)
        for (const [change, explanation] of [
          [{ claims: claims.slice(0, -1) }, 'Archived entries remain readable'],
          [{ old: '0'.repeat(40) }, 'old'],
          [{ claims: [...claims, claims[0]] }, 'duplicate'],
          [{ claims: [{ ...claims[0], claim: 'A different claim' }, ...claims.slice(1)] }, 'claim'],
          [{ claims: [{ ...claims[0], clauses: ['ABSENT-01'] }, ...claims.slice(1)] }, 'ABSENT-01'],
          [{ claims: [{ ...claims[0], clauses: [] }, ...claims.slice(1)] }, 'clauses'],
          [{ claims: [{ ...claims[0], line: 999 }, ...claims.slice(1)] }, '999'],
        ]) {
          await edit(root, 'claim-map.json', JSON.stringify({ ...claimMap, ...change }))
          refuses(root, explanation, 'convert', '--old', oldCommit, '--claim-map', 'claim-map.json')
          assert.deepEqual(await snapshot(root), before, 'invalid mapping changed the original documents')
          assert.equal(git(root, 'status', '--porcelain'), '?? claim-map.json', 'refusal wrote conversion records')
        }
        await edit(root, 'claim-map.json', JSON.stringify(claimMap))
        succeeds(root, 'convert', '--old', oldCommit, '--claim-map', 'claim-map.json')
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
        const optOutLine = claimsSource.split('\n').findIndex(line => line.includes('Do not sell entries')) + 1
        const optOut = coverage.fragments.filter(fragment => fragment.file === 'docs/CLAIMS.md' && fragment.line === optOutLine)
        assert.ok(optOut.length, 'the opt-out table row was not covered')
        assert.ok(optOut.every(fragment => fragment.section !== 'Homepage claims' && fragment.to !== 'generated'))
        const convertedText = await read(root, 'CONTRACT.md')
        const homepage = convertedText.split('## Homepage claims')[1].split('\n## ')[0]
        assert.ok(homepage.includes('Keep each entry\'s identity'), 'the larger handwritten homepage claims table was lost')
        assert.ok(!homepage.includes('Do not sell entries'), 'the opt-out row became a homepage claim')
        for (const claim of ["Publish the studio's entries", ...claims.map(row => row.claim)]) {
          for (const document of [homepage, await read(root, 'docs/CLAIMS.md')])
            assert.equal(document.split(`| ${claim} |`).length - 1, 1, `claim text/count changed: ${claim}`)
        }
        assert.ok((await read(root, 'docs/CLAIMS.md')).includes('Claims: 4; 2 done, 1 partial, 1 missing.'))
        for (const row of claims) {
          const originalRow = claimsSource.split('\n')[row.line - 1]
          assert.ok(coverage.fragments.some(fragment => fragment.file === row.file && fragment.line === row.line && fragment.text === originalRow), 'coverage lost the original claim or references')
        }
        assert.ok(convertedText.includes('Draft entries stay private.'))
        assert.ok(convertedText.includes('The editor saves the description and keeps the entry\'s owner.'))
        assert.ok(convertedText.includes('Archive collections for a long retention period. Archived entries remain readable.'))
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
