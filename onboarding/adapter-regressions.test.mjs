import test from 'node:test';
import assert from 'node:assert/strict';
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createCommands } from './commands.mjs';
import { localInstaller, ownerAccountHosting } from './adapter.mjs';

// Separate custody channels pin both parts of the adapter's cleanup contract.
// The app and bounded-command stores each capture real child processes.
for (const kind of ['app', 'command']) test(`failure cleans up an isolated ${kind} before publishing failed`, async t => {
 const root = await mkdtemp(join(tmpdir(), 'adapter-cleanup-'));
 const state = { logs: [] }, signal = new AbortController().signal;
 await mkdir(join(root, 'app')); await mkdir(join(root, 'commands'));
 const appStore = await createCommands(join(root, 'app'), { logs: [] }, { terminal() {} });
 const commands = await createCommands(join(root, 'commands'), state, { terminal() {} });
 commands.setCommandSignal(signal);
 t.after(async () => { await appStore.closeCommands(); await commands.closeCommands(); await rm(root, { recursive: true, force: true }); });
 let child, closed = false, stoppedApp = 0, stoppedCommands = 0;
 const launch = store => {
  child = store.spawn('Cleanup regression', process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  child.once('close', () => { closed = true; }); return child;
 };
 const store = {
  ...commands, state, step: async label => commands.report(label),
  spawn: () => launch(appStore),
  waitForReady: async () => {},
  stop: async app => { stoppedApp++; await appStore.stop(app); },
  stopCommands: async scope => { assert.equal(scope, signal); stoppedCommands++; await commands.stopCommands(scope); },
  phase: async phase => {
   if (phase === 'failed') assert.ok(closed, `${kind} still running when failure was published`);
   state.phase = phase;
  },
 };
 const hooks = { tools: [], dependencies: false, origin: 'http://127.0.0.1:1' };
 if (kind === 'app') {
  hooks.start = [process.execPath, ['-e', 'setInterval(() => {}, 1000)']];
  hooks.owner = context => { throw context.fail('setup'); };
 } else hooks.prepare = context => { launch(commands); throw context.fail('setup'); };
 await localInstaller(hooks).install(root, {}, store, () => {}, signal);
 assert.equal(state.phase, 'failed'); assert.ok(closed);
 assert.equal(stoppedApp, kind === 'app' ? 1 : 0);
 assert.equal(stoppedCommands, 1);
 assert.notEqual(child.exitCode ?? child.signalCode, null);
});

test('hosting registers its token and added secrets before output outside command environments', async t => {
 const root = await mkdtemp(join(tmpdir(), 'hosting-registration-'));
 const state = { logs: [] }; let terminal = '';
 const store = await createCommands(root, state, { terminal: chunk => { terminal += chunk; } });
 t.after(async () => { await store.closeCommands(); await rm(root, { recursive: true, force: true }); });
 const token = 'test-synthetic-hosting-registration-token', secret = 'test-synthetic-hosting-registration-secret';
 let calls = 0;
 const hook = ownerAccountHosting({ cli: 'owner-cli.mjs', secrets: { AUTH_SECRET: secret } });
 await hook({
  root, input: { target: 'remote', accountId: 'a'.repeat(32), apiToken: token },
  store: { ...store, step: async text => store.report(text) },
  fail: () => Error('deployment failed'),
  async run(_label, _command, _args, options) {
   // No spawn/run on the command store: env auto-registration cannot help.
   assert.equal(options.env.CLOUDFLARE_API_TOKEN, token);
   assert.equal(options.env.AUTH_SECRET, secret);
   store.report(`Provider diagnostic: ${token} ${secret}`); calls++;
  },
 });
 assert.equal(calls, 2);
 await store.closeCommands();
 for (const output of [terminal, state.logs.join('\n'), await readFile(store.logPath, 'utf8')]) {
  for (const value of [token, secret]) assert.ok(!output.includes(value), 'hosting credential escaped registration');
  assert.match(output, /Provider diagnostic: \[REDACTED\] \[REDACTED\]/);
 }
});

test('foundation features have one declaration shared by browser, server and kit validation', async t => {
 try { await access(join(import.meta.dirname, '../foundation/template/scripts/installer/local.mjs')); }
 catch (error) { if (error.code !== 'ENOENT') throw error; t.skip('Base-only foundation declaration identity: real foundation source is absent in this onboarding copy'); return; }
 const root = await mkdtemp(join(tmpdir(), 'foundation-features-'));
 t.after(() => rm(root, { recursive: true, force: true }));
 await cp(join(import.meta.dirname, '../foundation/template/scripts/installer'), join(root, 'scripts/installer'), { recursive: true });
 await cp(join(import.meta.dirname, '../foundation/template/src/branding.json'), join(root, 'src/branding.json'), { recursive: true });
 await cp(import.meta.dirname, join(root, 'scripts/base-onboarding'), { recursive: true, filter: path => !path.includes('node_modules') });
 const { exportCLI } = await import('../cli/export.mjs'); await exportCLI(join(import.meta.dirname, '..'), root);
 const uiPath = join(root, 'scripts/installer/ui/seed.mjs');
 // A real edition edit must reach both the browser and server declarations.
 await writeFile(uiPath, (await readFile(uiPath, 'utf8')).replace('github: false', 'github: true'));
 const model = await import(pathToFileURL(uiPath));
 const { createSeed } = await import(pathToFileURL(join(root, 'scripts/installer/seed.mjs')));
 assert.strictEqual(createSeed(root).features, model.features);
 assert.equal(createSeed(root).features.github, true);
 // The kit must validate this same declaration instead of its own copy.
 await writeFile(uiPath, (await readFile(uiPath, 'utf8')).replace('hosting: false', 'hosting: true'));
 const invalid = join(root, 'invalid');
 await cp(join(root, 'scripts'), join(invalid, 'scripts'), { recursive: true });
 await assert.rejects(import(pathToFileURL(join(invalid, 'scripts/installer/local.mjs'))), /features.hosting needs a hosting hook/);
});
