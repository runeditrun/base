import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createOutputRoot, finishOutputRoot } from './browser-output.mjs';

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

test('the browser check finishes its own output folder after printing results', async () => {
  const source = await readFile(new URL('./browser-check.mjs', import.meta.url), 'utf8');
  const printed = source.indexOf('console.log(JSON.stringify({ outputRoot, results }');
  const marked = source.indexOf('passed = true;', printed);
  const finished = source.indexOf('await finishOutputRoot(outputRoot, { passed })', marked);
  assert.ok(printed > 0 && marked > printed && finished > marked, 'results print, then pass is recorded, then the folder is finished in finally');
});
