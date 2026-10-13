import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setup, until, worker } from './helpers.mjs';
import { atomicJson } from '../storage.mjs';
import { processInfo } from '../processes.mjs';
import { identity, alive } from '../identity.mjs';
import { recordedState } from './state.mjs';

test('one occupied slot holds FIFO jobs; owner overtakes classes but normal retains order', async t => {
  const { directory, queue } = await setup(t);
  const ledger = recordedState(directory);
  const labels = ['first', 'owner', 'normal1', 'normal2'];
  const release = label => join(directory, `release-${label}`);
  const jobs = [queue.run([process.execPath, worker, 'gate', release('first')], { label: 'first' })];
  try {
    await ledger.wait(state => state.running.some(job => job.label === 'first'));
    for (const [label, priority] of [['normal1', 'normal'], ['normal2', 'normal'], ['owner', 'owner']]) {
      jobs.push(queue.run([process.execPath, worker, 'gate', release(label)], { label, priority }));
      await ledger.wait(state => state.queued.some(job => job.label === label));
    }
    const admitted = await ledger.read();
    assert.deepEqual(admitted.queued.map(job => job.label), ['normal1', 'normal2', 'owner']);
    assert.ok(admitted.queued[0].sequence < admitted.queued[1].sequence);
    const view = await queue.status();
    assert.equal(view.running.length, 1);
    assert.deepEqual(view.queued.map(job => job.label), ['owner', 'normal1', 'normal2']);
    assert.match(view.admissionReason, /slots/);
    assert.equal(view.running[0].command, undefined);
    for (const [index, label] of labels.entries()) {
      const state = await ledger.wait(state => state.running.some(job => job.label === label));
      assert.deepEqual(state.running.map(job => job.label), [label]);
      assert.deepEqual(new Set(state.queued.map(job => job.label)), new Set(labels.slice(index + 1)));
      await writeFile(release(label), 'go');
      await ledger.wait(state => !state.running.some(job => job.label === label));
    }
    assert.ok((await Promise.all(jobs)).every(result => result.code === 0));
    assert.deepEqual((await ledger.read()).running, []);
    assert.equal((await queue.drain({ maxWait: .1 })).code, 0);
  } finally {
    await Promise.all(labels.map(label => writeFile(release(label), 'go')));
    await Promise.allSettled(jobs);
  }
});

test('stale queued/running leases and reused PID are reclaimed without touching live process', async t => {
  const { directory, queue } = await setup(t);
  const current = await processInfo(process.pid);
  const job = (id, owner) => ({ id, owner, sequence: 1, priority: 'normal' });
  await atomicJson(join(directory, 'state.json'), { version: 1, sequence: 3,
    queued: [job('gone', { pid: 2147483647, start: 'gone' })],
    running: [job('reused', { ...current, start: 'prior-process-start', pgid: process.pid })] });
  const ledger = recordedState(directory);
  assert.deepEqual((await ledger.read()).queued.map(job => job.id), ['gone']);
  assert.deepEqual((await ledger.read()).running.map(job => job.id), ['reused']);
  const view = await queue.status();
  assert.equal(view.running.length, 0); assert.equal(view.queued.length, 0);
  const reclaimed = await ledger.read();
  assert.deepEqual(reclaimed.running, []); assert.deepEqual(reclaimed.queued, []);
  assert.ok(await processInfo(process.pid));
});

// These hold a job with the load gate a fleet sets (36), since load is no gate by default.
test('resource recovery admits a waiting real command without a default give-up', async t => {
  let load = 50;
  const { directory, queue } = await setup(t, { loadThreshold: 36, sampler: () => ({ load, availableMemoryBytes: 1024 ** 4 }) });
  const ledger = recordedState(directory);
  let waiting;
  const release = join(directory, 'release');
  const pending = queue.run([process.execPath, worker, 'gate', release], { onWaiting: reason => { waiting = reason; } });
  try {
    await until(() => waiting);
    assert.match(waiting, /load/);
    const held = await ledger.wait(state => state.queued.length === 1);
    assert.deepEqual(held.running, []);
    load = 36;
    const granted = await ledger.wait(state => state.running.length === 1);
    assert.equal(granted.running[0].id, held.queued[0].id);
    assert.deepEqual(granted.queued, []);
    await writeFile(release, 'go');
    assert.equal((await pending).code, 0);
    assert.deepEqual((await ledger.read()).running, []);
  } finally { load = 36; await writeFile(release, 'go'); await pending; }
});

test('AbortSignal cancels a queued job and releases its request', async t => {
  const { directory, queue } = await setup(t, { loadThreshold: 36, sampler: () => ({ load: 90, availableMemoryBytes: 1024 ** 4 }) });
  const ledger = recordedState(directory);
  const controller = new AbortController();
  const pending = queue.run([process.execPath, '-e', 'process.exit(0)'], { signal: controller.signal });
  try {
    const admitted = await ledger.wait(state => state.queued.length === 1);
    assert.deepEqual(admitted.running, []);
    controller.abort();
    assert.equal((await pending).code, 143);
    const cancelled = await ledger.read();
    assert.deepEqual(cancelled.queued, []); assert.deepEqual(cancelled.running, []);
  } finally { controller.abort(); await pending; }
});

test('lifetime nonce distinguishes a reused PID with identical macOS start timestamp', async () => {
  const prior = await identity();
  const lifetime = await identity();
  try {
    assert.equal(await alive(lifetime.info), true);
    assert.equal(prior.info.start, lifetime.info.start);
    assert.equal(await alive({ ...lifetime.info, token: prior.info.token }), false);
  } finally { await Promise.all([prior.close(), lifetime.close()]); }
});

test('process identity is stable across sessions with different TZ settings', async () => {
  const previous = process.env.TZ;
  try {
    process.env.TZ = 'UTC'; const utc = await processInfo(process.pid);
    process.env.TZ = 'Australia/Brisbane'; const brisbane = await processInfo(process.pid);
    assert.equal(utc.start, brisbane.start);
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});
