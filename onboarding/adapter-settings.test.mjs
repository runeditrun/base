import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { localInstaller } from './adapter.mjs';
import { createState } from './state.mjs';

async function fixture(t) {
 const root = await mkdtemp(join(tmpdir(), 'adapter-settings-'));
 const store = await createState(root, { product: 'Settings fixture', model: { safeKeys: [] } }, { terminal: () => {} });
 t.after(async () => { await store.closeCommands(); await rm(root, { recursive: true, force: true }); });
 const install = async hooks => {
  await localInstaller({ tools: [], dependencies: false, ...hooks }).install(root, {}, store, () => {});
  return store.state;
 };
 return { root, store, install };
}

for (const format of ['dotenv', 'json']) {
 test(`a ${format} rerun tightens a complete existing settings file without changing its bytes`, async t => {
  const { root, install } = await fixture(t);
  const path = join(root, 'settings');
  const bytes = format === 'json' ? '{"SESSION_SECRET":"test-synthetic-existing-secret"}\n' : '# owner comment\nSESSION_SECRET=test-synthetic-existing-secret\n';
  await writeFile(path, bytes); await chmod(path, 0o644);
  const state = await install({ secrets: { file: 'settings', format, generate: ['SESSION_SECRET'] } });
  assert.equal(state.phase, 'complete');
  assert.equal(await readFile(path, 'utf8'), bytes);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
 });
}

test('recovery restores the saved origin before selecting the start address', async t => {
 const { root, install } = await fixture(t);
 await mkdir(join(root, '.wrangler/local-build/run-killed'), { recursive: true });
 await writeFile(join(root, '.wrangler/local-build/run-killed/original.dev.vars'), 'AUTH_ORIGIN=http://127.0.0.1:43210\nSESSION_SECRET=test-synthetic-recovered-secret\n', { mode: 0o600 });
 let origin;
 const state = await install({ secrets: { originKey: 'AUTH_ORIGIN', generate: ['SESSION_SECRET'] }, migrate: context => { origin = context.origin; } });
 assert.equal(state.phase, 'complete');
 assert.equal(origin, 'http://127.0.0.1:43210');
});

test('all credential-shaped saved settings are registered before a command emits bare values', async t => {
 const { root, store, install } = await fixture(t);
 const values = { privateKey: 'test-synthetic-private-setting', dbPassword: 'test-synthetic-password-setting', clientSecret: 'test-synthetic-client-setting' };
 await writeFile(join(root, 'settings.json'), JSON.stringify(values), { mode: 0o600 });
 const state = await install({ secrets: { file: 'settings.json', format: 'json' }, migrate: [process.execPath, ['-e', "const v=JSON.parse(require('fs').readFileSync('settings.json'));for(const s of Object.values(v))console.log(s)"]] });
 assert.equal(state.phase, 'complete');
 const log = await readFile(store.logPath, 'utf8');
 for (const value of Object.values(values)) assert.ok(!log.includes(value), 'a saved credential reached the log');
});

test('settings storage refuses a symlinked ancestor without changing the target', async t => {
 const { root, install } = await fixture(t);
 const outside = await mkdtemp(join(tmpdir(), 'adapter-settings-outside-'));
 t.after(() => rm(outside, { recursive: true, force: true }));
 await symlink(outside, join(root, 'data'));
 const state = await install({ secrets: { file: 'data/settings.json', format: 'json', generate: ['SESSION_SECRET'] } });
 assert.equal(state.phase, 'failed');
 await assert.rejects(stat(join(outside, 'settings.json')), { code: 'ENOENT' });
});


test('reference preservation keeps deliberately removed setup tokens absent and private bytes exact', async t => {
 const { root, install } = await fixture(t);
 const path = join(root, '.dev.vars'), bytes = '# retained owner settings\nOWNER_EMAIL=owner@example.test\nSESSION_SECRET=test-synthetic-owner-session\n';
 await writeFile(path, bytes, { mode: 0o600 });
 const state = await install({ secrets: { keepExisting: true, generate: ['SESSION_SECRET', 'SETUP_TOKEN'], values: { OWNER_EMAIL: 'different@example.test' } } });
 assert.equal(state.phase, 'complete'); assert.equal(await readFile(path, 'utf8') === bytes, true, 'private bytes were kept exactly');
 assert.equal((await stat(path)).mode & 0o777, 0o600);
});
