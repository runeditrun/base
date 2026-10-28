// Push shards and scheduled installer journeys together cover the CLI suite.
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const journeys = new Set(['reference-journey.test.mjs']);
const isolated = ['cli/dependency-setup.test.mjs', 'cli/package-mode.test.mjs'];
export const CLI_SHARDS = 4;
// Whole independent files moved after the first packed run. Their measured
// top-level test totals were 854s and 458s; the original partition timed out.
const moved = {
  '3': ['cli/additive-restore.test.mjs', 'cli/managed-flows.test.mjs', 'cli/legacy-recovery.test.mjs'],
  '4': ['cli/schema-portability.test.mjs', 'cli/generated-portability.test.mjs', 'cli/server-registry.test.mjs'],
};

export async function cliTestFiles({ journey = false } = {}) {
  const files = (await readdir('cli')).filter(name => name.endsWith('.test.mjs')).sort();
  for (const name of journeys) assert.ok(files.includes(name), `Missing CLI journey: ${name}`);
  return files.filter(name => journeys.has(name) === journey).map(name => `cli/${name}`);
}

export async function cliShardPlan() {
  const files = await cliTestFiles();
  for (const file of isolated) assert.ok(files.includes(file), `Missing CLI suite: ${file}`);
  for (const file of Object.values(moved).flat()) assert.ok(files.includes(file), `Missing moved CLI suite: ${file}`);
  const regular = files.filter(file => !isolated.includes(file));
  const groups = Object.fromEntries([1, 2].map(shard => [String(shard), [
    ...regular.filter((file, index) => index % 2 === shard - 1 && !Object.values(moved).flat().includes(file)), isolated[shard - 1],
  ]]));
  Object.assign(groups, moved);
  assert.deepEqual(Object.values(groups).flat().sort(), files, 'CLI CI must cover every push file exactly once');
  return groups;
}

export async function verifyCLIShard(shard, { journey = false } = {}) {
  if (!journey) assert.match(shard ?? '', /^[1-4]$/, `CLI_SHARD must be one of the ${CLI_SHARDS} matrix shards`);
  const files = journey ? await cliTestFiles({ journey }) : (await cliShardPlan())[shard];
  assert.ok(files.length, 'No CLI test files found');
  const started = performance.now();
  const label = journey ? 'journeys' : `shard=${shard}/${CLI_SHARDS}`;
  console.log(`VERIFY_STAGE start verify:cli ${label}`);
  // These fixtures keep their own process-wide runtime setup. Run each alone,
  // after the independent files; packing jobs must not remove that isolation.
  const batches = [files.filter(file => !isolated.includes(file)), ...files.filter(file => isolated.includes(file)).map(file => [file])].filter(batch => batch.length);
  let child, signal, code = 0;
  const cancel = value => { signal ??= value; child?.kill(value); };
  const onTerm = () => cancel('SIGTERM'), onInt = () => cancel('SIGINT');
  process.on('SIGTERM', onTerm); process.on('SIGINT', onInt);
  try {
    for (const batch of batches) {
      if (signal) break;
      child = spawn(process.execPath, [
        'onboarding/queued-entry.mjs', 'verify:cli', '--', process.execPath,
        '--test', `--test-concurrency=${batch.some(file => isolated.includes(file)) ? 1 : 2}`, ...batch,
      ], { stdio: 'inherit' });
      code = await new Promise(resolve => {
        child.once('error', error => { console.error(error.message); resolve(1); });
        child.once('close', code => resolve(code ?? 1));
      });
      child = undefined;
      if (code !== 0) break;
    }
    code = signal === 'SIGINT' ? 130 : signal ? 143 : code;
    console.log(`VERIFY_STAGE end verify:cli ${label} exit=${code} seconds=${((performance.now() - started) / 1000).toFixed(3)}`);
    return code;
  } finally {
    process.off('SIGTERM', onTerm); process.off('SIGINT', onInt);
  }
}
