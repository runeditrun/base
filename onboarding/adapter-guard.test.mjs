import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { localInstaller } from './adapter.mjs';

test('guard runs immediately before every command, including custom owner and sign-in hooks', async t => {
 const root = await mkdtemp(join(tmpdir(), 'adapter-guard-'));
 t.after(() => rm(root, { recursive: true, force: true }));
 const events = [];
 const store = { state: {}, step: async () => {}, phase: async phase => { store.state.phase = phase; }, run: async () => { events.push('run'); } };
 const command = [process.execPath, ['-e', '']];
 const { install } = localInstaller({ tools: [], dependencies: command, migrate: command, owner: command, signIn: async context => { await context.run('Custom sign-in', ...command); return context.origin; }, guard: () => { events.push('guard'); } });
 await install(root, {}, store, () => {});
 assert.equal(store.state.phase, 'complete');
 assert.deepEqual(events, ['guard', 'run', 'guard', 'run', 'guard', 'run', 'guard', 'run']);
});
