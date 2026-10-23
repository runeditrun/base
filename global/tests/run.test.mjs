// rer run, queue and list through the installed command's door: a project's documented
// `pnpm run X -- ARGS` works as `rer run X -- ARGS` with no pnpm on PATH.
// Only the npm registry is a fixture, serving a pnpm release.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { exportReference } from '../../scripts/export-reference.mjs';
import { run } from './harness.mjs';

const rer = resolve(import.meta.dirname, '../rer.mjs'), execute = promisify(execFile);

test('rer run runs a package script with the pnpm the checkout pins, fetched into rer\'s cache, when PATH has no pnpm', { timeout: 60000 }, async t => {
 const directory = await realpath(await mkdtemp(join(tmpdir(), 'rer-run-'))), home = join(directory, 'home'), bin = join(directory, 'bin'), checkout = join(directory, 'app');
 t.after(() => rm(directory, { recursive: true, force: true }));
 const pin = '10.99.1';
 // The release's pnpm answers --version and runs a script as pnpm run does: its args follow it.
 const release = join(directory, 'release/package');
 await mkdir(join(release, 'bin'), { recursive: true });
 await writeFile(join(release, 'package.json'), JSON.stringify({ name: 'pnpm', version: pin }));
 await writeFile(join(release, 'bin/pnpm.cjs'), `const [verb, ...rest] = process.argv.slice(2), silent = rest[0] === '--silent', [name, ...args] = silent ? rest.slice(1) : rest;
if (verb === '--version') { console.log(${JSON.stringify(pin)}); process.exit(0); }
const script = require(process.cwd() + '/package.json').scripts[name];
if (!silent) console.log('> app@1.0.0 ' + name);
process.exit(require('node:child_process').spawnSync('/bin/sh', ['-c', script + ' "$@"', name, ...args], { stdio: 'inherit' }).status);
`);
 const archive = join(directory, 'pnpm.tgz');
 await execute('tar', ['-czf', archive, '-C', join(directory, 'release'), 'package']);
 const integrity = 'sha512-' + createHash('sha512').update(await readFile(archive)).digest('base64');
 const edge = join(directory, 'edge.mjs');
 await writeFile(edge, `import { readFileSync } from 'node:fs';
globalThis.fetch = async url => new Response(String(url).endsWith('.tgz') ? readFileSync(${JSON.stringify(archive)}) : JSON.stringify({ version: ${JSON.stringify(pin)}, dist: { integrity: ${JSON.stringify(integrity)} } }));
`);

 await Promise.all([mkdir(home), mkdir(bin), mkdir(join(checkout, 'nested'), { recursive: true })]);
 for (const tool of ['tar', 'gzip']) await symlink((await execute('/bin/sh', ['-c', `command -v ${tool}`])).stdout.trim(), join(bin, tool));
 await symlink(process.execPath, join(bin, 'node'));
 await writeFile(join(checkout, 'OPERATIONS.json'), JSON.stringify({ version: 2, project: 'example/run', seedContract: { version: 1, profile: 'first-party', adapter: 'adapter.mjs' } }));
 await writeFile(join(checkout, '.node-version'), process.versions.node + '\n');
 await writeFile(join(checkout, 'package.json'), JSON.stringify({ engines: { node: process.versions.node }, packageManager: `pnpm@${pin}`, scripts: { 'export:data': 'echo "exported to $PWD with"', fails: 'exit 7' } }));
 const env = { HOME: home, PATH: bin, RER_NO_UPDATE_CHECK: '1', NODE_OPTIONS: `--import=${pathToFileURL(edge).href}` };
 assert.notEqual((await run('/bin/sh', ['-c', 'command -v pnpm'], { env })).code, 0, 'no pnpm on PATH');

 const result = await run(process.execPath, [rer, 'run', 'export:data', '--', '--remote', '--out', 'x'], { cwd: join(checkout, 'nested'), env });
 assert.equal(result.code, 0, result.stderr);
 assert.match(result.stdout, new RegExp(`exported to ${checkout.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} with -- --remote --out x`));
 assert.doesNotMatch(result.stdout, /^> /m, 'no pnpm banner naming the package');
 await access(join(home, '.rer/pnpm', `pnpm-${pin}`));

 const outside = await run(process.execPath, [rer, 'run', 'export:data'], { cwd: directory, env });
 assert.equal(outside.code, 2, 'outside a checkout it names where it runs');
 const missingScript = await run(process.execPath, [rer, 'run', 'hosted-backup', '--', '--remote'], { cwd: join(checkout, 'nested'), env });
 assert.equal(missingScript.code, 2, missingScript.stdout + missingScript.stderr);
 assert.equal(missingScript.stderr.trim(), 'No script named hosted-backup in this checkout. Scripts: export:data, fails');
 assert.equal(missingScript.stdout, '');
 assert.equal((await run(process.execPath, [rer, 'run', 'fails'], { cwd: join(checkout, 'nested'), env })).code, 7, 'a script that exists keeps its own exit code');
 // A different pnpm earlier on the caller's PATH must not replace the pin,
 // while tools that the package script runs keep the caller's ordering.
 await writeFile(join(bin, 'pnpm'), '#!/bin/sh\nif [ "$1" = --version ]; then echo 1.0.0; else exit 91; fi\n', { mode: 0o755 });
 await writeFile(join(bin, 'npm'), '#!/bin/sh\necho caller-tool-ran\n', { mode: 0o755 });
 await writeFile(join(checkout, 'package.json'), JSON.stringify({ packageManager: `pnpm@${pin}`, scripts: { check: 'npm' } }));
 const callerPath = await run(process.execPath, [rer, 'run', 'check'], { cwd: checkout, env });
 assert.equal(callerPath.code, 0, callerPath.stderr);
 assert.match(callerPath.stdout, /caller-tool-ran/);

});

test('rer queue runs the command with its literal arguments, keeps its exit status and leaves no admitted job behind', { timeout: 60000 }, async t => {
 const directory = await realpath(await mkdtemp(join(tmpdir(), 'rer-queue-')));
 t.after(() => rm(directory, { recursive: true, force: true }));
 const jobs = join(directory, 'jobs'), env = { HOME: join(directory, 'home'), PATH: process.env.PATH, RER_NO_UPDATE_CHECK: '1', RER_JOBS_DIR: jobs, RER_JOBS_LOAD_THRESHOLD: '100000', RER_JOBS_MIN_FREE_MEMORY_BYTES: '0' };
 const queue = (...args) => run(process.execPath, [rer, 'queue', 'heavy', '--', ...args], { cwd: directory, env });
 const idle = async () => { const { queued, running } = JSON.parse(await readFile(join(jobs, 'state.json'), 'utf8')); return { queued, running }; };

 const echoed = await queue(process.execPath, '-e', 'console.log(JSON.stringify(process.argv.slice(1))); process.exit(5)', 'two words', '$HOME', '--', '--flag');
 assert.equal(echoed.code, 5, 'the command keeps its own exit status');
 assert.deepEqual(JSON.parse(echoed.stdout.trim().split('\n').at(-1)), ['two words', '$HOME', '--', '--flag'], 'arguments arrive literally');
 assert.deepEqual(await idle(), { queued: [], running: [] });

 assert.equal((await queue(process.execPath, '-e', '')).code, 0);
 assert.equal((await queue('/nonexistent/rer-queue-command')).code, 127, 'a command that cannot start fails visibly');
 assert.deepEqual(await idle(), { queued: [], running: [] }, 'neither a success nor a failed start strands an admitted job');

 const usage = await run(process.execPath, [rer, 'queue', 'heavy'], { cwd: directory, env });
 assert.equal(usage.code, 2);
 assert.match(usage.stderr, /Usage: rer queue NAME -- COMMAND/);
});

test('rer list reports each checkout\'s kind and readiness without changing any of them', { timeout: 60000 }, async t => {
 const directory = await realpath(await mkdtemp(join(tmpdir(), 'rer-list-'))), parent = join(directory, 'projects');
 t.after(() => rm(directory, { recursive: true, force: true }));
 const env = { HOME: join(directory, 'home'), PATH: process.env.PATH, RER_NO_UPDATE_CHECK: '1', RER_SERVERS_DIR: join(directory, 'servers') };
 const list = (...args) => run(process.execPath, [rer, 'list', ...args], { cwd: directory, env });
 const descriptors = { independent: { version: 2, project: 'example/independent' }, legacy: { version: 1 } };
 for (const [name, descriptor] of Object.entries(descriptors)) { await mkdir(join(parent, name), { recursive: true }); await writeFile(join(parent, name, 'OPERATIONS.json'), JSON.stringify(descriptor)); }
 await mkdir(join(parent, 'malformed'), { recursive: true }); await writeFile(join(parent, 'malformed/OPERATIONS.json'), '{not json');
 await mkdir(join(parent, 'notes')); await writeFile(join(parent, 'notes/README.md'), 'no descriptor here');
 await exportReference(resolve(import.meta.dirname, '../..'), join(parent, 'seed'));
 const tree = async folder => (await readdir(folder, { withFileTypes: true, recursive: true })).filter(entry => !entry.isSymbolicLink()).map(entry => join(entry.parentPath, entry.name)).sort();
 const before = await tree(parent);

 const listed = await list(parent, '--json');
 assert.equal(listed.code, 0, listed.stderr);
 const { checkouts } = JSON.parse(listed.stdout);
 const byName = Object.fromEntries(checkouts.map(entry => [entry.name, entry])), seed = byName.seed;
 assert.deepEqual(Object.keys(byName).sort(), ['independent', 'legacy', 'malformed', 'seed'], 'only folders with an OPERATIONS.json are listed');
 assert.deepEqual([seed.profile, seed.launchable, seed.prepared, seed.url], ['first-party', true, false, null], 'an unprepared seed is launchable and says it has no setup yet');
 assert.deepEqual([byName.independent.profile, byName.independent.launchable], ['independent', false]);
 assert.deepEqual([byName.legacy.profile, byName.legacy.launchable, byName.malformed.launchable], ['unsupported', false, false]);
 for (const name of ['independent', 'legacy', 'malformed']) assert.ok(byName[name].reason, `${name} says why it cannot launch`);
 assert.deepEqual(await tree(parent), before, 'listing creates and removes nothing');

 const human = await list(parent);
 assert.equal(human.code, 0);
 for (const name of Object.keys(byName)) assert.ok(human.stdout.includes(name));
 assert.equal((await list(join(directory, 'missing'))).code, 3, 'a folder that does not exist is refused');
 assert.equal((await list('--wat')).code, 2);
});
