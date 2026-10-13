import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawnOwnedProcess, stopOwnedProcess } from '../process.mjs';
import { liveOwnedGroup } from '../process-group.mjs';

function denied() { return Object.assign(new Error('Permission denied'), { code: 'EPERM' }); }

test('a signal permission error is accepted only after inspection proves the owned group gone', async () => {
  const owned = spawnOwnedProcess(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  await once(owned.child, 'close');
  const original = process.kill;
  process.kill = function (pid, signal) {
    if (pid === -owned.state.pid) throw denied(); // Inject the OS exit/permission race, not a disappearance result.
    return original(pid, signal);
  };
  try {
    await stopOwnedProcess(owned, 50);
    assert.equal(await liveOwnedGroup(owned.state.pid, 1000), false);
  } finally { process.kill = original; }
});

test('a permission error with a live owned group still fails cleanup', async () => {
  const owned = spawnOwnedProcess(process.execPath, ['-e', "process.send('ready');setInterval(()=>{},1000)"], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const closed = once(owned.child, 'close');
  await once(owned.child, 'message');
  const original = process.kill;
  process.kill = function (pid, signal) {
    if (pid === -owned.state.pid) throw denied();
    return original(pid, signal);
  };
  try {
    await assert.rejects(stopOwnedProcess(owned, 50), error => error.code === 'EPERM');
    assert.equal(await liveOwnedGroup(owned.state.pid, 1000), true);
  } finally {
    process.kill = original;
    original(-owned.state.pid, 'SIGKILL');
    await closed;
    assert.equal(await liveOwnedGroup(owned.state.pid, 1000), false);
  }
});
