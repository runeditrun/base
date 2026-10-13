// Real subprocesses used exclusively by the test suite.
import { writeFileSync, renameSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { getPriority } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { identity } from '../identity.mjs';
import { transaction } from '../storage.mjs';
const [mode, file] = process.argv.slice(2);
const recordPids = pids => {
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(pids));
  renameSync(temporary, file);
};
if (mode === 'counter') {
  const owner = await identity();
  try {
    for (let i = 0; i < 8; i++) await transaction(file, owner.info, async state => {
      state.sequence++;
    });
  } finally { await owner.close(); }
} else if (mode === 'gate') {
  const deadline = Date.now() + 60000;
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw Error('Test command was not released');
    await delay(20);
  }
} else if (mode === 'tree') {
  const child = spawn(process.execPath, ['-e',
    "process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000)"],
  { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  process.on('SIGTERM', () => {});
  child.once('message', () => {
    recordPids([process.pid, child.pid]);
    child.disconnect();
  });
  setInterval(() => {}, 1000);
} else if (mode === 'zombie') {
  const child = spawn('/bin/sh', ['-c', 'exit 0'], { detached: true, stdio: 'ignore' });
  recordPids([child.pid]);
  // Hold the parent event loop until cleanup, so it cannot reap this child.
  // Readiness is established by the test polling processInfo, not a timed pause.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
} else if (mode === 'leftover') {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  recordPids([child.pid]);
  child.unref();
} else if (mode === 'nice') {
  writeFileSync(file, String(getPriority()));
} else throw Error('Unknown test worker mode');
