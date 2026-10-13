// Node partitions the complete CLI file set; every assertion stays unchanged.
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';

export async function verifyCLIShard(shard) {
  assert.match(shard ?? '', /^[123]$/, 'CLI_SHARD must be one of the three matrix shards');
  const files = (await readdir('cli')).filter(name => name.endsWith('.test.mjs')).sort().map(name => `cli/${name}`);
  assert.ok(files.length, 'No CLI test files found');
  const started = performance.now();
  console.log(`VERIFY_STAGE start verify:cli shard=${shard}/3`);
  const child = spawn(process.execPath, [
    'onboarding/queued-entry.mjs', 'verify:cli', '--', process.execPath,
    '--test', '--test-concurrency=2', `--test-shard=${shard}/3`, ...files,
  ], { stdio: 'inherit' });
  const onTerm = () => child.kill('SIGTERM'), onInt = () => child.kill('SIGINT');
  process.on('SIGTERM', onTerm); process.on('SIGINT', onInt);
  try {
    const code = await new Promise(resolve => {
      child.once('error', error => { console.error(error.message); resolve(1); });
      child.once('close', code => resolve(code ?? 1));
    });
    console.log(`VERIFY_STAGE end verify:cli shard=${shard}/3 exit=${code} seconds=${((performance.now() - started) / 1000).toFixed(3)}`);
    return code;
  } finally {
    process.off('SIGTERM', onTerm); process.off('SIGINT', onInt);
  }
}
