import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createQueue } from '../index.mjs';
import { processInfo, stopGroup } from '../processes.mjs';

export const cli = new URL('../cli.mjs', import.meta.url).pathname;
export const worker = new URL('./worker.mjs', import.meta.url).pathname;
export const enough = () => ({ load: 0, availableMemoryBytes: 1024 ** 4 });
export async function setup(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'rer-queue-test-'));
  const queue = await createQueue({ directory, env: {}, slots: 1, pollMs: 20,
    killGraceMs: 30, sampler: enough, ...options });
  t.after(async () => { await queue.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, queue };
}
export async function until(probe, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await probe(); if (result) return result; await delay(25); }
  throw Error('Timed out waiting for test condition');
}
export function client(t, directory, args, options = {}) {
  const child = spawn(process.execPath, [options.entrypoint ?? cli, ...args], { ...options,
    env: { ...process.env, RER_JOBS_DIR: directory, RER_JOBS_SLOTS: '1',
      RER_JOBS_LOAD_THRESHOLD: '100000', RER_JOBS_MIN_FREE_MEMORY_BYTES: '0',
      RER_JOBS_POLL_MS: '30', RER_JOBS_KILL_GRACE_MS: '80', ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await done;
    try {
      const state = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
      for (const job of state.running) await stopGroup(job.owner, 30, job.membership);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  });
  return { child, done };
}
export async function noLivePids(pids) {
  return (await Promise.all(pids.map(processInfo))).every(info => !info || info.zombie);
}
