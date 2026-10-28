import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { parseContract } from './runtime/seed-contract.mjs'

const fixtures = join(import.meta.dirname, 'fixtures/contract-docs')
const generatedFiles = ['CONTRACT.md', 'ACCEPTANCE.md', 'docs/CLAIMS.md']
const read = (root, path) => readFile(join(root, path), 'utf8')
const edit = (root, path, contents) => writeFile(join(root, path), contents)
const snapshot = root => Promise.all(generatedFiles.map(path => read(root, path)))
const git = (root, ...args) => execFileSync('env', [
  'GIT_AUTHOR_NAME=Run Edit Run fleet', 'GIT_AUTHOR_EMAIL=fleet@runeditrun.com',
  'GIT_COMMITTER_NAME=Run Edit Run fleet', 'GIT_COMMITTER_EMAIL=fleet@runeditrun.com',
  'git', ...args,
], { cwd: root, encoding: 'utf8' }).trim()
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
  // Small public-command reproductions of the immutable source forms:
  // Coaster's OWN alias, Nectar's em dash and Crank's explicit boundary. These facts
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
    [
      [37, 'Limits: "No desktop or screen-scraping robots"', 'none needed: a boundary, true of the code', 'boundary'],
    ],
  ]
  for (const facts of sources) {
    const root = await installation('legacy')
    try {
      await rm(join(root, 'docs/CLAIMS.md'))
      const initial = await read(root, 'CONTRACT.md')
      const basis = facts[0][3]
      const productClaim = basis === 'boundary' ? 'Limits: "No unreviewed publishing"' : "Publish the studio's entries"
      const table = [
        '| # | Section | Claim | Clause(s) | Status |', '| --- | --- | --- | --- | --- |',
        `| 1 | Hero | ${productClaim} | PUBLISH-01 | done |`,
        ...facts.map(([number, claim, reference]) => `| ${number} | Closing | ${claim} | ${reference} | done |`),
        '| 2 | Catalogue | Publish entries as open source | — | partial |',
      ].join('\n')
      await edit(root, 'CONTRACT.md', initial.replace(/\| # \| Claim \| Clauses \|[\s\S]*?(?=\n## Status)/, table + '\n'))
      git(root, 'add', '.')
      git(root, '-c', 'user.name=Synthetic author', '-c', 'user.email=synthetic@example.invalid', 'commit', '-qm', 'Synthetic non-product source forms')
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
        [{ claims: [...claims, { file: 'CONTRACT.md', line: originalText.split('\n').findIndex(line => line.includes('| 1 | Hero |')) + 1, claim: productClaim, nonProduct: basis }] }, 'product promises need real clauses'],
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
        [mutateRecord(record => { record.claims[0].nonProduct = basis }).replace('| PUBLISH-01 | Product |', `|  | Non-product: ${basis} |`), 'product promises need real clauses'],
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
      if (basis === 'boundary') {
        // A negative-looking claim alone cannot grant the exception. Each
        // variant is a new immutable source, with a map bound to that source.
        for (const reference of ['', '—', 'OWN', 'a boundary', 'none needed: a boundary, true of the code; PUBLISH-01']) {
          const text = originalText.replace(facts[0][2], reference)
          await edit(root, 'CONTRACT.md', text)
          git(root, 'add', 'CONTRACT.md')
          git(root, '-c', 'user.name=Synthetic author', '-c', 'user.email=synthetic@example.invalid', 'commit', '-qm', 'Synthetic unsupported boundary reference')
          await edit(root, 'claim-map.json', JSON.stringify({ ...map, old: git(root, 'rev-parse', 'HEAD') }))
          refuses(root, 'product promises need real clauses', 'convert', '--old', 'HEAD', '--claim-map', 'claim-map.json')
          assert.equal(await read(root, 'CONTRACT.md'), text, 'refused boundary reference changed source')
        }
      }
    } finally { await rm(root, { recursive: true, force: true }) }
  }
}

async function sourceRowsJourney() {
  // Seed-observed headers, including an escaped pipe in Balm's launch command.
  for (const heading of ['Claim', 'Claims', 'Claim on the page', 'What the page claims', 'Claim text']) {
    const root = await installation('legacy')
    try {
      await rm(join(root, 'docs/CLAIMS.md'))
      const original = (await read(root, 'CONTRACT.md'))
        .replace('| # | Claim | Clauses |', `| Claim # | ${heading} | Clause id(s) | Status |`)
        .replace('| --- | --- | --- |', '| --- | --- | --- | --- |')
        .replace("| 1 | Publish the studio's entries | PUBLISH-01 |", '| 1 | Publish entries \\| keep identity | PUBLISH-01 | partly |')
        .replace('  Draft entries stay private.', '  Draft entries stay private.\n\n> Preserve the original decision.\n> Keep its attributed history.\n\n```text\n> literal code\n```')
      await edit(root, 'CONTRACT.md', original)
      git(root, 'add', '.')
      git(root, 'commit', '-qm', 'Synthetic observed table and quoted prose')
      succeeds(root, 'convert', '--old', 'HEAD')
      succeeds(root, 'check')
      succeeds(root, 'id-map', '--old', 'HEAD')
      succeeds(root, 'coverage', 'check', '--old', 'HEAD')
      const converted = await read(root, 'CONTRACT.md')
      assert.ok(!converted.includes('\n> Preserve'), 'conversion retained blockquote markers')
      assert.ok(converted.includes('\n> literal code\n'), 'conversion changed a literal code marker')
      const provenance = JSON.parse(converted.match(/<!-- contract-claim-source\n([\s\S]*?)\n-->/)[1])
      assert.equal(provenance.claims[0].status, 'partly')
      assert.ok((await read(root, 'docs/CLAIMS.md')).includes('| partly | done |'))
      const row = converted.split('\n').find(line => line.startsWith('| 1 |'))
      for (const changed of [converted.replace(row + '\n', ''), converted.replace(row, row.replace('keep identity', 'lose identity'))]) {
        await edit(root, 'CONTRACT.md', changed)
        for (const args of [['check'], ['coverage', 'check', '--old', 'HEAD']]) refuses(root, 'Publish entries', ...args)
      }
      // Older converted contracts without provenance must also be checked
      // against the immutable coverage source, even after regenerating views.
      await edit(root, 'CONTRACT.md', converted.replace(/<!-- contract-claim-source\n[\s\S]*?\n-->/, '').replace(row + '\n', ''))
      refuses(root, 'Publish entries', 'write')
      await edit(root, 'CONTRACT.md', converted)
      const coverage = await read(root, 'docs/contract/COVERAGE.json')
      const map = JSON.parse(coverage)
      for (const fragment of map.fragments) fragment.text = fragment.text.replace(/^>\s?/, '')
      await edit(root, 'docs/contract/COVERAGE.json', JSON.stringify(map))
      succeeds(root, 'coverage', 'check', '--old', 'HEAD')
      const quoted = map.fragments.find(fragment => fragment.text === 'Preserve the original decision.')
      quoted.text = 'Change the original decision.'
      await edit(root, 'docs/contract/COVERAGE.json', JSON.stringify(map))
      refuses(root, 'whole original text', 'coverage', 'check', '--old', 'HEAD')
      await edit(root, 'docs/contract/COVERAGE.json', coverage)
      await edit(root, 'CONTRACT.md', original.replace('| PUBLISH-01 | partly |', '| PUBLISH-01 | partly | extra |'))
      git(root, 'add', '.')
      git(root, 'commit', '-qm', 'Synthetic malformed homepage row')
      refuses(root, 'malformed row', 'convert', '--old', 'HEAD')
      await edit(root, 'CONTRACT.md', original.replace(`| ${heading} |`, '| Unrecognized promise column |'))
      git(root, 'add', '.')
      git(root, 'commit', '-qm', 'Synthetic unsupported heading')
      refuses(root, 'unrecognized claim heading', 'convert', '--old', 'HEAD')
    } finally { await rm(root, { recursive: true, force: true }) }
  }
}

async function apiRecordJourney() {
  const root = await installation('legacy'), base = await installation('legacy')
  try {
    const revision = git(base, 'rev-parse', 'HEAD'), tree = git(base, 'rev-parse', 'HEAD^{tree}')
    const bytes = await readFile(join(base, 'README.md'))
    const object = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
    const response = {
      [`commits/${revision}`]: { sha: revision, tree: { sha: tree } },
      [`trees/${tree}?recursive=1`]: { sha: tree, truncated: false, tree: [{ path: 'README.md', type: 'blob', mode: '100644', sha: object }] },
      [`blobs/${object}`]: { sha: object, encoding: 'base64', size: bytes.length, content: bytes.toString('base64') },
    }
    const tools = join(root, 'tools')
    await mkdir(tools)
    await writeFile(join(tools, 'responses.json'), JSON.stringify(response))
    await writeFile(join(tools, 'gh'), `#!/usr/bin/env node
const fs = require('fs');
const values = JSON.parse(fs.readFileSync(__dirname + '/responses.json', 'utf8'));
const endpoint = process.argv[3]?.split('/git/')[1];
if (!values[endpoint]) process.exit(1);
process.stdout.write(JSON.stringify(values[endpoint]));
`, { mode: 0o755 })
    const record = (...args) => spawnSync(process.execPath, [join(import.meta.dirname, '../edition-authoring/cli.mjs'), 'record-base', 'README.md', 'README.md', revision, ...args], {
      cwd: root, encoding: 'utf8', env: { ...process.env, PATH: tools + ':' + process.env.PATH },
    })
    let result = record('--base', base)
    assert.equal(result.status, 0, result.stderr)
    const expected = await read(root, 'base-copies.json')
    result = record('--from-api')
    assert.equal(result.status, 0, result.stderr)
    assert.equal(await read(root, 'base-copies.json'), expected, 'API and checkout records differ')
    for (const broken of [
      {},
      { ...response, [`commits/${revision}`]: { sha: '0'.repeat(40), tree: { sha: tree } } },
      { ...response, [`trees/${tree}?recursive=1`]: { ...response[`trees/${tree}?recursive=1`], truncated: true } },
      { ...response, [`blobs/${object}`]: { ...response[`blobs/${object}`], content: Buffer.from('changed').toString('base64') } },
    ]) {
      await writeFile(join(tools, 'responses.json'), JSON.stringify(broken))
      result = record('--from-api')
      assert.notEqual(result.status, 0)
      assert.equal(await read(root, 'base-copies.json'), expected, 'API refusal changed the record')
    }
    result = record('--from-api', '--offline')
    assert.notEqual(result.status, 0)
    result = record('--offline')
    assert.notEqual(result.status, 0)
    assert.equal(await read(root, 'base-copies.json'), expected)
    result = record('--from-api', '--record', 'unavailable.json')
    assert.notEqual(result.status, 0)
    await assert.rejects(read(root, 'unavailable.json'), { code: 'ENOENT' })
  } finally { await Promise.all([root, base].map(root => rm(root, { recursive: true, force: true }))) }
}

test('contract docs convert handwritten contracts and keep generated documents and migration maps accountable', async () => {
  const roots = await Promise.all(['standard', 'legacy'].map(installation))
  try {
    const results = await Promise.allSettled([
      nonProductJourney(),
      sourceRowsJourney(),
      apiRecordJourney(),
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
        const statusTableLines = oldSource.split('\n').flatMap((line, index) => /^\| (Clauses|Published|Target and push further|All|Clause) \|/.test(line) ? [index + 1] : [])
        assert.ok(statusTableLines.length >= 5, 'the legacy fixture lost its Status tables')
        assert.ok(!coverage.fragments.some(fragment => fragment.file === 'CONTRACT.md' && statusTableLines.includes(fragment.line)), 'Status table headers and summary rows are carried by the ID map and status, not coverage')
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
