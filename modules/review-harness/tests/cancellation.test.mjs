import { namedSteps, caseRows } from './fold-steps.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { liveOwnedGroup } from '../process-group.mjs';
import { startRuntime } from '../index.mjs';
import { consumer, root, temporary } from './helpers.mjs';

const fixture = join(import.meta.dirname, 'signal-fixture.mjs');
const cli = join(import.meta.dirname, '../cli.mjs');
async function waitForFile(path, exited) {
  const deadline = performance.now() + 25_000;
  while (performance.now() < deadline) {
    if (exited?.()) throw new Error(`CLI exited before reaching phase: ${exited()}`);
    try { return JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(25);
  }
  throw new Error('Signal fixture did not reach the requested phase');
}
function processes() {
  return execFileSync('ps', ['-Ao', 'pid=,ppid=,stat=']).toString().trim().split('\n').map(line => {
    const [pid, parent, state] = line.trim().split(/\s+/);
    return { pid: Number(pid), parent: Number(parent), state };
  });
}
function descendants(pid) {
  const rows = processes(), owned = new Set([pid]);
  let size;
  do { size = owned.size; for (const row of rows) if (owned.has(row.parent)) owned.add(row.pid); } while (size !== owned.size);
  return [...owned];
}
function kill(pid, group = false) {
  try { process.kill(group ? -pid : pid, 'SIGKILL'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}

test("CLI cancellation awaits its real process and browser cleanup at every phase", async t => {
  await caseRows(t, [["CLI cancellation awaits its real process and browser cleanup at every phase", async t => {
  const step = namedSteps(t);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    for (const phase of ['startup', 'fixtures', 'journey', 'signin']) {
      await step(`${signal} during ${phase} awaits cleanup of the real runtime tree and browser`, { timeout: 40_000 }, async t => {
        const directory = await temporary(t, 'review-signal-');
        const receiptPath = join(directory, 'tree.json'), stagePath = join(directory, 'stage.json');
        const start = { cwd: consumer, command: process.execPath, args: [fixture, '{PORT}', receiptPath, phase], readyTimeoutMs: 60_000, stopTimeoutMs: 150 };
        const pending = `async (...args) => { await recordStage({ signal: Boolean(args[1]?.addEventListener) }); await new Promise(() => {}); }`;
        const open = phase === 'signin'
          ? `async (page, signal) => { await recordStage({ signal: Boolean(signal?.addEventListener) }); await new Promise(() => {}); }`
          : `async page => { await recordStage({}); await page.waitForFunction(() => false, null, { timeout: 60_000 }); }`;
        const signedIn = ['journey', 'signin'].includes(phase);
        const config = join(directory, 'config.mjs');
        await writeFile(config, `import { writeFile, rename } from 'node:fs/promises';
  async function recordStage(value) { const path=${JSON.stringify(stagePath)}; await writeFile(path+'.tmp',JSON.stringify(value)); await rename(path+'.tmp',path); }
  export default { start: ${JSON.stringify(start)}, widths: [390,1440],
  ${phase === 'fixtures' ? `fixtures: ${pending},` : ''}
  ${signedIn ? `signIn: { open: ${open} },` : ''}
  routes: [{ name: 'signal', path: '/', signedIn: ${signedIn} }] };`);
        const child = spawn(process.execPath, [cli, '--config', config, '--evidence', join(directory, 'evidence')], { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
        const closed = once(child, 'close');
        let output = '', stderr = '', tree, owned = [];
        child.stdout.on('data', data => { output += data; });
        child.stderr.on('data', data => { stderr += data; });
        t.after(async () => {
          if (!tree) { try { tree = JSON.parse(await readFile(receiptPath, 'utf8')); } catch {} }
          if (tree) kill(tree.runtime, true);
          for (const pid of owned) kill(pid);
          kill(child.pid, true);
          await closed;
        });
        tree = await waitForFile(receiptPath);
        if (phase !== 'startup') await waitForFile(stagePath, () => child.exitCode !== null || child.signalCode !== null ? output : null);
        owned = [...new Set([...descendants(child.pid), tree.runtime, tree.grandchild])];
        child.kill(signal);
        const [code, termination] = await Promise.race([closed, delay(8000, undefined, { ref: false }).then(() => { throw new Error('Cancellation did not finish within its cleanup bound'); })]);
        assert.equal(termination, null, 'CLI handles the signal rather than exiting immediately');
        assert.equal(code, signal === 'SIGINT' ? 130 : 143);
        assert.equal(stderr, '');
        assert.equal(output.trim().split('\n').length, 1);
        assert.equal(await liveOwnedGroup(tree.runtime, 1000), false);
        const remaining = processes().filter(row => owned.includes(row.pid) && !row.state.startsWith('Z'));
        assert.deepEqual(remaining, [], 'no runtime, descendant or Chromium process survives CLI exit');
        await assert.rejects(fetch(`http://127.0.0.1:${tree.port}/health`, { signal: AbortSignal.timeout(500) }));
        if (['fixtures', 'signin'].includes(phase)) assert.equal((await waitForFile(stagePath)).signal, true, 'pending hooks receive cancellation');
        if (signedIn) {
          const report = JSON.parse(await readFile(join(directory, 'evidence/review.json'), 'utf8'));
          assert.equal(report.passed, false);
          assert.ok(report.errors.some(error => error.includes('cancelled')));
        }
      });
    }
  }

  }]]);
})


test('startRuntime honours an already aborted signal before spawning', async t => {
  const directory = await temporary(t);
  const controller = new AbortController();
  controller.abort(new Error('Cancelled before startup'));
  let runtime;
  try {
    await assert.rejects(async () => {
      runtime = await startRuntime({ cwd: root, command: process.execPath, args: [fixture, '{PORT}', join(directory, 'tree.json'), 'fixtures'], logDir: directory, signal: controller.signal, stopTimeoutMs: 150 });
    }, /Cancelled before startup/);
  } finally { await runtime?.stop(); }
});
