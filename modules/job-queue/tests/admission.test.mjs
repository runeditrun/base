import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { admission, configuration, ordered, TIMEOUT_EXIT } from '../config.mjs';
import { setup } from './helpers.mjs';
import { parse } from '../cli.mjs';
import { recordedState } from './state.mjs';

const config = { slots: 2, loadThreshold: 36, minFreeMemoryBytes: 100 };
test('slots, load and free memory independently refuse admission with exact boundaries', () => {
  assert.match(admission(2, config, { load: 0, availableMemoryBytes: 1000 }), /slots/);
  assert.match(admission(0, config, { load: 36.01, availableMemoryBytes: 1000 }), /load/);
  assert.match(admission(0, config, { load: 0, availableMemoryBytes: 100 }), /memory/);
  assert.equal(admission(1, config, { load: 36, availableMemoryBytes: 101 }), null);
  assert.match(admission(0, config, { load: NaN, availableMemoryBytes: 101 }), /could not be read/);
});
test('central config, environment overrides and conservative hardware defaults', async t => {
  const { directory } = await setup(t);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'config.json'), JSON.stringify({ slots: 2, loadThreshold: 12 }));
  const settings = await configuration({ env: { RER_JOBS_DIR: directory, RER_JOBS_LOAD_THRESHOLD: '20' } });
  assert.equal(settings.slots, 2); assert.equal(settings.loadThreshold, 20);
  await assert.rejects(configuration({ env: {}, directory, slots: 0 }), /Invalid/);
  await assert.rejects(configuration({ env: { RER_JOBS_POLL_MS: 'bad' }, directory }), /Invalid/);
});
test('priority orders classes; sequence preserves FIFO inside a class', () => {
  const jobs = [{ sequence: 1, priority: 'background' }, { sequence: 2, priority: 'normal' },
    { sequence: 3, priority: 'owner' }, { sequence: 4, priority: 'normal' }];
  assert.deepEqual(ordered(jobs).map(job => job.sequence), [3, 2, 4, 1]);
});
test('supplied HOME selects its configuration while an explicit jobs directory wins', async t => {
  const { directory } = await setup(t);
  const home = join(directory, 'home'), jobs = join(home, '.rer/jobs');
  await mkdir(jobs, { recursive: true });
  await mkdir(join(directory, 'override'), { recursive: true });
  await writeFile(join(jobs, 'config.json'), JSON.stringify({ nice: 7 }));
  await writeFile(join(directory, 'override/config.json'), JSON.stringify({ nice: 11 }));
  assert.equal((await configuration({ env: { HOME: home } })).nice, 7);
  assert.equal((await configuration({ env: { HOME: home, RER_JOBS_DIR: join(directory, 'override') } })).nice, 11);
});
test('parser preserves exact argv after separator and rejects malformed invocation', () => {
  assert.deepEqual(parse(['run', '--kind', 'heavy', '--json', '--label', 'A B', '--', 'printf', '%s', '$()']).command,
    ['printf', '%s', '$()']);
  assert.throws(() => parse(['run', '--kind', 'heavy']), /job-queue/);
  assert.throws(() => parse(['status', '--max-wait', 'no']), /nonnegative/);
  assert.throws(() => parse(['run', '--label', '--', 'node']), /Missing/);
});
// Load is a guard only where a fleet sets a threshold; memory always is.
for (const [name, sampler, pattern, limits] of [
  ['load', () => ({ load: 37, availableMemoryBytes: 1024 ** 4 }), /load/, { loadThreshold: 36 }],
  ['memory', () => ({ load: 0, availableMemoryBytes: 0 }), /memory/, {}],
]) test(`injected ${name} sampler holds a real command until maxWait with distinct exit`, async t => {
  const { directory, queue } = await setup(t, { sampler, ...limits });
  let started = false;
  const result = await queue.run([process.execPath, '-e', 'process.exit(9)'],
    { maxWait: .08, onStarted: () => { started = true; } });
  assert.equal(result.code, TIMEOUT_EXIT); assert.equal(result.timedOut, true);
  assert.match(result.reason, pattern); assert.equal(started, false);
  const state = await recordedState(directory).read();
  assert.deepEqual(state.queued, []); assert.deepEqual(state.running, []);
});
