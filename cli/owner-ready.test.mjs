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
  await until(() => json ? child.output.includes('"event":"ready"') : child.output.includes('RER_OPEN'), child);
  assert.equal((await f.observations()).at(-1).busy, false, 'Setup answered before ready');
  const link = json ? JSON.parse(child.output.split('\n').find(line => line.includes('"event":"ready"'))).openUrl : /RER_OPEN (.+)/.exec(child.output)[1];
  assert.equal(new URL(link).origin, f.origin);
  // A live server is checked again; cached readiness cannot bypass a busy page.
  await f.configure({ busyForever: true });
  const reused = f.start(true, 600);
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
  const child = f.start(true, 600);
  assert.equal(await child.done, 1, child.output + child.errors);
  assert.match(child.output, /owner_entry_not_ready/);
  assert.ok(child.output.includes(f.origin + '/workspace/start-here'));
  assert.doesNotMatch(child.output, /"event":"ready"/);
 }
});
