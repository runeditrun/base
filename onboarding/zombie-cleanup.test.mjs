import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// One public command-store journey, real processes throughout. The outer
// supervisor reaps orphaned fixture children even under a non-reaping PID 1.
test('command cancellation finishes with a real zombie and still waits for a living child', { timeout: 45000 }, async t => {
 const root = await mkdtemp(join(tmpdir(), 'rer-zombie-'));
 t.after(() => rm(root, { recursive: true, force: true }));
 const fixture = name => fileURLToPath(new URL('./fixtures/' + name, import.meta.url));
 const { stdout } = await promisify(execFile)('python3', [fixture('zombie-custody.py'), process.execPath, fixture('zombie-driver.mjs'), root], { timeout: 40000 });
 assert.match(stdout, /zombie: pid=\d+ leader=\d+ cleanup_ms=\d+/);
 assert.match(stdout, /live: pid=\d+ leader=\d+ cleanup_ms=\d+/);
 t.diagnostic(stdout.trim());
});
