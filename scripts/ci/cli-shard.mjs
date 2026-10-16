// Push shards and scheduled installer journeys together cover the CLI suite.
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const journeys = new Set(['reference-journey.test.mjs']);

export async function cliTestFiles({ journey = false } = {}) {
  const files = (await readdir('cli')).filter(name => name.endsWith('.test.mjs')).sort();
  for (const name of journeys) assert.ok(files.includes(name), `Missing CLI journey: ${name}`);
  return files.filter(name => journeys.has(name) === journey).map(name => `cli/${name}`);
}

export async function verifyCLIShard(shard, { journey = false } = {}) {
  if (!journey) assert.match(shard ?? '', /^[123]$/, 'CLI_SHARD must be one of the three matrix shards');
  const files = await cliTestFiles({ journey });
  assert.ok(files.length, 'No CLI test files found');
  const started = performance.now();
  const label = journey ? 'journeys' : `shard=${shard}/3`;
  console.log(`VERIFY_STAGE start verify:cli ${label}`);
  const child = spawn(process.execPath, [
    'onboarding/queued-entry.mjs', 'verify:cli', '--', process.execPath,
    '--test', '--test-concurrency=2', ...(journey ? [] : [`--test-shard=${shard}/3`]), ...files,
  ], { stdio: 'inherit' });
  const onTerm = () => child.kill('SIGTERM'), onInt = () => child.kill('SIGINT');
  process.on('SIGTERM', onTerm); process.on('SIGINT', onInt);
  try {
    const code = await new Promise(resolve => {
      child.once('error', error => { console.error(error.message); resolve(1); });
      child.once('close', code => resolve(code ?? 1));
    });
    console.log(`VERIFY_STAGE end verify:cli ${label} exit=${code} seconds=${((performance.now() - started) / 1000).toFixed(3)}`);
    return code;
  } finally {
    process.off('SIGTERM', onTerm); process.off('SIGINT', onInt);
  }
}
