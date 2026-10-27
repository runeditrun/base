import { namedSteps } from '../../review-harness/tests/fold-steps.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setup, client, worker, until } from './helpers.mjs';
import { recordedState } from './state.mjs';
import { createQueue } from '../index.mjs';

test("shared queue admission reconciles live member requests with authoritative central slots", async t => {
  const step = namedSteps(t);
  await step('mixed-limit CLI members admit the lower-limit head first and fill the shared limit', async t => {
    const { directory, queue } = await setup(t, { slots: 3 });
    const ledger = recordedState(directory, 5), release = join(directory, 'release');
    const launch = (label, slots) => client(t, directory,
      ['run', '--kind', 'heavy', '--label', label, '--', process.execPath, worker, 'gate', release],
      { env: { RER_JOBS_SLOTS: String(slots) } });
    const jobs = [];
    try {
      for (let i = 0; i < 3; i++) {
        jobs.push(launch(`running-${i}`, 3));
        await ledger.wait(state => state.running.length === i + 1);
      }
      jobs.push(launch('head-3', 3));
      await ledger.wait(state => state.queued.some(job => job.label === 'head-3'));
      jobs.push(launch('next-5', 5));
      const full = await until(async () => {
        const state = await ledger.read();
        return state.running.length === 5 && state;
      }, 5000);
      assert.deepEqual(full.running.map(job => job.label),
        ['running-0', 'running-1', 'running-2', 'head-3', 'next-5']);
      jobs.push(launch('sixth-5', 5));
      await ledger.wait(state => state.queued.some(job => job.label === 'sixth-5'));
      const view = await queue.status();
      assert.equal(view.config.slots, 5);
      assert.equal(view.running.length, 5);
      assert.deepEqual(view.queued.map(job => job.label), ['sixth-5']);
      await writeFile(release, 'go');
      const results = await Promise.all(jobs.map(job => job.done));
      for (const result of results) assert.equal(result.code, 0, result.stderr);
      const notices = results[3].stderr.split('\n').filter(line => line.startsWith('Job queue uses '));
      assert.equal(notices.length, 1);
      assert.match(notices[0], /5 slots.*requested 3.*config\.json/);
      assert.equal((await queue.drain({ maxWait: 1 })).code, 0);
    } finally {
      await writeFile(release, 'go');
      // Main stalls until the lower-limit head is cancelled; cleanup must not hang.
      for (const job of jobs) if (job.child.exitCode === null) job.child.kill('SIGTERM');
      await Promise.allSettled(jobs.map(job => job.done));
    }
  });
  
  await step('central slots override clients, reload live, and closed or dead clients release their requests', async t => {
    const { directory, queue } = await setup(t, { slots: 3 });
    const configFile = join(directory, 'config.json'), release = join(directory, 'release');
    await writeFile(configFile, JSON.stringify({ slots: 1 }));
    const high = await createQueue({ directory, env: { RER_JOBS_SLOTS: '5' }, pollMs: 20 });
    const ledger = recordedState(directory, 5);
    const job = client(t, directory,
      ['run', '--kind', 'heavy', '--label', 'live-request-5', '--', process.execPath, worker, 'gate', release],
      { env: { RER_JOBS_SLOTS: '5' } });
    try {
      await ledger.wait(state => state.running.length === 1);
      assert.equal((await high.status()).config.slots, 1);
      assert.equal((await queue.status()).config.slots, 1);
      await writeFile(configFile, JSON.stringify({ slots: 2 }));
      assert.equal((await queue.status()).config.slots, 2);
      await unlink(configFile);
      assert.equal((await queue.status()).config.slots, 5);
      await high.close();
      assert.equal((await queue.status()).config.slots, 5);
      job.child.kill('SIGKILL');
      await job.done;
      assert.equal((await queue.status()).config.slots, 3);
      await queue.drain({ maxWait: 5 });
    } finally {
      await writeFile(release, 'go');
      await high.close();
      if (job.child.exitCode === null && job.child.signalCode === null) job.child.kill('SIGTERM');
      await job.done;
    }
  });
})



