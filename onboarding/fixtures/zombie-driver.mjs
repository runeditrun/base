import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createCommands } from '../commands.mjs';
import { readProcessIdentity } from '../process-table.mjs';

let output = '';
const store = await createCommands(process.argv[2], { logs: [] }, { terminal: text => { output += text; } });
try {
 for (const mode of ['zombie', 'live']) {
  output = '';
  const child = store.spawn('Real ' + mode, 'python3', [fileURLToPath(new URL('./zombie-command.py', import.meta.url)), mode]);
  const deadline = Date.now() + 5000;
  while (!output.includes(mode.toUpperCase()) && Date.now() < deadline) await delay(20);
  const pid = Number(new RegExp(mode.toUpperCase() + ' (\\d+)').exec(output)?.[1]);
  assert.ok(pid, output);
  if (mode === 'zombie') {
   while (!(await readProcessIdentity(pid))?.state.startsWith('Z') && Date.now() < deadline) await delay(20);
   assert.ok((await readProcessIdentity(pid))?.state.startsWith('Z'));
  }
  const began = Date.now();
  await store.stop(child);
  const elapsed = Date.now() - began;
  assert.ok(elapsed < 5000, `${mode} cleanup took ${elapsed}ms`);
  if (mode === 'live') assert.ok(elapsed >= 300, 'cleanup did not wait for the living process');
  console.log(`${mode}: pid=${pid} leader=${child.pid} cleanup_ms=${elapsed}`);
 }
} finally { await store.closeCommands(); }
