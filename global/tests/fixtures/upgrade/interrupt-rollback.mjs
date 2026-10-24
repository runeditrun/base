import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export async function interruptRollback(f, args, boundary, { acceptLegacy = false } = {}) {
 const control = join(f.directory, 'rollback-control.json'), reached = join(f.directory, 'rollback-reached.json');
 const child = f.start(args, { nodeArgs: ['--import', fileURLToPath(new URL('./rollback-boundary.mjs', import.meta.url))],
  env: { ...f.env, RER_ROLLBACK_PROBE: control } });
 const pid = child.pid;
 await writeFile(control, JSON.stringify({ pid, checkout: f.root, boundary, reached, acceptLegacy }));
 let ended = false;
 child.done.finally(() => { ended = true; });
 try {
  const deadline = Date.now() + 15 * 60_000;
  let observation;
  while (Date.now() < deadline) {
   observation = await readFile(reached, 'utf8').then(JSON.parse, error => { if (error.code !== 'ENOENT') throw error; });
   if (observation) break;
   assert.equal(ended, false, 'Updater exited before the requested rollback boundary; subprocess output withheld');
   await delay(50);
  }
  assert.ok(observation, 'Updater did not reach the requested rollback boundary');
  assert.equal(observation.pid, pid);
  assert.equal(observation.boundary, boundary);
  if (!acceptLegacy) assert.equal(observation.stage, 'rolling_back');
  child.kill('SIGKILL');
  await child.done;
  assert.equal(child.signalCode, 'SIGKILL');
  return observation;
 } finally {
  if (!ended) { child.kill('SIGKILL'); await child.done; }
  const { rm } = await import('node:fs/promises');
  await rm(control, { force: true }); await rm(reached, { force: true });
 }
}
