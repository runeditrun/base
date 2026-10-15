import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createState } from './state.mjs';

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
