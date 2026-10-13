import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { setup, client, worker } from './helpers.mjs';
import { recordedState } from './state.mjs';
import { atomicJson } from '../storage.mjs';

test('12 independent processes atomically mutate state without lost updates', async t => {
  const { directory } = await setup(t);
  const children = Array.from({ length: 12 }, () => {
    const child = spawn(process.execPath, [worker, 'counter', directory], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; child.stderr.on('data', data => { stderr += data; });
    const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve({ code, stderr })); });
    t.after(async () => { if (child.exitCode === null) child.kill('SIGKILL'); await done; });
    return done;
  });
  for (const result of await Promise.all(children)) assert.equal(result.code, 0, result.stderr);
  const state = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
  assert.equal(state.sequence, 96);
});

test('8 real CLI clients in two repositories hold at most two leases and grant in FIFO order', async t => {
  const { directory } = await setup(t, { slots: 2 });
  const ledger = recordedState(directory, 2);
  const repositories = [join(directory, 'repo-a'), join(directory, 'repo-b')];
  for (const cwd of repositories) await mkdir(cwd);
  const releases = Array.from({ length: 8 }, (_, index) => join(directory, `release-${index}`));
  const jobs = Array.from({ length: 8 }, (_, index) => client(t, directory,
    ['run', '--kind', 'heavy', '--label', `job-${index}`, '--', process.execPath, worker, 'gate', releases[index]],
    { cwd: repositories[index % 2], env: { RER_JOBS_SLOTS: '2', TZ: index % 2 ? 'UTC' : 'Australia/Brisbane' } }));
  try {
    const admitted = await ledger.wait(state => state.running.length === 2
      && state.running.length + state.queued.length === jobs.length);
    const order = [...admitted.running, ...admitted.queued].sort((a, b) => a.sequence - b.sequence);
    assert.equal(new Set(order.map(job => job.sequence)).size, jobs.length);
    assert.deepEqual(new Set(order.map(job => job.repository)), new Set(await Promise.all(repositories.map(path => realpath(path)))));
    let state = admitted;
    for (let index = 0; index < order.length; index++) {
      // Every command remains held until this release: excess/early grants
      // cannot disappear between snapshots merely because a short job finished.
      assert.deepEqual(state.running.map(job => job.id), order.slice(index, index + 2).map(job => job.id));
      assert.deepEqual(state.queued.map(job => job.id), order.slice(index + 2).map(job => job.id));
      const released = order[index];
      await writeFile(releases[Number(released.label.slice('job-'.length))], 'go');
      const next = order.slice(index + 1, index + 3).map(job => job.id);
      state = await ledger.wait(view => !view.running.some(job => job.id === released.id)
        && view.running.length === next.length);
      assert.deepEqual(state.running.map(job => job.id), next,
        'The next FIFO lease is granted only after the released lease is removed');
    }
    for (const result of await Promise.all(jobs.map(job => job.done))) assert.equal(result.code, 0, result.stderr);
    assert.deepEqual((await ledger.read()).queued, []);
  } finally {
    await Promise.all(releases.map(path => writeFile(path, 'go')));
    await Promise.allSettled(jobs.map(job => job.done));
  }
});

test('a crashed lock contender is reclaimed, and a recycled PID cannot keep the lock', async t => {
  const { directory, queue } = await setup(t);
  const locks = join(directory, 'locks'); await mkdir(locks, { recursive: true });
  await atomicJson(join(locks, 'dead.json'), { id: 'dead', choosing: true, number: 0, owner: { pid: 2147483647, start: 'gone' } });
  await atomicJson(join(locks, 'reused.json'), { id: 'reused', choosing: false, number: 1,
    owner: { pid: process.pid, start: 'different-start' } });
  assert.equal((await queue.status()).admissionReason, 'queue empty');
});
