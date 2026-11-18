import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as pause } from 'node:timers/promises';
import { ownerReadyFixture } from './fixtures/owner-ready.mjs';

// A fresh install's owner entry lands on first-run setup, which renders no route.
// The app's own first document render (seconds on an idle machine, minutes on a busy
// one) must finish before the server is announced ready, not under the owner's first
// signed-in page after setup.
test('rer dev announces ready only after the app has rendered its first document', { timeout: 90000 }, async t => {
 const f = await ownerReadyFixture(t);
 await f.configure({ readOnly: true, renderMs: 1500 });
 const child = f.start(true);
 const deadline = Date.now() + 30000;
 while (!child.output.includes('"event":"ready"')) {
  assert.equal(child.exitCode, null, child.output + child.errors);
  assert.ok(Date.now() < deadline, 'dev reaches ready');
  if (!(await f.observations()).some(row => row.render === 'done')) assert.doesNotMatch(child.output, /"event":"ready"|RER_OPEN/, 'ready waits for the first render');
  await pause(25);
 }
 assert.ok((await f.observations()).some(row => row.render === 'done'), 'the first render finished before ready');
 child.kill('SIGTERM'); await child.done;
});
