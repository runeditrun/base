import test from 'node:test';
import assert from 'node:assert/strict';
import { access, cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawn as spawnProcess } from 'node:child_process';
import { once } from 'node:events';
import { createState } from './state.mjs';

test('actual template shared lifecycle routes each phase through the store and fetches with the supplied probe signal', async t => {
 try { await access(resolve(import.meta.dirname, '../foundation/template/scripts/installer/local.mjs')); }
 catch (error) { if (error.code !== 'ENOENT') throw error; t.skip('Base-only actual foundation adapter: real foundation source is absent in this onboarding copy'); return; }
 const root = await mkdtemp(join(tmpdir(), 'template-adapter-'));
 t.after(() => rm(root, { recursive: true, force: true }));
 await mkdir(join(root, 'scripts/installer'), { recursive: true });
 await mkdir(join(root, 'scripts/base-onboarding'), { recursive: true });
 await mkdir(join(root, 'src'));
 await cp(resolve(import.meta.dirname, '../foundation/template/scripts/installer/local.mjs'), join(root, 'scripts/installer/local.mjs'));
 await cp(resolve(import.meta.dirname, '../foundation/template/scripts/installer/ui'), join(root, 'scripts/installer/ui'), { recursive: true });
 await cp(import.meta.dirname, join(root, 'scripts/base-onboarding'), { recursive: true });
 const { exportCLI } = await import('../cli/export.mjs'); await exportCLI(join(import.meta.dirname, '..'), root);
 await cp(resolve(import.meta.dirname, '../foundation/template/rer-setup.json'), join(root, 'rer-setup.json'));
 const { adapter } = await import(pathToFileURL(join(root, 'scripts/installer/local.mjs')));
 const labels = [], commands = [], installSignal = new AbortController().signal, probeSignal = new AbortController().signal;
 const child = { exitCode: null, signalCode: null };
 let registered, fetchSignal, healthUrl, listener, stopped = false;
 t.after(() => listener?.kill());
 let outboxReads = 0;
 t.mock.method(globalThis, 'fetch', async (url, options) => {
  if(String(url).endsWith('/auth/bootstrap'))return new Response(null,{status:303});
  if(String(url).endsWith('/auth/magic-link'))return new Response(null,{status:202});
  if(String(url).endsWith('/__dev/outbox'))return new Response(outboxReads++ ? '<article><p>To: owner@example.test</p><a href="?message=new-message">Message</a></article>' : '');
  fetchSignal = options.signal; healthUrl = url;
  return new Response(JSON.stringify({ status: 'ok' }), { headers: { 'Content-Type': 'application/json' } });
 });
 const store = {
  state: {},
  step: async label => { labels.push(label); },
  run: async (_label, command, args, options) => {
   commands.push({ command, args, options });
  },
  spawn: (_label, command, args, options) => {
   commands.push({ command, args, options }); return child;
  },
  waitForReady: async (_label, app, health, options) => {
   assert.equal(app, child);
   assert.equal(registered, child, 'adapter waited before registering app custody');
   assert.equal(options.signal, installSignal);
   assert.deepEqual(await health(probeSignal), { ready: true, message: 'HTTP 200; health status ok' });
   // The started application really holds its port; setup checks that before it claims an owner.
   listener = spawnProcess(process.execPath, ['-e', `require('node:net').createServer().listen(${runtimePort}, '127.0.0.1', () => console.log('listening')); setInterval(() => {}, 1000)`], { stdio: ['ignore', 'pipe', 'inherit'] });
   await once(listener.stdout, 'data');
   child.pid = listener.pid;
  },
  stop: async () => { stopped = true; },
  phase: async value => { store.state.phase = value; },
  redact: value => value,
 };
 store.setupManifest = (await (await import('./setup-manifest.mjs')).loadInstallerSeed(root, {...adapter, product:'Fixture', setup:{manifestFile:'rer-setup.json'}})).manifest;
 const input = { APP_NAME: 'Regression fixture', PRIMARY_COLOR: '#123456', displayName: 'Owner', OWNER_EMAIL: 'owner@example.test' };
 // Browser install now delegates to public CLI commands. This existing unit
 // fixture exercises the shared lifecycle that those commands dispatch.
 const { freePort } = await import('./adapter-settings.mjs'); const runtimePort = await freePort();
 await adapter.run(root, input, store, app => { registered = app; }, installSignal, {runtimePort});
 assert.equal(store.state.phase, 'complete');
 assert.equal(stopped, false);
 for(const label of ['Saving application branding','Installing locked dependencies','Building your application','Starting your application on this computer','First owner claimed','Your sign-in link is waiting in the development outbox','Your application is running locally'])assert.ok(labels.includes(label),label);
 assert.deepEqual(commands.slice(0, 2).map(({ command, args }) => [command, args]), [['pnpm', ['install', '--frozen-lockfile']], ['pnpm', ['run', 'build:app']]]);
 assert.ok(commands.every(({ options }) => options.signal === installSignal && options.cwd === root));
 assert.equal(fetchSignal, probeSignal);
 assert.equal(healthUrl, new URL(store.state.appUrl).origin + '/health');
 assert.deepEqual(JSON.parse(await readFile(join(root, 'src/branding.json'), 'utf8')), { name:input.APP_NAME,primaryColor:input.PRIMARY_COLOR });
 // Setup's production runtime binds the internal port, keeping public origin.
 const spawn = commands[3];
 assert.deepEqual([spawn.command, basename(spawn.args[0])], [process.execPath, 'production-runtime.mjs']);
 assert.equal(spawn.options.env.RER_RUNTIME_PORT, String(runtimePort));
 assert.notEqual(spawn.options.env.RER_RUNTIME_PORT, new URL(store.state.appUrl).port);
 assert.equal(spawn.options.env.X_LOCAL_EXPLORER, 'false');
});

test('a step announced and then run under the same label appears once in the page and the log', async t => {
 const root = await mkdtemp(join(tmpdir(), 'step-label-'));
 const store = await createState(root, { product: 'Label fixture', model: { safeKeys: ['name'] } });
 t.after(async () => { await store.closeCommands(); await rm(root, { recursive: true, force: true }); });
 for (const [label, run] of [['Installing locked dependencies', true], ['Starting your application', false]]) {
  await store.step(label);
  if (run) await store.run(label, process.execPath, ['-e', "console.log('child output')"]);
  else {
   const child = store.spawn(label, process.execPath, ['-e', "console.log('child output')"]);
   await store.stop(child);
  }
 }
 const log = await readFile(store.logPath, 'utf8');
 for (const label of ['Installing locked dependencies', 'Starting your application']) {
  assert.equal(log.split('\n').filter(line => line === label).length, 1, `${label} was reported more than once in the log`);
  assert.equal(store.state.logs.filter(line => line === label).length, 1, `${label} was reported more than once on the page`);
 }
 assert.equal(store.state.step, 'Starting your application');
});
