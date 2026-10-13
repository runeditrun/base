import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { availableParallelism } from 'node:os';
import { verifyStages } from './verify-stages.mjs';

// Each stage runs at most two test files. Keep room for native runtimes,
// and reduce stage concurrency on smaller machines.
export async function verify(stages = verifyStages, { cwd = process.cwd() } = {}) {
  const defaultWorkers = Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)));
  const workerLimit = process.env.RER_VERIFY_WORKERS;
  if (workerLimit !== undefined &&
      (!/^[0-9]+$/.test(workerLimit) || !Number.isSafeInteger(Number(workerLimit)) || Number(workerLimit) < 1)) {
    console.error('RER_VERIFY_WORKERS must be a positive integer (for example, RER_VERIFY_WORKERS=1 pnpm verify); unset it to use automatic concurrency.');
    return 1;
  }
  const workers = workerLimit === undefined ? defaultWorkers : Math.min(defaultWorkers, Number(workerLimit));
  console.log(`VERIFY_WORKERS ${workers}`);
  const active = new Set();
  let next = 0, failed = false, signal;
  const cancel = value => {
    signal ??= value;
    for (const child of active) child.kill(value);
  };
  const onTerm = () => cancel('SIGTERM'), onInt = () => cancel('SIGINT');
  process.on('SIGTERM', onTerm); process.on('SIGINT', onInt);
  async function stage(name) {
    const start = performance.now();
    console.log(`VERIFY_STAGE start ${name}`);
    const child = spawn('pnpm', ['run', name], { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    active.add(child);
    const readers = [child.stdout, child.stderr].map(stream => {
      const lines = createInterface({ input: stream });
      lines.on('line', line => {
        // Release consumers read the reporters' complete numeric summary lines.
        // Keep those unchanged while attributing other output to its stage.
        const plain = stripVTControlCharacters(line);
        const summary = /^(?:ℹ|#)[ \t]+(?:tests|pass|fail|skipped|cancelled|todo)[ \t]+\d+[ \t]*$/.test(plain) ||
          /^ {2}\d+ (?:passed \([^)]*\)|failed|skipped|flaky|interrupted|did not run)[ \t]*$/.test(plain);
        console.log(summary ? line : `[${name}] ${line}`);
      });
      return lines;
    });
    const code = await new Promise(resolve => {
      child.once('error', error => { console.error(`[${name}] ${error.message}`); resolve(1); });
      child.once('close', (code, childSignal) => resolve(code ?? (childSignal ? 1 : 0)));
    });
    active.delete(child);
    for (const reader of readers) reader.close();
    console.log(`VERIFY_STAGE end ${name} exit=${code} seconds=${((performance.now() - start) / 1000).toFixed(3)}`);
    if (code !== 0) failed = true;
  }
  async function worker() {
    while (next < stages.length && !signal) await stage(stages[next++]);
  }
  try {
    await Promise.all(Array.from({ length: workers }, worker));
    return signal === 'SIGINT' ? 130 : signal ? 143 : failed ? 1 : 0;
  } finally {
    process.off('SIGTERM', onTerm); process.off('SIGINT', onInt);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await verify();
}
