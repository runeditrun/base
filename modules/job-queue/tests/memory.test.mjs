import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createQueue } from '../index.mjs';
import { parseVmStat, parseMemAvailable } from '../resources.mjs';
import { waitingMessage } from '../waiting.mjs';
import { setup, until, worker } from './helpers.mjs';
import { recordedState } from './state.mjs';

// Real vm_stat output from a 64 GiB Mac that read 0.5 GiB "free" and had about 24 GiB available.
const vmStat = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                    19111.
Pages active:                                1503985.
Pages inactive:                              1482236.
Pages speculative:                             20278.
Pages throttled:                                   0.
Pages wired down:                             468193.
Pages purgeable:                                7702.
`;

test('memory available to a job counts what the OS can reclaim, not only its free counter', () => {
  assert.equal(parseVmStat(vmStat), (19111 + 1482236 + 20278 + 7702) * 16384);
  assert.equal(parseMemAvailable('MemTotal:       16384000 kB\nMemFree:          204800 kB\nMemAvailable:    8192000 kB\n'), 8192000 * 1024);
  assert.ok(Number.isNaN(parseVmStat('not vm_stat output')));
});

test('a waiting job says who is ahead of it and where, memory against the floor, and how to change it', async t => {
  const { directory, queue } = await setup(t);
  const release = join(directory, 'release'), repository = await realpath(await mkdtemp(join(tmpdir(), 'rer-ahead-')));
  const first = queue.run([process.execPath, worker, 'gate', release], { label: 'other checkout install', cwd: repository });
  const second = await createQueue({ directory, env: {}, slots: 1, pollMs: 20, sampler: () => ({ load: 0, availableMemoryBytes: 8 * 1024 ** 3 }) });
  await recordedState(directory).wait(state => state.running.length === 1);
  let wait;
  const pending = second.run([process.execPath, '-e', 'process.exit(0)'], { onWaiting: (reason, detail) => { wait ??= detail; } });
  try {
    await until(() => wait);
    const text = waitingMessage(wait);
    assert.ok(text.includes(repository) && text.includes('other checkout install'), text);
    assert.match(text, /8\.0 GiB available, floor [0-9.]+ GiB.*RER_JOBS_MIN_FREE_MEMORY_BYTES/s);
  } finally { await writeFile(release, 'go'); await first; await pending; await second.close(); }
});
