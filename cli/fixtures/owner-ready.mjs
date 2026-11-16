import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { ensureDevKey } from '../dev-identity.mjs';
import { isolatedQueue } from './queue.mjs';

export async function ownerReadyFixture(t) {
 const root = await mkdtemp(join(tmpdir(), 'rer-owner-ready-')), base = join(import.meta.dirname, '../..');
 const children = [];
 t.after(async () => {
  for (const child of children.reverse()) if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await child.done; }
  await rm(root, { recursive: true, force: true });
 });
 const socket = createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
 const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
 const origin = `http://127.0.0.1:${port}`, control = join(root, 'control.json'), observations = join(root, 'observations.jsonl');
 const key = await ensureDevKey(root), source = path => JSON.stringify(pathToFileURL(join(base, path)).href);
 await mkdir(join(root, 'home'));
 await symlink(join(base, 'default-seed/node_modules'), join(root, 'node_modules'), 'dir');
 await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module', engines: { node: process.versions.node }, packageManager: 'pnpm@10.12.4' }));
 await writeFile(join(root, '.node-version'), process.versions.node);
 await writeFile(join(root, '.dev.vars'), `OWNER_EMAIL=owner@example.test\nAUTH_ORIGIN=${origin}\n`, { mode: 0o600 });
 await writeFile(join(root, 'adapter.mjs'), `
import { commandAdapter as declare } from ${source('cli/adapter.mjs')};
import { readDevKey } from ${source('cli/dev-identity.mjs')};
import { setTimeout as pause } from 'node:timers/promises';
export const commandAdapter = declare({
 hooks: { tools: [], secrets: { file: '.dev.vars', format: 'dotenv', originKey: 'AUTH_ORIGIN' } },
 async run(root, input, store, onApp, signal, options) {
  const child = store.spawn('Starting fixture application', process.execPath, [${JSON.stringify(join(base, 'cli/fixtures/owner-ready-server.mjs'))}, String(options.runtimePort), options.selectedOrigin, await readDevKey(root), ${JSON.stringify(control)}, ${JSON.stringify(observations)}], { cwd: root, signal });
  await onApp(child);
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
   signal.throwIfAborted();
   try { if ((await fetch('http://127.0.0.1:' + options.runtimePort + '/health')).ok) return; } catch {}
   await pause(25, undefined, { signal });
  }
  throw Error('Fixture server did not listen');
 }
}, { devIdentity: {}, scheduled: false });
`);
 await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify({ version: 2, project: 'synthetic-base-1', runtime: { requirements: [] }, requiredEnvironment: [], seedContract: { version: 1, profile: 'first-party', adapter: 'adapter.mjs' }, commands: { dev: { argv: ['node', 'adapter.mjs'], inputs: ['adapter.mjs'], effects: 'Serve owner readiness fixture.' } } }));
 const env = await isolatedQueue(t, { ...process.env, HOME: process.env.HOME, CI: 'true' });
 function start(json = true, timeout = 8000) {
  const child = spawn(process.execPath, [join(base, 'bin/rer.mjs'), 'dev', '--cwd', root, ...(json ? ['--json'] : [])], { env: { ...env, RER_OWNER_READY_TIMEOUT_MS: String(timeout) }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.output = ''; child.errors = '';
  child.stdout.on('data', bytes => { child.output += bytes; }); child.stderr.on('data', bytes => { child.errors += bytes; });
  child.done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  children.push(child); return child;
 }
 return { root, origin, key, start, configure: async value => { await writeFile(control, JSON.stringify(value)); await writeFile(observations, ''); }, observations: async () => (await readFile(observations, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse) };
}
