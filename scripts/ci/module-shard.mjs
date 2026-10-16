// Use the same file glob and Node options as verify:modules, split across CI jobs.
import assert from 'node:assert/strict';
import { glob } from 'node:fs/promises';
import { spawn } from 'node:child_process';

export async function moduleTestFiles() {
  const files = [];
  for await (const file of glob('modules/*/tests/*.test.ts')) files.push(file);
  return files.sort();
}

export async function verifyModuleShard(shard) {
  assert.match(shard ?? '', /^[123]$/, 'MODULE_SHARD must be one of the three matrix shards');
  const files = await moduleTestFiles();
  assert.ok(files.length >= 3, 'Each module shard must have test files');
  const started = performance.now();
  console.log(`VERIFY_STAGE start verify:modules shard=${shard}/3`);
  const child = spawn(process.execPath, [
    'onboarding/queued-entry.mjs', 'verify:modules', '--', process.execPath,
    '--max-old-space-size=4096', '--test', '--test-concurrency=2', `--test-shard=${shard}/3`, ...files,
  ], { stdio: 'inherit' });
  const onTerm = () => child.kill('SIGTERM'), onInt = () => child.kill('SIGINT');
  process.on('SIGTERM', onTerm); process.on('SIGINT', onInt);
  try {
    const code = await new Promise(resolve => {
      child.once('error', error => { console.error(error.message); resolve(1); });
      child.once('close', code => resolve(code ?? 1));
    });
    console.log(`VERIFY_STAGE end verify:modules shard=${shard}/3 exit=${code} seconds=${((performance.now() - started) / 1000).toFixed(3)}`);
    return code;
  } finally {
    process.off('SIGTERM', onTerm); process.off('SIGINT', onInt);
  }
}
