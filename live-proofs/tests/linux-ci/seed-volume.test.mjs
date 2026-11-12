import { runRows } from '../../../default-seed/tests/rows.mjs'
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Containers, seedVolumeOptions } from '../../t016/isolation.mjs';

const volumeRows = []

// Docker protocol fixtures only; the PR qualification exercises the real daemon.
function fixture(t, failRun = false) {
  const root = mkdtempSync(join(tmpdir(), 'seed-volume-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = []; let next = 1;
  const c = new Containers({ PATH: process.env.PATH, HOME: root, RUNNER_TEMP: root, T016_CONTAINER_LABEL: 't016-volume-test' });
  t.mock.method(c, 'docker', async args => {
    calls.push(args);
    return { exitCode: args[0] === 'run' && failRun ? 1 : 0,
      output: Buffer.from(args[0] === 'run' ? String(next++).padStart(64, '0') : '') };
  });
  return { c, calls };
}
volumeRows.push(['each container has a private tmpfs volume and removes it after its processes', {}, async t => {
  const { c, calls } = fixture(t);
  try {
    const one = await c.create('sha256:' + '1'.repeat(64)), two = await c.create('sha256:' + '2'.repeat(64));
    assert.notEqual(c.seedVolumes.get(one), c.seedVolumes.get(two));
    for (const create of calls.filter(a => a[0] === 'volume' && a[1] === 'create')) {
      assert(create.includes('t016.run=t016-volume-test')); assert(create.includes('local'));
      for (const [key, value] of Object.entries(seedVolumeOptions)) assert(create.includes(key + '=' + value));
    }
    for (const run of calls.filter(a => a[0] === 'run')) {
      assert(run.includes('--read-only')); assert(run.includes('--cap-drop=ALL')); assert(run.includes('no-new-privileges'));
      assert(run.some(a => a.startsWith('type=volume,src=') && a.endsWith(',dst=/seed,volume-nocopy')));
      assert(!run.some(a => a.startsWith('/seed:')));
    }
    const volume = c.seedVolumes.get(one); await c.remove(one);
    const removed = calls.findIndex(a => a[0] === 'rm' && a.at(-1) === one);
    assert(calls.findIndex(a => a[0] === 'volume' && a[1] === 'rm' && a.at(-1) === volume) > removed);
  } finally { await c.close(); }
  assert.equal(c.ids.size, 0); assert.equal(c.volumes.size, 0);
}]);
volumeRows.push(['failed container startup still removes the allocated tmpfs volume', {}, async t => {
  const { c, calls } = fixture(t, true);
  try { await assert.rejects(c.create('sha256:' + '1'.repeat(64)), /container-operation-failed/); }
  finally { await c.close(); }
  assert.equal(c.volumes.size, 0);
  assert(calls.some(a => a[0] === 'volume' && a[1] === 'rm'));
}]);

test("container seed volume custody isolates bytes and cleans successful and failed startups", async t => {
  await runRows(t, volumeRows)
})
