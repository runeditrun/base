import { queuedEntrypoint } from '../onboarding/queued-entry.mjs';
const queuedExit=await queuedEntrypoint(import.meta.url,'verify:browser');
if(queuedExit!==null)process.exit(queuedExit);
import assert from 'node:assert/strict'
import { mkdtemp, cp, rm, mkdir, readFile, writeFile, symlink, lstat, realpath, rename } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { sourceRoots } from '../cli/export.mjs'
const root = resolve(import.meta.dirname, '..')
const { initialize } = await import('./initialize.mjs')
const { verifyInstaller } = await import('./installer-verification.mjs')
const tmp = await mkdtemp(resolve(tmpdir(), 'rer-foundation-runtime-'))
const previousServers = process.env.RER_SERVERS_DIR
process.env.RER_SERVERS_DIR = resolve(tmp, 'servers')
const base=resolve(tmp,'base'), family=resolve(tmp,'family'), output=resolve(tmp,'edition')
const git=(repo,...args)=>execFileSync('git',['-C',repo,...args],{stdio:['ignore','pipe','pipe']}).toString().trim()

// Only disposable exports and synthetic populated bindings. No providers, live
// state, browser, deployment, process inspection or process kills are needed.
async function verifyStateSafety(edition) {
 const { selectLocalState, adapter } = await import(pathToFileURL(resolve(edition, 'scripts/installer/local.mjs')))
 const {installationFailureMessage}=await import(pathToFileURL(resolve(edition,'scripts/base-onboarding/failures.mjs')))
 // Exercise the shared preparation boundary directly. Browser install now
 // delegates to the real dispatcher and owns its final managed preview.
 const install=async(root,input,store,onApp)=>{try{await adapter.run(root,input,store,onApp,undefined,{verb:'setup'});}catch(error){store.state.error=adapter.hooks.failure?.(error,{store})??installationFailureMessage(error);await store.phase('failed');}}
 const { createState } = await import(pathToFileURL(resolve(edition, 'scripts/base-onboarding/state.mjs')))
 const { createSeed } = await import(pathToFileURL(resolve(edition, 'scripts/installer/seed.mjs')))
 const { commandFailure } = await import(pathToFileURL(resolve(edition, 'scripts/base-onboarding/failures.mjs')))
 const { loadInstallerSeed } = await import(pathToFileURL(resolve(edition, 'scripts/base-onboarding/setup-manifest.mjs')))
 const fixtureStore = async () => {const seed=await loadInstallerSeed(edition,createSeed(edition));const store=await createState(edition,seed);store.setupManifest=seed.manifest;return store;}
 const hash = bytes => createHash('sha256').update(bytes).digest('hex')
 const durable = await selectLocalState(edition)
 assert.equal(durable, resolve(await realpath(edition), '.wrangler/state'))
 execFileSync('pnpm', ['install', '--frozen-lockfile'], { cwd: edition, stdio: 'inherit' })
 const require = createRequire(await realpath(resolve(edition, 'node_modules/wrangler/package.json')))
 const { Miniflare, convertV4MiniflareOptions } = await import(pathToFileURL(require.resolve('miniflare')))
 const blob = Buffer.from('synthetic prior R2 blob\u0000state-safety'), session = 'synthetic-session-token'
 async function snapshot(seed = false) {
  // Match this pinned Wrangler's own local D1 construction and v3 root.
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response("fixture") } }',
   port: 16200, host: '127.0.0.1', cf: false, d1Databases: { DB: 'state-safety-db' }, r2Buckets: { FILES: 'state-safety-files' },
   resourceTmpPath: resolve(tmp, 'binding-temp'), unsafeDevRegistryPath: resolve(tmp, 'binding-registry'),
   resourcePersistencePath: resolve(durable, 'v3') }))
  try {
   const db = await mf.getD1Database('DB'), bucket = await mf.getR2Bucket('FILES')
   if (seed) {
    await db.exec("CREATE TABLE records (id TEXT PRIMARY KEY, value TEXT); CREATE TABLE sessions (token TEXT PRIMARY KEY, owner TEXT); CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)")
    await db.prepare('INSERT INTO records VALUES (?, ?)').bind('prior-row', 'owner content').run()
    await db.prepare('INSERT INTO sessions VALUES (?, ?)').bind(session, 'fixture-owner').run()
    await db.prepare('INSERT INTO d1_migrations VALUES (?, ?, ?)').bind(1, '0001_prior.sql', '2026-10-01').run()
    await bucket.put('prior/blob', blob, { customMetadata: { owner: 'fixture-owner' } })
   }
   const rows = (await db.prepare('SELECT * FROM records ORDER BY id').all()).results
   const sessions = (await db.prepare('SELECT * FROM sessions ORDER BY token').all()).results
   const ledger = (await db.prepare('SELECT * FROM d1_migrations ORDER BY id').all()).results
   const object = await bucket.get('prior/blob')
   assert.ok(object)
   assert.equal(sessions[0].token, session)
   return { rows: hash(JSON.stringify(rows)), sessions: hash(JSON.stringify(sessions)), ledger: hash(JSON.stringify(ledger)),
    blob: hash(Buffer.from(await object.arrayBuffer())), metadata: object.customMetadata }
  } finally { await mf.dispose() }
 }
 const before = await snapshot(true)
 assert.equal(before.blob, hash(blob))
 for (let cycle = 0; cycle < 2; cycle++) {
  // Exercise the real installer through its install/build phases, then stop at
  // the pre-launch step by an explicit fixture exception. This leaves no child
  // preview to kill. Binding restarts use Miniflare's owned dispose lifecycle.
  const store = await fixtureStore();
  store.setupManifest = (await (await import(resolve(edition, 'scripts/base-onboarding/setup-manifest.mjs'))).loadInstallerSeed(edition, (await import(resolve(edition, 'scripts/installer/seed.mjs'))).createSeed(edition))).manifest;
  const state = store.state, steps = [], step = store.step.bind(store)
  store.step = async message => { steps.push(message); if (message === 'Starting your application on this computer') throw commandFailure(store.redact('fixture pre-launch stop')); await step(message) }
  await install(edition, { APP_NAME: 'State safety fixture', PRIMARY_COLOR: '#356c60', displayName: 'Owner', OWNER_EMAIL: 'state-owner@example.test' }, store, () => { throw Error('fixture must not launch a child preview') })
  assert.equal(state.phase, 'failed')
  assert.equal(state.error, 'fixture pre-launch stop')
  assert.ok(steps.includes('Building your application'))
  assert.ok((await readFile(resolve(edition, 'dist/server/wrangler.json'))).length)
  assert.deepEqual(await snapshot(), before, `populated D1/R2 preserved after install/build/restart ${cycle + 1}`)
  await store.closeCommands()
 }
 const branding = await readFile(resolve(edition, 'src/branding.json'))
 const marker = resolve(edition, 'dist/cleanup-sentinel')
 await writeFile(marker, 'generated-output sentinel')
 async function refused(pattern, checkSnapshot = true) {
  const store = await fixtureStore();
  store.setupManifest = (await (await import(resolve(edition, 'scripts/base-onboarding/setup-manifest.mjs'))).loadInstallerSeed(edition, (await import(resolve(edition, 'scripts/installer/seed.mjs'))).createSeed(edition))).manifest;
  const state = store.state, steps = [], step = store.step.bind(store)
  store.step = async message => { steps.push(message); await step(message) }
  await install(edition, { APP_NAME: 'MUST NOT SAVE' }, store, () => assert.fail('unsafe launch'))
  assert.equal(state.phase, 'failed'); assert.match(state.error, pattern)
  assert.deepEqual(steps, [], 'refusal precedes branding, dependency install, build and launch')
  assert.deepEqual(await readFile(resolve(edition, 'src/branding.json')), branding)
  assert.equal(await readFile(marker, 'utf8'), 'generated-output sentinel')
  if (checkSnapshot) assert.deepEqual(await snapshot(), before)
  await store.closeCommands()
 }
 const alias = resolve(edition, 'state-alias')
 await symlink(resolve(edition, 'dist'), alias)
 const previous = process.env.RER_LOCAL_STATE_PATH
 try {
  process.env.RER_LOCAL_STATE_PATH = resolve(alias, 'nested/state')
  await refused(/overlaps generated dist/)
  process.env.RER_LOCAL_STATE_PATH = 'dist/new/state'
  await refused(/overlaps generated dist/)
  process.env.RER_LOCAL_STATE_PATH = '.'
  await refused(/overlaps generated/)
  process.env.RER_LOCAL_STATE_PATH = ''
  await refused(/nonempty persistence directory/)
 } finally { if (previous === undefined) delete process.env.RER_LOCAL_STATE_PATH; else process.env.RER_LOCAL_STATE_PATH = previous }
 await rm(alias)
 const trapped = resolve(edition, 'dist/trapped-state'), backup = resolve(edition, '.wrangler/fixture-backup')
 await cp(durable, trapped, { recursive: true })
 await rename(durable, backup)
 await symlink(trapped, durable)
 const trappedBytes = await fileHashes(trapped)
 await refused(/overlaps generated dist/, false)
 assert.deepEqual(await fileHashes(trapped), trappedBytes, 'canonical state alias refused without altering populated bytes')
 await rm(durable); await rename(backup, durable)
 await symlink(durable, resolve(edition, '.output'))
 await refused(/overlaps generated .output/)
 await rm(resolve(edition, '.output'))
 const legacy = resolve(edition, 'dist/server/.wrangler/state')
 await mkdir(legacy, { recursive: true })
 // Copy real populated fixture state into the unsafe legacy location, then
 // refuse before cleanup. This is verification data, never an owner migration.
 await cp(durable, legacy, { recursive: true })
 const legacyBytes = await fileHashes(legacy)
 await refused(/legacy state exists/)
 assert.deepEqual(await fileHashes(legacy), legacyBytes)
 await rm(legacy, { recursive: true }) // Fixture-owned cleanup only.
 await symlink(resolve(edition, 'missing-legacy'), legacy)
 await refused(/unresolved symlink/)
 assert.ok((await lstat(legacy)).isSymbolicLink(), 'dangling legacy link retained')
 await rm(legacy)
 await symlink(resolve(edition, 'missing-ancestor'), alias)
 await assert.rejects(selectLocalState(edition, resolve(alias, 'state')), /unresolved symlink/)
 await rm(alias)
 // Contract adoption refuses external aliases while preserving their destination.
 const external = resolve(tmp, 'durable-external')
 await mkdir(external); await symlink(external, alias)
 await assert.rejects(selectLocalState(edition, resolve(alias, 'new/state')), /canonical persistence/)
 await rm(alias)
 console.log('State safety passed: two real install/build phases and D1/R2 restarts; row/blob/session/ledger hashes preserved; physical alias and legacy refusals precede effects', JSON.stringify(before))
}
async function fileHashes(directory) {
 const { readdir } = await import('node:fs/promises')
 const result = {}
 async function visit(dir, prefix = '') {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
   const name = prefix + entry.name, path = resolve(dir, entry.name)
   if (entry.isDirectory()) await visit(path, name + '/')
   else result[name] = createHash('sha256').update(await readFile(path)).digest('hex')
  }
 }
 await visit(directory)
 return result
}
try {
const prerequisites = ['foundation','composition','schema','onboarding','export']
const fixtureRoots = [...new Set([...prerequisites, ...sourceRoots])].filter(name => !prerequisites.some(root => name.startsWith(`${root}/`)))
for (const name of fixtureRoots) await cp(resolve(root,name),resolve(base,name),{recursive:true,filter:p=>!p.includes('node_modules')})
await cp(resolve(root,'LICENSE'),resolve(base,'LICENSE'))
git(base,'init');git(base,'add','.');git(base,'-c','user.name=Test','-c','user.email=base-test@example.invalid','commit','-qm','verification fixture')
const ref=git(base,'rev-parse','HEAD')
await initialize({baseRepo:base,ref,family:'future',edition:'first',repository:'just-every/run-orbit',output:family})
git(family,'init');git(family,'add','.');git(family,'-c','user.name=Test','-c','user.email=base-test@example.invalid','commit','-qm','verification fixture')
execFileSync(process.execPath,[root+'/composition/cli.mjs','first','--family-repo',family,'--base-repo',base,'--output',output],{stdio:'inherit'})
execFileSync(process.execPath, ['scripts/rer.mjs', 'describe'], { cwd: output, stdio: 'inherit' })
// The v2 descriptor now declares owner-account deploy inputs. Inspector checks
// remain local: prove missing inputs, then supply fictional fixture values.
const { inspectOperations } = await import(pathToFileURL(resolve(output, 'scripts/base-cli/operations/operations.mjs')).href)
assert.deepEqual((await inspectOperations(output, { ...process.env, CLOUDFLARE_ACCOUNT_ID: '', CLOUDFLARE_API_TOKEN: '' })).missingEnvironment, ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'])
assert.equal((await inspectOperations(output, { ...process.env, CLOUDFLARE_ACCOUNT_ID: '0'.repeat(32), CLOUDFLARE_API_TOKEN: 'test-only-inspection-input' })).ok, true)
const originalStatePath = process.env.RER_LOCAL_STATE_PATH
try {
 process.env.RER_LOCAL_STATE_PATH = resolve(output, '.wrangler/state')
 await verifyStateSafety(output)
} finally { if (originalStatePath === undefined) delete process.env.RER_LOCAL_STATE_PATH; else process.env.RER_LOCAL_STATE_PATH = originalStatePath }
if (!process.argv.includes('--state-safety-only')) {
const installerOutput=resolve(tmp,'installer-edition')
execFileSync(process.execPath,[root+'/composition/cli.mjs','first','--family-repo',family,'--base-repo',base,'--output',installerOutput],{stdio:'inherit'})
await verifyInstaller(installerOutput)
// Onboarding just built this personalized export. Check that same artifact
// without repeating the build in the standalone verify/setup commands.
for (const command of ['typecheck', 'test:typecheck', 'test:runtime']) {
 execFileSync('pnpm', ['run', command], { cwd: installerOutput, stdio: 'inherit' })
}
execFileSync('pnpm', ['exec', 'wrangler', 'deploy', '--dry-run'], { cwd: installerOutput, stdio: 'inherit' })
console.log('Fresh committed foundation export, frozen install, build, runtime and deployment dry run passed')
}

} finally {
 if (previousServers === undefined) delete process.env.RER_SERVERS_DIR
 else process.env.RER_SERVERS_DIR = previousServers
 await rm(tmp, { recursive: true, force: true })
}
