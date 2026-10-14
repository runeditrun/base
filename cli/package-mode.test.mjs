// Package mode through its public doors: `rer check --profile first-party`
// on a checkout that pins the built @runeditrun/rer package (its adapter
// importing the package's exports), and the export tool's --to-package
// converting a vendored seed's delivery operations, scripts and workflows, and
// refusing a vendored copy that holds local edits.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { access, cp, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { buildPackage } from '../scripts/rer-package.mjs';
import { integrity, localRegistry } from '../scripts/rer-package/registry.mjs';
import { readPackage, writePackage } from '../global/update/archive.mjs';
import { exportCLI } from './export.mjs';
import { exportReference } from '../scripts/export-reference.mjs';
import { initialize } from '../foundation/initialize.mjs';
import { assemble } from '../composition/assemble.mjs';
import { sourceRoots } from './export.mjs';
import { aliases, pins, verbs } from './contract.mjs';
import { run } from '../global/tests/harness.mjs';
import { freePort, pause } from './fixtures/reference.mjs';

const base = resolve(import.meta.dirname, '..');
const common = [...Object.keys(verbs), 'release'];
const commandLine = verb => `rer${verb ? ' ' + verb : ''}`;

// The pnpm 9 lockfile pnpm writes for a checkout whose one dependency is the package.
const lockfile = (specifier, version) => `lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .:\n    devDependencies:\n      '@runeditrun/rer':\n        specifier: ${specifier}\n        version: ${version}\n\npackages:\n\n  '@runeditrun/rer@${version}':\n    resolution: {integrity: sha512-${'A'.repeat(86)}==}\n    engines: {node: '>=22'}\n    hasBin: true\n\nsnapshots:\n\n  '@runeditrun/rer@${version}': {}\n`;

// The package built from this checkout, once for every test.
let built, bytes;
before(async () => {
 built = await mkdtemp(join(tmpdir(), 'rer-package-built-'));
 bytes = await readFile(await buildPackage(base, built));
});
after(() => built && rm(built, { recursive: true, force: true }));

test('check accepts a checkout that pins the rer package and names the fix for each package clause', async t => {
 const root = await mkdtemp(join(tmpdir(), 'rer-package-mode-'));
 t.after(() => rm(root, { recursive: true, force: true }));
 // node_modules holds the package exactly as a registry would serve it.
 const files = readPackage(bytes, { integrity: integrity(bytes) });
 const { version } = JSON.parse(files.find(file => file.path === 'package.json').data);
 await mkdir(join(root, 'node_modules/@runeditrun'), { recursive: true });
 await writePackage(files, join(root, 'node_modules/@runeditrun/rer'));

 const pkg = { engines: { node: pins.node }, packageManager: `pnpm@${pins.pnpm}`, devDependencies: { '@runeditrun/rer': version }, scripts: Object.fromEntries(Object.entries(aliases).map(([alias, verb]) => [alias, commandLine(verb)])) };
 const descriptor = { version: 2, project: 'example/seed', requiredEnvironment: [], runtime: { requirements: [] }, seedContract: { version: 1, profile: 'first-party', adapter: 'adapter.mjs' }, commands: Object.fromEntries(common.map(verb => [verb, { argv: ['rer', verb], inputs: ['package.json'], effects: 'Structural fixture target; this check must never execute it.' }])) };
 // The adapter reaches Base only through the package's exports.
 await writeFile(join(root, 'adapter.mjs'), `import{localInstaller}from '@runeditrun/rer/local-installer';import{commandAdapter}from '@runeditrun/rer/adapter';const lifecycle=localInstaller({dependencies:['node',['never-execute.mjs']],build:['node',['never-execute.mjs']],migrate:['node',['never-execute.mjs']],start:['node',['never-execute.mjs']],owner:{},signIn:{}});const adapter=commandAdapter(lifecycle,{preview:['node',['never-execute.mjs']],verify:['node',['never-execute.mjs']],deploy:()=>{},portability:{export:()=>{},import:()=>{}},input:{names:{email:'email',name:'displayName'},validate:value=>value}});export{adapter as commandAdapter};\n`);
 await writeFile(join(root, 'never-execute.mjs'), "throw Error('Structural checks executed an effect')");
 await writeFile(join(root, '.node-version'), pins.node + '\n');
 // Delivery operations, the script one runs and a CI workflow, all calling rer.
 const delivery = { 'rer-project.json': JSON.stringify({ operations: { setup: 'bash scripts/delivery/setup.sh', build: 'pnpm exec rer build' } }), 'scripts/delivery/setup.sh': 'pnpm install --frozen-lockfile && pnpm exec rer install\n', '.github/workflows/verify.yml': 'jobs:\n  verify:\n    steps:\n      - run: pnpm install --frozen-lockfile && pnpm exec rer install\n      - run: pnpm exec rer verify\n' };
 const save = async ({ declaration = descriptor, packageJson = pkg, lock = lockfile(version, version), extra = {} } = {}) => {
  await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify(declaration));
  await writeFile(join(root, 'package.json'), JSON.stringify(packageJson));
  await writeFile(join(root, 'pnpm-lock.yaml'), lock);
  for (const [path, text] of Object.entries({ ...delivery, ...extra })) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text); }
 };
 // The installed launcher's way in: rer runs the checkout's own pinned package.
 const check = () => {
  const result = spawnSync(process.execPath, [join(base, 'global/rer.mjs'), 'check', '--profile', 'first-party', '--json'], { cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME, RER_NO_UPDATE_CHECK: '1' }, encoding: 'utf8', timeout: 30000 });
  if (!result.stdout.trim()) throw Error(`no output (exit ${result.status}): ${result.stderr}`);
  return { ...result, report: JSON.parse(result.stdout.trim().split('\n').at(-1)) };
 };
 const failing = report => Object.fromEntries(report.clauses.filter(clause => !clause.ok).map(clause => [clause.id, clause.message]));

 // Every named export resolves to a file of the installed package.
 const resolveFrom = createRequire(join(root, 'package.json')), installed = join(await realpath(root), 'node_modules/@runeditrun/rer/');
 for (const key of Object.keys(JSON.parse(files.find(file => file.path === 'package.json').data).exports).filter(key => !key.includes('*'))) {
  const resolved = resolveFrom.resolve('@runeditrun/rer' + key.slice(1));
  assert.ok(resolved.startsWith(installed), `${key} resolves inside the package`);
  await access(resolved);
 }
 await save();
 const accepted = check();
 assert.equal(accepted.status, 0, JSON.stringify(failing(accepted.report)) + accepted.stderr);
 for (const id of ['SC-13.package.pin', 'SC-13.package.lockfile', 'SC-13.package.vendored.scripts/rer.mjs', 'SC-13.package.calls', 'SC-02.target.build', 'SC-02.alias.build']) assert.ok(accepted.report.clauses.some(clause => clause.id === id && clause.ok), `${id} is checked`);
 assert.ok(!accepted.report.clauses.some(clause => clause.id.startsWith('SC-01.inventory') || clause.id.startsWith('SC-01.portable')), 'no vendored inventory is asked for');

 const cases = [
  [{ packageJson: { ...pkg, devDependencies: { '@runeditrun/rer': '^' + version } }, lock: lockfile('^' + version, version) }, 'SC-13.package.pin', /exact version/],
  [{ packageJson: { ...pkg, devDependencies: {}, dependencies: { '@runeditrun/rer': version } } }, 'SC-13.package.pin', /devDependencies/],
  [{ lock: lockfile('0.0.1', '0.0.1') }, 'SC-13.package.lockfile', /pnpm install/],
  [{ declaration: { ...descriptor, commands: { ...descriptor.commands, build: { ...descriptor.commands.build, argv: ['node', 'scripts/rer.mjs', 'build'] } } } }, 'SC-02.target.build', /rer build/],
  [{ packageJson: { ...pkg, scripts: { ...pkg.scripts, build: 'node scripts/rer.mjs build' } } }, 'SC-02.alias.build', /rer build/],
  [{ extra: { 'rer-project.json': JSON.stringify({ operations: { setup: 'bash scripts/delivery/setup.sh', build: 'node scripts/rer.mjs build' } }) } }, 'SC-13.package.calls', /pnpm exec rer[^]*rer-project\.json operations\.build/],
  [{ extra: { 'scripts/delivery/setup.sh': 'node scripts/rer.mjs install\n' } }, 'SC-13.package.calls', /scripts\/delivery\/setup\.sh:1/],
  [{ extra: { '.github/workflows/verify.yml': delivery['.github/workflows/verify.yml'].replace('pnpm exec rer verify', 'node scripts/rer.mjs verify') } }, 'SC-13.package.calls', /verify\.yml:5/],
 ];
 for (const [change, id, fix] of cases) {
  await save(change);
  let refused;
  try { refused = check(); } catch (error) { throw Error(`${id}: ${error.message}`); }
  assert.equal(refused.status, 1, `${id} fails`);
  assert.match(failing(refused.report)[id] ?? '', fix, `${id} names what to fix`);
 }
 await save();
 await mkdir(join(root, 'scripts'), { recursive: true });
 await writeFile(join(root, 'scripts/rer.mjs'), '');
 const vendored = check();
 assert.equal(vendored.status, 1);
 assert.match(failing(vendored.report)['SC-13.package.vendored.scripts/rer.mjs'] ?? '', /--to-package/);
});

test('--to-package refuses a vendored copy with local edits, listing them, and changes nothing', async t => {
 const root = await mkdtemp(join(tmpdir(), 'rer-to-package-'));
 t.after(() => rm(root, { recursive: true, force: true }));
 const exported = spawnSync(process.execPath, [join(base, 'scripts/export-cli.mjs'), root], { encoding: 'utf8' });
 assert.equal(exported.status, 0, exported.stderr);
 const pkg = JSON.stringify({ name: 'seed', scripts: { build: 'node scripts/rer.mjs build' } });
 await writeFile(join(root, 'package.json'), pkg);
 await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify({ version: 2, seedContract: { version: 1, profile: 'first-party', adapter: 'adapter.mjs' }, commands: {} }));
 await writeFile(join(root, 'scripts/base-cli/cli/errors.mjs'), '// a local edit\n', { flag: 'a' });
 await writeFile(join(root, 'scripts/base-onboarding/local-helper.mjs'), 'export const added = true;\n');
 const refused = spawnSync(process.execPath, [join(base, 'scripts/export-cli.mjs'), '--to-package', root, '--version', '9.9.9'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME } });
 assert.equal(refused.status, 1, refused.stdout + refused.stderr);
 assert.match(refused.stderr, /edited\s+scripts\/base-cli\/cli\/errors\.mjs/);
 assert.match(refused.stderr, /added\s+scripts\/base-onboarding\/local-helper\.mjs/);
 assert.match(refused.stderr, /pnpm patch/);
 assert.equal(await readFile(join(root, 'package.json'), 'utf8'), pkg, 'package.json is unchanged');
 for (const path of ['scripts/rer.mjs', 'scripts/base-cli/inventory.json', 'scripts/base-onboarding/adapter.mjs']) await access(join(root, path));
});

test('--to-package moves delivery operations, the scripts they run and CI workflows to the pinned rer', async t => {
 const directory = await mkdtemp(join(tmpdir(), 'rer-to-package-calls-')), root = join(directory, 'seed'), stub = join(directory, 'bin'), log = join(directory, 'pnpm.log');
 const registry = await localRegistry();
 t.after(async () => { await registry.close(); await rm(directory, { recursive: true, force: true }); });
 const { version } = JSON.parse(readPackage(bytes, { integrity: integrity(bytes) }).find(file => file.path === 'package.json').data);
 registry.publish(version, bytes);
 await writeFile(join(directory, 'npmrc'), registry.npmrc());
 const exported = spawnSync(process.execPath, [join(base, 'scripts/export-cli.mjs'), root], { encoding: 'utf8' });
 assert.equal(exported.status, 0, exported.stderr);
 const project = { schema: 1, operations: { setup: 'bash scripts/delivery/setup-build.sh', build: 'export PATH="$PWD/.rer-tools/node_modules/.bin:$PATH" && node scripts/rer.mjs build', recovery: 'Keep the deployment receipt.' }, verification: { sensitivePaths: ['app.mjs','scripts/base-cli/**','scripts/base-onboarding/**','scripts/rer.mjs','scripts/base-client/**'] } };
 const publicDocs = {
  'RUN-LOCALLY.md': await readFile(join(base, 'export/RUN-LOCALLY.md'), 'utf8'),
  'SEED-COMMAND-CONTRACT.md': await readFile(join(base, 'export/SEED-COMMAND-CONTRACT.md'), 'utf8'),
  'HOMEPAGE-VARIANTS.md': await readFile(join(base, 'export/HOMEPAGE-VARIANTS.md'), 'utf8'),
  'AGENTS.md': await readFile(join(base, 'export/AGENTS.md'), 'utf8'),
  'src/base/hydration/README.md': await readFile(join(base, 'foundation/runtime/hydration/README.md'), 'utf8'),
  'README.md': await readFile(join(base, 'default-seed/README.md'), 'utf8'),
  'OPERATIONS.md': await readFile(join(base, 'default-seed/OPERATIONS.md'), 'utf8'),
  'src/modules/erasure/README.md': await readFile(join(base, 'modules/erasure/README.md'), 'utf8'),
 };
 const seed = {
  ...publicDocs,
  'package.json': JSON.stringify({ name: 'seed', private: true, packageManager: `pnpm@${pins.pnpm}`, scripts: { build: 'node scripts/rer.mjs build', 'test:contract': 'node scripts/rer.mjs --help && node scripts/check-cli-copy.mjs && node scripts/check-onboarding.mjs' } }),
  'OPERATIONS.json': JSON.stringify({ version: 2, seedContract: { version: 1, profile: 'first-party', adapter: 'adapter.mjs' }, commands: {} }),
  'rer-project.json': JSON.stringify(project, null, 2) + '\n',
  'scripts/delivery/base/packaging.json': JSON.stringify({ schema: 1, project }, null, 2) + '\n',
  'scripts/delivery/setup-build.sh': '#!/usr/bin/env bash\nset -euo pipefail\ncd "$(dirname "$0")/../.."\nnode scripts/rer.mjs install\n',
  'edition.json': JSON.stringify({ components: [
   { id: 'example/runtime', source: { kind: 'local', paths: ['app.mjs', 'scripts/base-cli/cli/adapter.mjs'], mappings: [{path:'scripts/base-cli/cli/adapter.mjs',originPath:'cli/adapter.mjs'}] } },
   { id: 'example/tooling', source: { kind: 'local', paths: ['scripts/rer.mjs', 'scripts/base-onboarding'] } },
  ] }),
  'app.mjs': 'export const app = true;\n',
  '.github/workflows/verify.yml': ['jobs:', '  verify:', '    steps:', '      - run: node scripts/rer.mjs install', '      - run: node scripts/rer.mjs verify', '  prepare:', '    steps:', '      - run: |', '          env -i PATH="$PATH" \\', '            CI=true node scripts/rer.mjs install', '          node scripts/base-cli/cli/hosted-output.mjs .', ''].join('\n'),
 };
 for (const [path, text] of Object.entries(seed)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text); }
 await writeFile(join(root,'scripts/check-cli-copy.mjs'), "import{readFile}from 'node:fs/promises';await readFile('scripts/base-cli/inventory.json');");
 await writeFile(join(root,'scripts/check-onboarding.mjs'), "import{cp}from 'node:fs/promises';await cp('scripts/base-cli','.cache/onboarding-suite',{recursive:true});");

 // Not spawnSync: this process serves the registry while the conversion runs.
 const converted = await run(process.execPath, [join(base, 'scripts/export-cli.mjs'), '--to-package', root], { env: { PATH: process.env.PATH, HOME: process.env.HOME, NPM_CONFIG_USERCONFIG: join(directory, 'npmrc'), npm_config_cache: join(directory, 'npm-cache') } });
 assert.equal(converted.code, 0, converted.stdout + converted.stderr);
 // Execute the converted contract alias against the installed built pin.
 // It must not read the old inventory or copy the removed tooling tree.
 const installed = join(root,'node_modules/@runeditrun/rer');
 await mkdir(dirname(installed),{recursive:true});
 await writePackage(readPackage(bytes,{integrity:integrity(bytes)}),installed);
 await mkdir(join(root,'node_modules/.bin'),{recursive:true});
 await writeFile(join(root,'node_modules/.bin/rer'), `#!/bin/sh\nexec '${process.execPath}' '${installed}/global/rer.mjs' "$@"\n`, {mode:0o755});
 const contract = await run('pnpm',['test:contract'], {cwd:root,env:{...process.env,RER_NO_UPDATE_CHECK:'1'}});
 assert.equal(contract.code,0,contract.stdout+contract.stderr);
 const read = async path => readFile(join(root, path), 'utf8');
 for (const path of Object.keys(seed).filter(path => path !== 'OPERATIONS.json')) assert.doesNotMatch(await read(path), /scripts\/(?:rer\.mjs|base-cli\/|base-onboarding\/)/, `${path} no longer calls the removed copy`);
 const packageDocs = Object.keys(publicDocs);
 for (const path of packageDocs) assert.doesNotMatch(await read(path), /node scripts\/(?:rer\.mjs|export-cli\.mjs)|scripts\/(?:rer\.mjs|base-cli|base-onboarding)|rer queue status|global\/rer\.mjs/, `${path} gives package-mode instructions only`);
 assert.doesNotMatch(await read('README.md'), /From the runnable project\s+Package mode/, 'a rewritten sentence that wraps across lines is replaced whole');
 const selected = JSON.parse(await read('edition.json')).components;
 assert.ok(selected.some(component => component.source.paths.includes('app.mjs')), 'conversion retains selected app source');
 for (const component of selected) for (const path of component.source.paths) await access(join(root,path));
 const operations = JSON.parse(await read('rer-project.json')).operations;
 assert.deepEqual(JSON.parse(await read('scripts/delivery/base/packaging.json')).project.operations, operations, 'the delivery producer still generates the committed rer-project.json');
 const verification = JSON.parse(await read('rer-project.json')).verification;
 assert.deepEqual(JSON.parse(await read('scripts/delivery/base/packaging.json')).project.verification, verification);
 assert.ok(verification.sensitivePaths.includes('app.mjs') && verification.sensitivePaths.includes('scripts/base-client/**'), 'retained runtime and neighbouring folder coverage survive conversion');
 assert.ok(!verification.sensitivePaths.some(path => path.startsWith('scripts/base-cli/') || path.startsWith('scripts/base-onboarding/') || path === 'scripts/rer.mjs'), 'removed trees leave no dead coverage');
 assert.equal(operations.recovery, project.operations.recovery);
 assert.match(operations.build, /&& pnpm exec rer build$/, 'build runs after setup installed, with no install of its own');
 const workflow = (await read('.github/workflows/verify.yml')).split('\n');
 assert.equal(workflow[4], '      - run: pnpm exec rer verify');

 // Where nothing has installed yet, the frozen install runs first, under the
 // same prefix as the call: a pnpm stub records each run and its CI value.
 await mkdir(stub);
 await writeFile(join(stub, 'pnpm'), `#!/bin/sh\necho "CI=$CI $*" >> '${log}'\n`, { mode: 0o755 });
 const shell = text => {
  const result = spawnSync('bash', ['-c', text], { cwd: root, encoding: 'utf8', env: { PATH: `${stub}:${process.env.PATH}`, HOME: process.env.HOME } });
  assert.equal(result.status, 0, result.stderr);
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
  rmSync(log, { force: true });
  return calls;
 };
 assert.deepEqual(shell(operations.setup), ['CI= install --frozen-lockfile', 'CI= exec rer install']);
 assert.deepEqual(shell(workflow[3].replace('      - run: ', '')), ['CI= install --frozen-lockfile', 'CI= exec rer install']);
 const prefixed = workflow.findIndex(line => line.includes('env -i'));
 assert.deepEqual(shell(workflow.slice(prefixed, prefixed + 2).join('\n')), ['CI=true install --frozen-lockfile', 'CI=true exec rer install']);
 assert.match(workflow[prefixed + 2], /node node_modules\/@runeditrun\/rer\/cli\/hosted-output\.mjs \.$/);
});

test('a freshly composed foundation converted with --to-package passes check, its lock no longer recording the removed copy', async t => {
 const directory = await mkdtemp(join(tmpdir(), 'rer-to-package-composed-')), root = join(directory, 'seed'), snapshot = join(directory, 'base'), family = join(directory, 'family');
 const registry = await localRegistry();
 t.after(async () => { await registry.close(); await rm(directory, { recursive: true, force: true }); });
 const { version } = JSON.parse(readPackage(bytes, { integrity: integrity(bytes) }).find(file => file.path === 'package.json').data);
 registry.publish(version, bytes);
 await writeFile(join(directory, 'npmrc'), registry.npmrc());
 const git = (cwd, ...args) => spawnSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { encoding: 'utf8' });
 await mkdir(snapshot);
 for (const path of [...new Set([...sourceRoots, 'modules/operator-auth', 'foundation', 'composition', 'onboarding', 'export', 'LICENSE'])]) await cp(join(base, path), join(snapshot, path), { recursive: true, filter: path => !path.includes('node_modules') && !path.includes('__pycache__') });
 for (const args of [['init', '--quiet'], ['add', '.'], ['commit', '-qm', 'source']]) assert.equal(git(snapshot, ...args).status, 0);
 const ref = git(snapshot, 'rev-parse', 'HEAD').stdout.trim();
 await initialize({ baseRepo: snapshot, ref, output: family, family: 'journey', edition: 'foundation', repository: 'just-every/run-happytohelp' });
 for (const args of [['init', '--quiet'], ['add', '.'], ['commit', '-qm', 'family']]) assert.equal(git(family, ...args).status, 0);
 await assemble({ familyRepo: family, baseRepo: snapshot, edition: 'foundation', output: root, toolCommit: ref });
 const lockPath = join(root, 'composition.lock.json');
 assert.ok(Object.keys(JSON.parse(await readFile(lockPath, 'utf8')).files).some(path => path.startsWith('scripts/base-cli/')), 'the composed lock records the vendored copy');

 const converted = await run(process.execPath, [join(base, 'scripts/export-cli.mjs'), '--to-package', root], { env: { PATH: process.env.PATH, HOME: process.env.HOME, NPM_CONFIG_USERCONFIG: join(directory, 'npmrc'), npm_config_cache: join(directory, 'npm-cache') } });
 assert.equal(converted.code, 0, converted.stdout + converted.stderr);
 await mkdir(join(root, 'node_modules/@runeditrun'), { recursive: true });
 await writePackage(readPackage(bytes, { integrity: integrity(bytes) }), join(root, 'node_modules/@runeditrun/rer'));
 const checked = spawnSync(process.execPath, [join(base, 'global/rer.mjs'), 'check', '--profile', 'first-party', '--json'], { cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME, RER_NO_UPDATE_CHECK: '1' }, encoding: 'utf8', timeout: 120000 });
 const report = JSON.parse(checked.stdout.trim().split('\n').at(-1));
 assert.deepEqual(report.clauses.filter(clause => !clause.ok).map(clause => clause.id), [], checked.stderr);
 assert.equal(checked.status, 0);
});

test('converted journey and README launches bootstrap a fresh seed through their own installed rer', {timeout: 240000}, async t => {
 const directory = await mkdtemp(join(tmpdir(), 'rer-converted-journey-'));
 const root = join(directory, 'seed'), fresh = join(directory, 'fresh');
 const registry = await localRegistry();
 let dev, done;
 t.after(async () => {
  if (dev && dev.exitCode === null && dev.signalCode === null) { dev.kill('SIGTERM'); await done; }
  await registry.close(); await rm(directory, {recursive: true, force: true});
 });
 const files = readPackage(bytes, {integrity: integrity(bytes)});
 const {version} = JSON.parse(files.find(file => file.path === 'package.json').data);
 registry.publish(version, bytes);
 const npmrc = join(directory, 'npmrc'); await writeFile(npmrc, registry.npmrc());
 const env = {PATH: process.env.PATH, HOME: process.env.HOME, CI: 'true', NPM_CONFIG_USERCONFIG: npmrc, RER_NO_UPDATE_CHECK: '1', WRANGLER_SEND_METRICS: 'false', RER_SERVERS_DIR: join(directory, 'servers'), RER_SERVER_JOURNEY: '1'};
 await exportReference(base, root);
 const driver = 'tests/package-launch.mjs';
 await writeFile(join(root, driver), `import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';import {writeFileSync} from 'node:fs';
const root=process.argv[2];
if(process.argv[4]==='dev') {
 const args=['run','dev','--','--port',process.argv[5],'--json'];
 const child=spawn('nice',['-n','15','pnpm',...args],{cwd:root,stdio:'inherit'});
 process.on('SIGTERM',()=>child.kill('SIGTERM'));process.on('SIGINT',()=>child.kill('SIGINT'));
 child.on('close',code=>process.exitCode=code);
} else {
const rer=fileURLToPath(new URL('../scripts/rer.mjs',import.meta.url));
const shell=\`#!/bin/sh\\nexec node "\${root}/scripts/rer.mjs" "$@"\\n\`;
writeFileSync(process.argv[3],shell,{mode:0o700});
const result=spawnSync(process.execPath,[rer,'describe','--json'],{cwd:root,encoding:'utf8'});
process.stdout.write(result.stdout);process.stderr.write(result.stderr);process.exitCode=result.status;
}
`);
 const converted = await run(process.execPath, [join(base, 'scripts/export-cli.mjs'), '--to-package', root], {env});
 assert.equal(converted.code, 0, converted.stderr);
 await cp(root, fresh, {recursive: true});
 // The runner has its own installed rer, but its new scratch checkout does
 // not. The network edge serves the real built package and normal dependencies.
 await mkdir(join(root, 'node_modules/@runeditrun'), {recursive: true});
 await writePackage(files, join(root, 'node_modules/@runeditrun/rer'));
 const shim = join(directory, 'rer');
 const launched = await run(process.execPath, [join(root, driver), fresh, shim], {env, timeout: 150000});
 assert.equal(launched.code, 0, launched.stderr);
 assert.equal(JSON.parse(launched.stdout.trim().split('\n').at(-1)).profile, 'first-party');
 const readme = await run(shim, ['describe', '--json'], {cwd: fresh, env});
 assert.equal(readme.code, 0, readme.stderr);
 assert.equal(JSON.parse(readme.stdout).profile, 'first-party');
 const help = await run(shim, ['dev', '--help'], {cwd: fresh, env});
 assert.equal(help.code, 0, 'the shim preserves the launcher help path');
 const port = await freePort();
 const setup = await run(shim, ['setup', '--owner-email', 'journey-owner@example.test', '--port', String(port), '--non-interactive', '--json'], {cwd: fresh, env, timeout: 120000});
 assert.equal(setup.code, 0, 'the converted fresh seed completes real setup');
 dev = spawn(process.execPath, [join(root, driver), fresh, shim, 'dev', String(port)], {cwd: fresh, env, stdio: ['ignore', 'pipe', 'pipe']});
 let output = ''; dev.stdout.on('data', data => { output += data; }); dev.stderr.resume();
 done = new Promise((resolve, reject) => { dev.once('error', reject); dev.once('close', resolve); });
 const deadline = Date.now() + 120000;
 while (!output.includes('"event":"ready"') && dev.exitCode === null && Date.now() < deadline) await pause(100);
 assert.ok(output.includes('"event":"ready"'), 'the converted pnpm README launch reaches app readiness');
 const info = output.split('\n').filter(line => line.startsWith('{')).map(JSON.parse).find(event => event.event === 'ready');
 assert.equal(typeof info.siteUrl, 'string', 'ordinary owner prose does not block the default owner label');
 assert.equal((await fetch(info.siteUrl + '/run')).status, 200);
 assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
 assert.equal(dev.exitCode, null, 'the shim keeps dev in the foreground under test-runner pipes');
 const stop = await run(shim, ['dev', '--stop', '--json'], {cwd: fresh, env});
 assert.equal(stop.code, 0);
 assert.equal(await done, 0);
});
