// A zero-setup `rer dev` chooses its own port: it skips the port a stopped
// checkout was set up on, and when another process takes the port it chose
// before setup can use it, the launch moves to the next free port, says which,
// and comes up there. The checkout is a minimal vendored
// first-party seed whose dispatcher is Base's own CLI; on its first setup the
// dispatcher starts an unrelated listener on the chosen port, as another
// program on the computer would.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isolatedQueue } from '../../cli/fixtures/queue.mjs';
import { launchPath } from '../launch/state.mjs';
import { freePort, run, sweep } from './harness.mjs';

const base = resolve(import.meta.dirname, '../..');
const source = path => JSON.stringify(pathToFileURL(join(base, path)).href);

test('a zero-setup rer dev skips a stopped checkout\'s saved port and moves past a port another process takes', { timeout: 5 * 60_000 }, async t => {
 const directory = await mkdtemp(join(tmpdir(), 'rer-port-')), root = join(directory, 'seed');
 const env = await isolatedQueue(t, { PATH: process.env.PATH, HOME: process.env.HOME, CI: 'true', RER_SERVERS_DIR: join(directory, 'servers'), RER_DEV_PORT_FROM: String(await freePort()), ...Object.fromEntries(['TMPDIR'].filter(name => process.env[name]).map(name => [name, process.env[name]])) });
 const rer = args => run(process.execPath, [join(base, 'global/rer.mjs'), ...args], { cwd: root, env });
 t.after(async () => {
  try {
   await rer(['dev', '--stop']);
   const holder = await readFile(join(directory, 'holder.pid'), 'utf8').catch(() => '');
   if (holder) try { process.kill(Number(holder), 'SIGTERM'); } catch {}
   assert.deepEqual((await sweep(root)).map(item => item.command), [], 'nothing of the checkout is left running');
  } finally { await rm(directory, { recursive: true, force: true }); }
 });
 await mkdir(join(root, 'scripts'), { recursive: true });
 await mkdir(join(root, 'node_modules'));
 await writeFile(join(root, 'node_modules/.modules.yaml'), '');
 const pins = JSON.parse(await readFile(join(base, 'default-seed/package.json'), 'utf8'));
 await writeFile(join(root, '.node-version'), pins.engines.node + '\n');
 await writeFile(join(root, 'package.json'), JSON.stringify({ engines: pins.engines, packageManager: pins.packageManager }));
 await writeFile(join(root, 'rer-setup.json'), JSON.stringify({ schema: 1, title: 'Port fixture', groups: [], steps: [{ type: 'extension', id: 'native-owner' }],
  fields: [{ name: 'OWNER_EMAIL', label: 'Owner email', kind: 'email', required: true }] }));
 await writeFile(join(root, 'app.mjs'), `
import { createServer } from 'node:http';
createServer((request, response) => response.end(JSON.stringify({ status: 'ok' }))).listen(Number(process.argv[2]), '127.0.0.1');
`);
 await writeFile(join(root, 'adapter.mjs'), `
import { localInstaller } from ${source('onboarding/adapter.mjs')};
import { commandAdapter as declare } from ${source('cli/adapter.mjs')};
const lifecycle = localInstaller({ secrets: { file: '.dev.vars', format: 'dotenv', originKey: 'AUTH_ORIGIN', values: ({ origin }) => ({ AUTH_ORIGIN: origin }) },
 start: context => ['node', ['app.mjs', String(context.runtimePort ?? new URL(context.origin).port)]],
 signIn: async () => {} });
export const commandAdapter = declare(lifecycle, { setup: { manifestFile: 'rer-setup.json' }, input: { names: { email: 'OWNER_EMAIL' } }, settings: ['.dev.vars'] });
`);
 await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify({ version: 2, project: 'example/port', runtime: { requirements: [] }, requiredEnvironment: [],
  seedContract: { version: 1, profile: 'first-party', adapter: 'adapter.mjs' }, commands: Object.fromEntries(['setup', 'dev', 'doctor'].map(verb => [verb, { argv: ['node', 'adapter.mjs'], inputs: ['adapter.mjs'], effects: 'Local port flow.' }])) }));
 // The first setup finds its chosen port already taken by another program.
 await writeFile(join(root, 'scripts/rer.mjs'), `
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
const args = process.argv.slice(2), holderFile = ${JSON.stringify(join(directory, 'holder.pid'))};
if (args[0] === 'setup' && args.includes('--port') && !existsSync(holderFile)) {
 const port = args[args.indexOf('--port') + 1];
 const holder = spawn(process.execPath, ['-e', "require('node:net').createServer().listen(" + port + ", '127.0.0.1', () => console.log('up'))"], { cwd: ${JSON.stringify(directory)}, detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
 writeFileSync(holderFile, String(holder.pid), { flag: 'wx' });
 writeFileSync(${JSON.stringify(join(directory, 'taken-port'))}, port);
 await once(holder.stdout, 'data');
 holder.stdout.destroy(); holder.unref();
}
const { main } = await import(${source('cli/main.mjs')});
process.exitCode = await main();
`);
 // Another checkout, now stopped, was set up by rer dev on the first free port.
 const saved = Number(env.RER_DEV_PORT_FROM), other = launchPath(join(directory, 'other'), env);
 await mkdir(other, { recursive: true });
 await writeFile(join(other, 'setup.json'), JSON.stringify({ state: 'done', port: saved, owner: 'owner@other.test', at: Date.now() }));
 const launched = await rer(['dev']);
 assert.equal(launched.code, 0, launched.stderr + launched.stdout);
 const taken = Number(await readFile(join(directory, 'taken-port'), 'utf8'));
 const ready = new URL(launched.stdout.match(/^RER_READY (\S+)$/m)?.[1] ?? 'http://invalid');
 assert.ok(taken !== saved && Number(ready.port) !== saved, 'the launch never chooses the stopped checkout\'s port');
 assert.notEqual(Number(ready.port), taken, 'the launch does not stay on the taken port');
 assert.match(launched.stderr, new RegExp(`port ${ready.port}`), 'the launch says which port it chose');
 assert.equal((await fetch(ready.origin + '/health')).status, 200);
});
