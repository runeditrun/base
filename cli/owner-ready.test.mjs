import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as pause } from 'node:timers/promises';
import { ownerReadyFixture } from './fixtures/owner-ready.mjs';

test('rer dev announces the owner entry only after its redirected Setup answers, including reuse and bounded refusal', { timeout: 90000 }, async t => {
 const f = await ownerReadyFixture(t);
 async function until(check, child) {
  const deadline = Date.now() + 15000;
  while (!await check()) {
   assert.equal(child.exitCode, null, child.output + child.errors);
   assert.ok(Date.now() < deadline, 'public command reaches the expected state');
   await pause(25);
  }
 }
 for (const json of [true, false]) {
  await f.configure({ busyMs: 2000, status: 200, ...(json ? { clientMs: 1500 } : {}) });
  const child = f.start(json);
  await until(async () => (await f.observations()).some(row => row.busy), child);
  assert.doesNotMatch(child.output, /"event":"ready"|RER_READY|RER_OPEN/, 'persona readiness cannot announce a busy owner destination');
  if (json) {
   await until(async () => (await f.observations()).some(row => !row.busy), child);
   assert.doesNotMatch(child.output, /"event":"ready"/, 'a 2xx document with client loading cannot announce readiness');
  }
  await until(() => json ? child.output.includes('"event":"ready"') : child.output.includes('RER_OPEN'), child);
  assert.equal((await f.observations()).at(-1).busy, false, 'Setup answered before ready');
  if (json) assert.equal((await f.observations()).at(-1).mounted, true, 'client-rendered Setup mounted before ready');
  const link = json ? JSON.parse(child.output.split('\n').find(line => line.includes('"event":"ready"'))).openUrl : /RER_OPEN (.+)/.exec(child.output)[1];
  assert.equal(new URL(link).origin, f.origin);
  // A live server is checked again; cached readiness cannot bypass a busy page.
  await f.configure({ busyForever: true });
  const reused = f.start(true, 3000);
  assert.equal(await reused.done, 1, reused.output + reused.errors);
  const error = JSON.parse(reused.output.split('\n').find(line => line.includes('"event":"error"')));
  assert.equal(error.code, 'owner_entry_not_ready');
  assert.ok(error.message.includes(f.origin + '/workspace/start-here'), error.message);
  assert.match(error.message, /HTTP 503/);
  assert.doesNotMatch(reused.output, /"event":"ready"/);
  assert.ok(!reused.output.includes(f.key), 'timeout never prints the entry credential');
  child.kill('SIGTERM'); await child.done;
 }
 for (const config of [{ busyForever: true, status: 200 }, { hang: true }]) {
  await f.configure(config);
  const child = f.start(true, 3000);
  assert.equal(await child.done, 1, child.output + child.errors);
  assert.match(child.output, /owner_entry_not_ready/);
  assert.ok(child.output.includes(f.origin + '/workspace/start-here'));
  assert.doesNotMatch(child.output, /"event":"ready"/);
 }
 // A valid signed-in status page need not contain any interactive controls.
 await f.configure({ readOnly: true });
 const readOnly = f.start();
 await until(() => readOnly.output.includes('"event":"ready"'), readOnly);
 readOnly.kill('SIGTERM'); await readOnly.done;
 // Rendered content never overrides the other readiness requirements.
 for (const [config, reason] of [
  [{ readOnly: true, busyForever: true, status: 200 }, /Last seen: HTTP 200 \(busy\/retry interstitial\)/],
  [{ readOnly: true, refresh: true }, /Last seen: HTTP 200 \(refresh interstitial\)/],
  [{ readOnly: true, destinationStatus: 500 }, /destination status is not 2xx/],
  [{ empty: true }, /no rendered owner content/],
 ]) {
  await f.configure(config);
  const child = f.start(true, 3000);
  assert.equal(await child.done, 1, child.output + child.errors);
  const error = JSON.parse(child.output.split('\n').find(line => line.includes('"event":"error"')));
  assert.equal(error.code, 'owner_entry_not_ready');
  assert.match(error.message, reason);
  assert.ok(error.message.includes(f.origin + '/workspace/start-here'));
  assert.ok(!child.output.includes(f.key), 'readiness diagnostics never print the credential');
  assert.doesNotMatch(child.output, /"event":"ready"|RER_READY|RER_OPEN/);
 }
});
