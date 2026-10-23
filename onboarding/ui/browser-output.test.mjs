import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createOutputRoot, finishOutputRoot } from './browser-output.mjs';

const execute = promisify(execFile);

test('concurrent browser checks get separate output directories and keep each other\'s files', async t => {
  const taskTemp = await mkdtemp(join(tmpdir(), 'browser-output-'));
  t.after(() => rm(taskTemp, { recursive: true, force: true }));
  const first = await createOutputRoot(taskTemp);
  await writeFile(join(first, 'screenshots', 'first.png'), 'first run');
  const [second, third] = await Promise.all([createOutputRoot(taskTemp), createOutputRoot(taskTemp)]);
  assert.equal(new Set([first, second, third]).size, 3);
  for (const root of [first, second, third]) {
    assert.ok(root.startsWith(taskTemp));
    for (const folder of ['screenshots', 'axe']) assert.ok((await stat(join(root, folder))).isDirectory());
  }
  assert.equal(await readFile(join(first, 'screenshots', 'first.png'), 'utf8'), 'first run');
});

test('a passing check removes its output; a failing or kept check retains it', async t => {
  const taskTemp = await mkdtemp(join(tmpdir(), 'browser-output-'));
  t.after(() => rm(taskTemp, { recursive: true, force: true }));
  const passed = await createOutputRoot(taskTemp), failed = await createOutputRoot(taskTemp), kept = await createOutputRoot(taskTemp);
  assert.equal(await finishOutputRoot(passed, { passed: true, keep: false }), true);
  await assert.rejects(stat(passed), { code: 'ENOENT' });
  assert.equal(await finishOutputRoot(failed, { passed: false, keep: false }), false);
  assert.equal(await finishOutputRoot(kept, { passed: true, keep: true }), false);
  for (const root of [failed, kept]) assert.ok((await stat(join(root, 'screenshots'))).isDirectory());
});

test('the browser-check command removes successful output and preserves failed output', { timeout: 120000 }, async t => {
  const taskTemp = await mkdtemp(join(tmpdir(), 'browser-caller-'));
  t.after(() => rm(taskTemp, { recursive: true, force: true }));
  const env = { ...process.env, TMPDIR: taskTemp, KEEP_BROWSER_CHECK: '0', RER_JOBS_DIR: join(taskTemp, 'jobs') };
  const command = join(import.meta.dirname, 'browser-check.mjs');
  const outputs = async () => (await readdir(taskTemp)).filter(name => name.startsWith('onboarding-ui-browser-check-'));
  await execute(process.execPath, [command], { env });
  assert.deepEqual(await outputs(), [], 'a successful command removes its own reports');

  // An empty audit script exercises the real browser's missing-engine failure.
  const missingAudit = join(taskTemp, 'empty-axe.js');
  await writeFile(missingAudit, '');
  await assert.rejects(execute(process.execPath, [command], { env: { ...env, AXE_CORE_PATH: missingAudit } }), { code: 1 });
  const retained = await outputs();
  assert.equal(retained.length, 1, 'a failed command retains its own reports');
  assert.ok((await readdir(join(taskTemp, retained[0], 'screenshots'))).length > 0, 'the failed run retains its captured screen');
});
