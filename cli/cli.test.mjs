import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, cp, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { exportCLI, inventory } from './export.mjs';
import { parse, help } from './parse.mjs';
import { authoringVerbs, verbs, commonFlags } from './contract.mjs';
import { isolatedQueue } from './fixtures/queue.mjs';
const base = resolve(import.meta.dirname, '..'), cli = join(base, 'bin/rer.mjs');
const environment = () => ({ PATH: process.env.PATH, HOME: process.env.HOME, TZ: 'UTC' });
const run = (root, args, entry = cli, env = environment()) => spawnSync(process.execPath, [entry, ...args], { cwd: root, encoding: 'utf8', env, timeout: 20000 });
async function project(t) {
 const root = await mkdtemp(join(tmpdir(), 'rer-independent-'));
 t.after(() => rm(root, { recursive: true, force: true }));
 const env = await isolatedQueue(t, environment());
 await writeFile(join(root, 'task.mjs'), "process.stdout.write(JSON.stringify(process.argv.slice(2))+'\\n');process.exit(Number(process.env.PROJECT_TEST_EXIT??0));\n");
 const descriptor = { version: 2, project: 'example/project', runtime: { requirements: [{ name: 'node', version: 'project-owned' }] }, requiredEnvironment: [], commands: { verify: { argv: ['node', 'task.mjs'], inputs: ['task.mjs'], effects: 'Runs the independent project check.' } } };
 await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify(descriptor));
 return { root, env, descriptor, run: (args, entry) => run(root, args, entry, env), async save() { await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify(descriptor)); } };
}
const events = result => result.stdout.trim().split('\n').map(line => JSON.parse(line));

test('every command help is effect-free outside a checkout, before adapters and tools', async t => {
 const root = await mkdtemp(join(tmpdir(), 'rer-help-')); t.after(() => rm(root, { recursive: true, force: true }));
 for (const verb of [...Object.keys({ ...verbs, ...authoringVerbs }), 'demo', 'signin']) {
  const json = run(root, [verb, '--help', '--json']); assert.equal(json.status, 0); assert.equal(events(json).at(-1).event, 'result');
 }
 // The complete public command tree, through the checkout dispatcher and the installed rer.
 const checkout = [...Object.keys({ ...verbs, ...authoringVerbs }), 'demo', 'signin', 'release', 'release sign', 'release receipt', 'release keygen', 'listing', 'archive', 'archive diff', 'business', 'companion'];
 const installed = [...checkout, 'update', 'list', 'cli', 'cli status', 'cli install', 'cli uninstall', 'queue', 'queue NAME', 'door', 'door enable', 'run'];
 for (const [entry, commands] of [[cli, checkout], [join(base, 'global/rer.mjs'), installed]]) for (const command of commands) {
  const result = run(root, [...command.split(' '), '--help'], entry, { ...environment(), RER_NO_UPDATE_CHECK: '1' });
  assert.equal(result.status, 0, `${entry} ${command}: ${result.stdout}${result.stderr}`);
  assert.ok(result.stdout.includes(`rer ${command.split(' ')[0]}`), `${command} --help prints its own usage: ${result.stdout}`);
 }
 // A demo advertises exactly the flags it accepts.
 const advertised = /^Flags: (.*)$/m.exec(run(root, ['demo', '--help']).stdout)[1].split(', ');
 const value = { '--cwd': '.', '--port': '4000', '--host': '127.0.0.1', '--idle-timeout': '60' };
 for (const flag of advertised) assert.doesNotThrow(() => parse(['demo', flag, ...(value[flag] ? [value[flag]] : [])]), flag);
 for (const flag of verbs.dev.flags.filter(flag => flag !== '--demo' && !advertised.includes(flag))) assert.throws(() => parse(['demo', flag, '1']), error => error.exitCode === 2 && error.message.includes('rer demo --help'), flag);
 // rer dev --demo takes what rer demo takes.
 for (const argv of [['--login'], ['--platform', 'container'], ['--as', 'owner']]) assert.throws(() => parse(['dev', '--demo', ...argv]), error => error.exitCode === 2 && error.message.includes('rer demo --help'), argv[0]);
 for (const argv of [['dev','--foreground','--help'], ['preview','--detach','--help']]) assert.equal(run(root,argv).status,0);
 assert.deepEqual(await readdir(root), []);
 await writeFile(join(root,'OPERATIONS.json'),'{invalid configuration');
 for(const verb of Object.keys({...verbs, ...authoringVerbs}))assert.equal(run(root,[verb,'--','--help','--json']).status,0,'package-forwarded help precedes configuration validation');
 assert.deepEqual(await readdir(root),['OPERATIONS.json']);
});

test('parsing rejects every unsupported flag, missing value, invalid host/port and duplicate before effects', () => {
 for (const verb of Object.keys({ ...verbs, ...authoringVerbs })) assert.throws(() => parse([verb, '--unknown']), error => error.exitCode === 2);
 // A refusal names the verb's help, and a flag only for a near miss: one that verb's help lists.
 const named = argv => {
  try { parse(argv); } catch (error) {
   assert.ok(error.message.includes(`rer ${argv[0]} --help`), error.message);
   const flags = (error.message.match(/--[\w-]+/g) ?? []).filter(flag => flag !== argv[1] && flag !== '--help');
   assert.ok(flags.every(flag => /^Flags: (.*)$/m.exec(help(argv[0]))[1].split(', ').includes(flag)), error.message);
   return flags;
  }
  assert.fail(`${argv.join(' ')} was accepted`);
 };
 for (const [argv, meant] of [[['dev', '--prot'], '--port'], [['check', '--jsn'], '--json'], [['deploy', '--dryrun'], '--dry-run'], [['setup', '--email'], '--owner-email'], [['dev', '--timeout', '60'], '--idle-timeout'], [['import', '--legacy'], '--legacy-v1'], [['dev', '--port=3000'], '--port']]) assert.deepEqual(named(argv), [meant], argv.join(' '));
 for (const argv of [['check', '--frobnicate'], ['export', '--xyz'], ['install', '--verbose'], ['deploy', '--port'], ['check', 'positional'], ['dev', '3000'], ['import', '--file'], ['install', '--queue'], ['dev', '--log'], ['deploy', '--remote'], ['deploy', '--name'], ['demo', '--dmeo']]) assert.deepEqual(named(argv), [], argv.join(' '));
 for (const argv of [['dev', '--port'], ['dev', '--port', '0'], ['dev', '--port', '65536'], ['dev', '--port', '1.5'], ['setup', '--owner-email', 'owner name <a@b.test>'], ['check', '--profile', 'independent'], ['dev', '--json', '--json']]) assert.throws(() => parse(argv), error => error.exitCode === 2);
 for (const host of ['0.0.0.0', '::', 'example.test', '[::1]']) assert.throws(() => parse(['dev', '--host', host]), error => error.exitCode === 4);
 assert.equal(parse(['dev', '--', '--port', '08787']).port, 8787);
 assert.equal(parse(['dev', '--host', '::1']).host, '::1');
});

test('a missing or mistyped project folder reports its status, folder and --cwd', async t => {
 const root = await mkdtemp(join(tmpdir(), 'rer-cwd-')); t.after(() => rm(root, { recursive: true, force: true }));
 await writeFile(join(root, 'notes.txt'), '');
 for (const [args, status] of [[['check', '--cwd', 'absent-folder'], 3], [['dev', '--cwd', 'absent-folder', '--json'], 3], [['check', '--cwd', 'notes.txt'], 2]]) {
  const result = run(root, args);
  assert.equal(result.status, status, result.stdout + result.stderr);
  const message = args.includes('--json') ? events(result).find(row => row.event === 'error').message : result.stderr;
  assert.ok(message.includes(args[2]) && message.includes('--cwd'), message);
 }
});

test('independent execution needs no package, edition, pnpm, installer or Base runtime and preserves raw argv', async t => {
 const p = await project(t);
 const args = ['two words', '; touch injected', '$(printf injected)', '--unknown-option', '--json'];
 const result = p.run(['verify', '--json', '--', ...args]);
 assert.equal(result.status, 0, result.stderr);
 const output = events(result); assert.equal(output.length, 1); assert.equal(output[0].event, 'result');
 assert.deepEqual(output[0], { version: 1, verb: 'verify', event: 'result', ok: true, exitCode: 0, childExitCode: 0, signal: null });
 assert.deepEqual(JSON.parse(result.stderr.split('\n').find(line => line.startsWith('['))), args);
 assert.deepEqual((await readdir(p.root)).sort(), ['OPERATIONS.json', 'task.mjs']);
});

test('independent missing command, file, outside input and disabled required loop fail visibly', async t => {
 const p = await project(t);
 assert.equal(p.run(['build', '--json']).status, 4);
 p.descriptor.commands.verify.inputs = ['absent.mjs']; await p.save();
 assert.equal(p.run(['verify', '--json']).status, 3);
 assert.equal(p.run(['check', '--json']).status, 1);
 p.descriptor.commands.verify.inputs = ['../outside.mjs']; await p.save(); assert.equal(p.run(['verify', '--json']).status, 2);
 p.descriptor.commands.verify.inputs = ['task.mjs']; p.descriptor.loops = [{ id: 'required-worker', type: 'worker', required: true, enabled: false }]; await p.save(); assert.equal(p.run(['verify', '--json']).status, 3);
});

test('independent commands preserve numeric child failure and signal exits, emitting one final result', async t => {
 const p = await project(t);
 for (const [source, exitCode, childExitCode, signal] of [["process.exit(17)", 17, 17, null], ["process.kill(process.pid,'SIGTERM')", 143, null, 'SIGTERM']]) {
  await writeFile(join(p.root, 'task.mjs'), source);
  const result = p.run(['verify', '--json']); assert.equal(result.status, exitCode);
  const output = events(result); assert.equal(output.length, 2); assert.equal(output[0].event, 'error');
  assert.deepEqual(output[1], { version: 1, verb: 'verify', event: 'result', ok: false, exitCode, childExitCode, signal });
 }
});

test('independent raw tail never validates project-owned port, host or help flags',async t=>{
 const p=await project(t);p.descriptor.commands.dev=p.descriptor.commands.verify;await p.save();
 const args=['--port','project-owned','--host','0.0.0.0','--help','two words'];
 const result=p.run(['dev','--json','--',...args]);assert.equal(result.status,0,result.stderr);
 assert.deepEqual(JSON.parse(result.stderr.split('\n').find(line=>line.startsWith('['))),args);
 assert.equal(events(result).length,1);assert.equal(events(result)[0].event,'result');
 assert.equal(p.run(['dev','--host','0.0.0.0','--json']).status,2,'only common flags belong to the independent wrapper');
});

test('explicit profile enforcement cannot be bypassed by deleting the marker', async t => {
 const p = await project(t);
 const result = p.run(['check', '--profile', 'first-party', '--json']);
 assert.equal(result.status, 1); const report = events(result).at(-1);
 assert.ok(report.clauses.some(c => c.id === 'SC-09.profile' && !c.ok));
 for (const key of ['node-file', 'node-engine', 'pnpm']) assert.ok(report.clauses.some(c => c.id === 'SC-02.' + key && !c.ok));
});

test('check holds each operator-auth copy runtime group to its pin while preserving historical migrations', async t => {
 const p = await project(t);
 const sources = (await inventory(base, ['modules/operator-auth'])).filter(path => !path.endsWith('.md'));
 const group = async (directory, revision) => {
  const copy = { path: directory, originPath: 'modules/operator-auth', revision, files: {} };
  for (const path of sources) {
   const local = directory + path.slice('modules/operator-auth'.length);
   await mkdir(join(p.root, local, '..'), { recursive: true }); await cp(join(base, path), join(p.root, local));
   copy.files[local] = createHash('sha256').update(await readFile(join(base, path))).digest('hex');
  }
  return copy;
 };
 const app = await group('vendor/base/operator-auth', 'a'.repeat(40)), cliGroup = await group('scripts/base-cli/modules/operator-auth', 'c'.repeat(40));
 const record = (...copies) => writeFile(join(p.root, 'base-copies.json'), JSON.stringify({ schemaVersion: 1, copies }));
 await record(app, cliGroup);
 const auth = () => events(p.run(['check', '--profile', 'first-party', '--json'])).at(-1).clauses.filter(c => c.id.startsWith('SC-05.auth-copy.'));
 const failing = () => auth().filter(c => !c.ok).map(c => [c.id.slice('SC-05.auth-copy.'.length), c.message.split(' ').slice(1, 3).join(' ')]).sort();
 const clean = auth();
 assert.ok(clean.every(c => c.ok), 'an older application revision and a newer CLI revision each match their own pin');
 for (const copy of [app, cliGroup]) for (const path of Object.keys(copy.files)) assert.ok(clean.some(c => c.id === `SC-05.auth-copy.${path}`), path);
 assert.ok(clean.some(c => c.id === 'SC-05.auth-copy.pin') && clean.some(c => c.id === 'SC-05.auth-copy.cli-pin'));
 await writeFile(join(p.root, 'vendor/base/operator-auth/identity/admission.mjs'), '// changed\n', { flag: 'a' });
 await rm(join(p.root, 'vendor/base/operator-auth/accounts/roles.mjs'));
 await writeFile(join(p.root, 'vendor/base/operator-auth/accounts/extra.mjs'), 'export {};\n');
 assert.deepEqual(failing(), [['vendor/base/operator-auth/accounts/extra.mjs', 'is not'], ['vendor/base/operator-auth/accounts/roles.mjs', 'is missing;'], ['vendor/base/operator-auth/identity/admission.mjs', 'differs from']]);
 await writeFile(join(p.root, 'scripts/base-cli/modules/operator-auth/identity/admission.mjs'), '// changed\n', { flag: 'a' });
 await writeFile(join(p.root, 'scripts/base-cli/modules/operator-auth/accounts/extra.mjs'), 'export {};\n');
 assert.ok(failing().some(([id, kind]) => id === 'scripts/base-cli/modules/operator-auth/identity/admission.mjs' && kind === 'differs from'));
 assert.ok(failing().some(([id, kind]) => id === 'scripts/base-cli/modules/operator-auth/accounts/extra.mjs' && kind === 'is not'));
 await rm(join(p.root, app.path), { recursive: true }); await rm(join(p.root, cliGroup.path), { recursive: true });
 await group(app.path, app.revision); await group(cliGroup.path, cliGroup.revision);
 const sqlSource = 'modules/operator-auth/accounts/schema/operator-auth.sql';
 const copiedFile = async (path, revision, originPath = sqlSource) => {
  await mkdir(join(p.root, path, '..'), { recursive: true }); await cp(join(base, sqlSource), join(p.root, path));
  return { path, originPath, revision, files: { [path]: createHash('sha256').update(await readFile(join(p.root, path))).digest('hex') } };
 };
 const migration = await copiedFile('migrations/core/0001_owner.sql', 'b'.repeat(40));
 const laterMigration = await copiedFile('migrations/core/0002_owner.sql', 'd'.repeat(40));
 await record(app, cliGroup, migration, laterMigration);
 assert.ok(auth().every(c => c.ok), 'each historical migration keeps its own revision alongside newer runtime and independently pinned CLI copies');
 const refreshedRuntime = `${app.path}/identity/admission.mjs`;
 await writeFile(join(p.root, refreshedRuntime), '// refreshed runtime\n', { flag: 'a' });
 app.files[refreshedRuntime] = createHash('sha256').update(await readFile(join(p.root, refreshedRuntime))).digest('hex');
 app.revision = 'e'.repeat(40); await record(app, cliGroup, migration, laterMigration);
 assert.ok(auth().every(c => c.ok), 'refreshing the runtime pin leaves historical migration pins and bytes intact');
 for (const copy of [migration, laterMigration]) {
  copy.revision = 'invalid'; await record(app, cliGroup, migration, laterMigration);
  assert.ok(auth().some(c => !c.ok && c.id.includes(copy.path)), 'every migration needs a valid revision');
  copy.revision = 'b'.repeat(40);
  await writeFile(join(p.root, copy.path), '-- drift\n', { flag: 'a' }); await record(app, cliGroup, migration, laterMigration);
  assert.ok(failing().some(([id, kind]) => id === copy.path && kind === 'differs from'));
  await rm(join(p.root, copy.path));
  assert.ok(failing().some(([id, kind]) => id === copy.path && kind === 'is missing;'));
  await cp(join(base, sqlSource), join(p.root, copy.path));
 }
 const runtimeSchema = await copiedFile('vendor/schema.sql', migration.revision);
 await record(app, cliGroup, migration, runtimeSchema);
 assert.equal(auth().find(c => c.id === 'SC-05.auth-copy.pin').ok, false, 'ordinary SQL remains coupled to the runtime revision');
 const cliSchema = await copiedFile('scripts/base-cli/migrations/0001_owner.sql', migration.revision);
 await record(app, cliGroup, migration, cliSchema);
 assert.equal(auth().find(c => c.id === 'SC-05.auth-copy.cli-pin').ok, false, 'numbered SQL in bundled tooling remains coupled to the CLI revision');
 await rm(join(p.root, cliSchema.path));
 const directory = { path: 'migrations/core', originPath: 'modules/operator-auth/accounts/schema', revision: migration.revision, files: { ...migration.files, ...laterMigration.files } };
 await record(app, cliGroup, directory);
 assert.ok(auth().every(c => c.ok), 'numbered migrations inside a directory record also retain their historical pin');
 directory.files[migration.path] = null; await record(app, cliGroup, directory);
 assert.ok(auth().some(c => !c.ok && c.id.includes(migration.path)), 'a migration cannot omit its content digest');
 directory.files[migration.path] = migration.files[migration.path];
 await writeFile(join(p.root, 'migrations/core/0003_unrecorded.sql'), '-- unrecorded\n');
 assert.ok(auth().some(c => !c.ok && c.id.endsWith('0003_unrecorded.sql')), 'directory records name unrecorded migration files');
 await rm(join(p.root, 'migrations/core/0003_unrecorded.sql'));
 await record(app, cliGroup, { ...migration, files: {} });
 assert.ok(auth().some(c => !c.ok && c.id.includes(migration.path)), 'an empty migration record cannot bypass byte verification');
 for (const name of ['composition.lock.json', 'foundation.lock.json']) {
  const lock = { ...(name === 'composition.lock.json' ? { repositories: { base: { commit: migration.revision } } } : { base: { commit: migration.revision } }), files: { [migration.path]: { source: sqlSource, sha256: migration.files[migration.path] } } };
  const saveLock = () => writeFile(join(p.root, name), JSON.stringify(lock));
  await record(app, cliGroup); await saveLock();
  assert.ok(auth().every(c => c.ok), `${name} retains an older migration independently of current runtime`);
  delete lock.files[migration.path].sha256; await saveLock();
  assert.ok(auth().some(c => !c.ok && c.id.includes(migration.path)), `${name} must not silently discard a missing digest`);
  lock.files[migration.path].sha256 = migration.files[migration.path];
  lock.files[runtimeSchema.path] = { source: sqlSource, sha256: runtimeSchema.files[runtimeSchema.path] }; await saveLock();
  assert.equal(auth().find(c => c.id === 'SC-05.auth-copy.pin').ok, false, `${name} still detects mixed runtime pins`);
  const nested = await copiedFile(`${app.path}/migrations/0001_owner.sql`, app.revision);
  lock.files = Object.fromEntries(Object.entries({ ...app.files, ...nested.files }).map(([path, sha256]) => [path, { source: 'modules/operator-auth' + path.slice(app.path.length), sha256 }]));
  (lock.repositories?.base ?? lock.base).commit = app.revision;
  await record(cliGroup, migration); await saveLock();
  assert.ok(auth().every(c => c.ok), `${name} checks runtime and numbered SQL files within the same copied directory`);
  (lock.repositories?.base ?? lock.base).commit = 'invalid'; await saveLock();
  assert.ok(auth().some(c => !c.ok && c.id.includes(nested.path)), `${name} validates each migration's inherited revision`);
  (lock.repositories?.base ?? lock.base).commit = app.revision;
  lock.files[nested.path].sha256 = null; await saveLock(); await rm(join(p.root, nested.path));
  assert.ok(failing().some(([id, kind]) => id === nested.path && kind === 'is missing;'), 'a missing file and missing digest never count as matching bytes');
  await rm(join(p.root, name));
 }
});

test('portable CLI source inventory is deterministic and independent execution works outside Base', async t => {
 const p = await project(t); await exportCLI(base, p.root);
 await cp(join(base, 'onboarding'), join(p.root, 'scripts/base-onboarding'), { recursive: true });
 const receipt = JSON.parse(await readFile(join(p.root, 'scripts/base-cli/inventory.json'), 'utf8'));
 assert.deepEqual(Object.keys(receipt.files), await inventory(base));
 assert.equal(receipt.onboarding, '../base-onboarding');
 // The recorded cliVersion names the commit the copy was exported from, which
 // a copy committed with its source can only name as an earlier one.
 const { cliVersion: _committed, ...committed } = JSON.parse(await readFile(join(base, 'default-seed/scripts/base-cli/inventory.json'), 'utf8')), { cliVersion: _exported, ...exported } = receipt;
 assert.deepEqual(committed, exported, "default-seed's CLI copy is current: regenerate it with node scripts/export-cli.mjs default-seed");
 assert.equal(p.run(['verify', '--json', '--', 'portable argument'], join(p.root, 'scripts/rer.mjs')).status, 0);
 assert.equal(p.run(['release', '--bad'], join(p.root, 'scripts/rer.mjs')).status, 2);
 assert.ok(!(await readdir(join(p.root, 'scripts/base-cli'))).includes('onboarding'));
});

test('cancellation drains descendant groups before the result and leaves zero owned descendants', async t => {
 const p = await project(t);
 await writeFile(join(p.root, 'task.mjs'), `import {spawn} from 'node:child_process';import{writeFileSync}from'node:fs';const c=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'inherit'});writeFileSync('owned.json',JSON.stringify([process.pid,c.pid]));console.log('STARTED');setInterval(()=>{},1000);`);
 const child = spawn(process.execPath, [cli, 'verify', '--json'], { cwd: p.root, env: p.env, stdio: ['ignore', 'pipe', 'pipe'] });
 const done = new Promise(resolve => child.once('close', code => resolve(code)));
 let stdout = '', stderr = ''; child.stdout.on('data', c => { stdout += c; }); child.stderr.on('data', c => { stderr += c; });
 t.after(async () => { if (child.exitCode === null) child.kill('SIGTERM'); await done; });
 const deadline = Date.now() + 15000;
 while (!stderr.includes('STARTED') && Date.now() < deadline && child.exitCode === null) await new Promise(resolve => setTimeout(resolve, 20));
 assert.match(stderr, /STARTED/); const owned = JSON.parse(await readFile(join(p.root, 'owned.json'), 'utf8'));
 child.kill('SIGINT'); assert.equal(await done, 130);
 const result = events({ stdout }).at(-1); assert.equal(result.exitCode, 130);
 for (const pid of owned) assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
});

test('independent absolute executable preserves literal argv and child status; relative paths stay contained', async t => {
 const p = await project(t);
 p.descriptor.commands.verify.argv[0] = process.execPath; await p.save();
 await writeFile(join(p.root, 'task.mjs'), "console.log(JSON.stringify(process.argv.slice(2)));process.exit(7)");
 const args = ['space and ; $(literal)', 'two words'];
 const result = p.run(['verify', '--json', '--', ...args]);
 assert.equal(result.status, 7); assert.equal(events(result).at(-1).childExitCode, 7);
 assert.deepEqual(JSON.parse(result.stderr.split('\n').find(line => line.startsWith('['))), args);
 p.descriptor.commands.verify.argv[0] = '../outside-program'; await p.save();
 assert.equal(p.run(['verify', '--json']).status, 4);
 p.descriptor.commands.verify.argv[0] = 'bin/linked'; await mkdir(join(p.root, 'bin')); await symlink(process.execPath, join(p.root, 'bin/linked')); await p.save();
 assert.equal(p.run(['verify', '--json']).status, 4);
});

for (const code of [0, 17]) test(`independent leader exit ${code} and closed pipes still drain a quiet owned descendant`, async t => {
 const p = await project(t);
 await writeFile(join(p.root, 'task.mjs'), `import {spawn} from 'node:child_process';import{writeFileSync}from'node:fs';const c=spawn(process.execPath,['-e',"setInterval(()=>{},1000)"],{stdio:'ignore'});writeFileSync('owned.json',JSON.stringify([process.pid,c.pid]));c.unref();process.exit(${code});`);
 let owned = [];
 t.after(() => { for (const pid of owned) { try { process.kill(pid, 'SIGKILL'); } catch {} } });
 const result = p.run(['verify', '--json']);
 owned = JSON.parse(await readFile(join(p.root, 'owned.json'), 'utf8'));
 assert.equal(result.status, code, result.stderr); assert.equal(events(result).at(-1).childExitCode, code);
 for (const pid of owned) assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
 owned = [];
});
