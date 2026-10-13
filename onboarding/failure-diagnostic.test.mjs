import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCommands } from './commands.mjs';
import { installationFailure, installationFailureMessage } from './failures.mjs';

test('a canned command failure keeps an approved captured diagnostic and ignores a forged one', async t => {
 const root = await mkdtemp(join(tmpdir(), 'failure-diagnostic-'));
 const store = await createCommands(root, { logs: [] }, { terminal: () => {} });
 t.after(async () => { await store.closeCommands(); await rm(root, { recursive: true, force: true }); });
 let captured;
 await assert.rejects(store.run('Applying database migrations', process.execPath, ['-e', "console.log('migration 0003 failed');process.exit(4)"]), error => { captured = error; return true; });
 const message = installationFailureMessage(installationFailure('command_failed', { step: 'setup', diagnostic: captured }));
 const lines = message.split('\n');
 assert.equal(lines[0], 'Applying database migrations: exit 4, signal none.');
 assert.match(lines[1], /^Installation stopped while setting up the application\./);
 assert.match(message, /\nLast output \(up to 40 lines\):\nmigration 0003 failed\nLog: .*install\.log$/);
 const forged = new Error(captured.message.replace('migration 0003 failed', 'forged text'));
 const plain = installationFailureMessage(installationFailure('command_failed', { step: 'setup', diagnostic: forged }));
 assert.match(plain, /^Installation stopped while setting up the application\./);
 assert.ok(!plain.includes('forged text'));
});
