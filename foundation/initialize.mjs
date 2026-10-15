import { mkdir, writeFile, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { commit, select, sha256, tree } from '../composition/git-source.mjs'
import { sourceRoots } from '../cli/export.mjs'
import { stampedVersion } from '../cli/version.mjs'

export async function initialize({ baseRepo, ref, output, family, edition, repository, siteDomain = `run-${edition}.example` }) {
  for (const id of [family, edition]) if (!/^[a-z][a-z0-9-]*$/.test(id) || id === 'base') throw new Error('Invalid family/edition id')
  if (family === edition || !/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Distinct identities and owner/repository required')
  // The run site's apex domain; the reserved .example default fails a real deploy at zone lookup.
  if (!/^(?!www\.)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/.test(siteDomain)) throw new Error('The run site domain is an apex hostname such as run-example.com')
  const revision = commit(baseRepo, ref)
  const files = select(baseRepo, revision, 'foundation/template')
  const cliFiles = sourceRoots.flatMap(path => select(baseRepo, revision, path, { includeTests: false }))
  const runtime = [...select(baseRepo, revision, 'foundation/runtime'), ...select(baseRepo, revision, 'onboarding', { includeTests: false }), ...select(baseRepo, revision, 'modules/operator-auth', { includeTests: false }), ...select(baseRepo, revision, 'modules/mail', { includeTests: false }), ...cliFiles]
  const target = resolve(output)
  await mkdir(target) // Never overwrite an owner checkout.
  const provenance = {}
  const modules = [...new Set(sourceRoots.filter(source => source.startsWith('modules/')).map(source => source.split('/')[1]))]
  async function put(path, bytes, origin) {
    await mkdir(dirname(resolve(target, path)), { recursive: true })
    await writeFile(resolve(target, path), bytes)
    provenance[path] = { sha256: sha256(bytes), ...(origin ? { source: origin } : { generated: true }) }
  }
  const json = (path, data) => put(path, JSON.stringify(data, null, 2) + '\n')
  try {
    for (const file of files) await put(`editions/${edition}/${file.relative}`, file.bytes, file.path)
    const workflow = select(baseRepo, revision, 'export/verify.yml')[0]
    await put(`editions/${edition}/.github/workflows/verify.yml`, workflow.bytes, workflow.path)
    await json('family.json', { schemaVersion: 1, id: family, repository, base: { repository: 'runeditrun/base', commit: revision } })
    await put('core/README.md', '# Headless family core\n\nAdd domain source only when every edition needs it. No domain is preselected.\n')
    await put('modules/README.md', '# Optional family capabilities\n\nAdd modules when an edition needs them. Promote to Base only for actual cross-family reuse.\n')
    await json(`compositions/${edition}.json`, { schemaVersion: 2, base: 'base', family, edition, modules, source: `editions/${edition}`, copies: [
      { component: family, repository: 'family', source: 'core', target: `src/family/${family}` },
      { component: 'base', repository: 'base', source: 'foundation/runtime', target: 'src/base' },
      { component: 'base', repository: 'base', source: 'LICENSE', target: 'LICENSE' },
      { component: 'base', repository: 'base', source: 'onboarding', target: 'scripts/base-onboarding' },
      ...sourceRoots.map(source => ({ component: source.startsWith('modules/') ? source.split('/')[1] : 'base', repository: 'base', source, target: `scripts/base-cli/${source}` })),
      { component: 'operator-auth', repository: 'base', source: 'modules/operator-auth', target: 'src/modules/operator-auth' },
      { component: 'mail', repository: 'base', source: 'modules/mail', target: 'src/modules/mail' },
      { component: 'ai', repository: 'base', source: 'modules/ai', target: 'src/modules/ai' },
      ...['dependencies','owner-claim'].map(name=>({component:name,repository:'base',source:`modules/${name}`,target:`src/modules/${name}`})),
      ...[['operator-auth','accounts/schema/provider-control.sql','0006_provider_control'],['dependencies','schema/dependencies.sql','0007_dependencies'],['owner-claim','schema/owner-claim.sql','0008_owner_claim'],['owner-claim','schema/idp.sql','0009_idp_owner'],['operator-auth','accounts/schema/provider-pins.sql','0010_provider_pins'],['operator-auth','accounts/schema/dependency-setup.sql','0011_dependency_setup'],['dependencies','schema/approval-attempt.sql','0012_dependency_approval'],['operator-auth','accounts/schema/owner-signin.sql','0014_owner_signin']].map(([component,file,name])=>({component,repository:'base',source:`modules/${component}/${file}`,target:`migrations/core/${name}.sql`})),
      { component: 'operator-auth', repository: 'base', source: 'modules/operator-auth/accounts/schema/operator-auth.sql', target: 'migrations/core/0001_owner.sql' },
      { component: 'operator-auth', repository: 'base', source: 'modules/operator-auth/identity/oidc/schema/oidc.sql', target: 'migrations/core/0005_identity_providers.sql' },
      { component: 'mail', repository: 'base', source: 'modules/mail/src/development/schema.sql', target: 'migrations/core/0002_outbox.sql' },
      { component: 'portability', repository: 'base', source: 'modules/portability/schema/portability.sql', target: 'migrations/core/0003_portability.sql' },
      { component: 'erasure', repository: 'base', source: 'modules/erasure/schema/erasure.sql', target: 'migrations/core/0013_erasure.sql' },
      { component: 'base', repository: 'base', source: 'export/SEED-COMMAND-CONTRACT.md', target: 'SEED-COMMAND-CONTRACT.md' },
      { component: 'base', repository: 'base', source: 'export/RUN-LOCALLY.md', target: 'RUN-LOCALLY.md' },
      { component: 'base', repository: 'base', source: 'export/HOMEPAGE-VARIANTS.md', target: 'HOMEPAGE-VARIANTS.md' },
      { component: 'base', repository: 'base', source: 'export/VERIFY-WORKFLOW.md', target: 'VERIFY-WORKFLOW.md' },
    ] })
    // The rer version of the selected Base revision, when it has the version source.
    const versionSource = tree(baseRepo, revision).some(entry => entry.path === 'global/package.json') && select(baseRepo, revision, 'global/package.json')[0]
    const cliVersion = versionSource ? stampedVersion(baseRepo, JSON.parse(versionSource.bytes).version, revision) : undefined
    await json(`editions/${edition}/scripts/base-cli/inventory.json`, { version: 1, ...(cliVersion ? { cliVersion } : {}), onboarding: '../base-onboarding', onboardingFiles:Object.fromEntries(select(baseRepo, revision, 'onboarding', {includeTests:false}).map(file=>[file.relative,{source:file.path,sha256:sha256(file.bytes)}])), files: Object.fromEntries(cliFiles.map(file => [file.path, { source: file.path, sha256: sha256(file.bytes) }]).sort(([a], [b]) => a.localeCompare(b))) })
    const guide = files.find(f => f.relative === 'AGENTS.md')
    await put(`editions/${edition}/AGENTS.md`, guide.bytes.toString() + `\nPinned reference: https://github.com/runeditrun/base/blob/${revision}/TANSTACK-START-MIGRATION.md\nNative-session/runtime evidence: https://github.com/runeditrun/base/tree/${revision}/default-seed\n`, guide.path)
    const pkg = JSON.parse(files.find(f => f.relative === 'package.json').bytes)
    pkg.name = `@${family}/${edition}`
    await json(`editions/${edition}/package.json`, pkg)
    await json(`editions/${edition}/src/branding.json`, { name: edition, primaryColor: '#356c60' })
    // Authoring metadata remains attached to the family repository. Public Run
    // instructions name the edition's product repository by convention.
    const run = JSON.parse(files.find(f => f.relative === 'src/site/run.json').bytes)
    const publicRepository = `just-every/run-${edition}`
    Object.assign(run, { name: edition, repository: `https://github.com/${publicRepository}`, clone: `git clone https://github.com/${publicRepository}.git`, folder: `run-${edition}` })
    await json(`editions/${edition}/src/site/run.json`, run)
    await json(`editions/${edition}/deploy-site.json`, { version: 1, domain: siteDomain })
    const browserSeed = files.find(f => f.relative === 'scripts/installer/ui/seed.mjs')
    await put(`editions/${edition}/scripts/installer/ui/seed.mjs`, browserSeed.bytes.toString().replace("name: 'Foundation'", `name: ${JSON.stringify(edition)}`), browserSeed.path)
    const setup = JSON.parse(files.find(f => f.relative === 'rer-setup.json').bytes)
    const appName = setup.fields.find(field => field.name === 'APP_NAME')
    if (!appName) throw new Error('Foundation setup manifest must declare APP_NAME')
    setup.title = edition
    appName.default = edition
    await json(`editions/${edition}/rer-setup.json`, setup)
    const config = JSON.parse(files.find(f => f.relative === 'wrangler.jsonc').bytes)
    config.name = `${family}-${edition}`
    await json(`editions/${edition}/wrangler.jsonc`, config)
    const operations = JSON.parse(files.find(f => f.relative === 'OPERATIONS.json').bytes)
    operations.project = `${family}/${edition}`
    await json(`editions/${edition}/OPERATIONS.json`, operations)
    const deployment = JSON.parse(files.find(f => f.relative === 'deploy.json').bytes)
    deployment.project = `${family}/${edition}`
    await json(`editions/${edition}/deploy.json`, deployment)
    const seed = JSON.parse(files.find(f => f.relative === 'seed.json').bytes)
    Object.assign(seed, { id: edition, name: edition, composition: { base: 'base', family, edition, modules } })
    await json(`editions/${edition}/seed.json`, seed)
    await put('.gitignore', 'node_modules/\ndist/\n.rer/\n.wrangler/\n.tanstack/\n.env*\n.dev.vars*\n.seed/\n.cache/\n*.tsbuildinfo\n')
    await put('README.md', `# ${family} author source\n\nCommit this tree, then export ${edition} with the pinned Base edition command.\nThe initial edition is a technical foundation, not a finished product.\nRead editions/${edition}/AGENTS.md before adding private surfaces.\n`)
    await json('foundation.lock.json', { schemaVersion: 1, base: { repository: 'runeditrun/base', commit: revision }, files: provenance, runtime: Object.fromEntries(runtime.map(f => [f.path, sha256(f.bytes)])) })
    return { baseCommit: revision, output: target }
  } catch (error) { await rm(target, { recursive: true, force: true }); throw error }
}
