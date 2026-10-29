// Push shards and scheduled installer journeys together cover the CLI suite.
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const journeys = new Set(['reference-journey.test.mjs']);
export const CLI_SHARDS = 5;

// Coarse scheduling costs for the long suites, in seconds. These are not
// deadlines: every discovered file still runs, including new, unmeasured files.
// Alphabetical modulo sharding moved almost the entire suite when a file was
// added, and left two jobs mostly idle. Spread the work across all five jobs.
const costs = {
  'export-import-recovery': 720, 'platform-ledger-leave': 620,
  'managed-flows': 500, 'additive-restore': 490, 'dependency-setup': 465,
  'generated-portability': 465, 'agent-door-bridges': 255,
  'legacy-ledger-portability': 235, 'server-registry': 220, 'legacy-recovery': 210,
  'release-github': 150, 'schema-portability': 145, 'agent-door-hooks': 135,
  'site-flows': 125, 'dev-data-portability': 125, 'business-connect': 120,
  'portability-policy': 115, 'authoring': 105, 'archive-integrity': 105,
  'demo-isolation': 95, 'agent-door-fixtures': 80, 'agent-door': 80,
  'release-workflow': 80, 'package-mode': 80, 'dev-migrations': 75,
  'import-safety': 75, 'deploy-owner': 70, 'deploy-hooks': 60,
  'ai-live': 55, 'deploy-name': 55, 'production-auth': 55,
  'transfer-prepare': 50, 'hosted-portability': 45, 'local-preflight': 45,
  'queue-wait': 45, 'agent-door-subset': 40, 'cli': 40, 'contract': 40,
  'dev-exclusion': 40, 'agent-verification': 35,
};
const cost = file => costs[file.replace(/^cli\//, '').replace(/\.test\.mjs$/, '')] ?? 15;

export function partitionCLIFiles(files) {
  assert.equal(files.length, new Set(files).size, 'CLI CI must not repeat a test file');
  const groups = Array.from({ length: CLI_SHARDS }, () => []);
  const loads = groups.map(() => 0);
  // Assign long files first so a new short suite cannot rotate their shards.
  // Node retains its normal file ordering and two-file concurrency at runtime.
  for (const file of [...files].sort((a, b) => cost(b) - cost(a) || a.localeCompare(b))) {
    const index = loads.indexOf(Math.min(...loads));
    groups[index].push(file);
    loads[index] += cost(file);
  }
  assert.ok(groups.every(group => group.length), 'Each CLI shard must have test files');
  assert.deepEqual(groups.flat().sort(), [...files].sort(), 'CLI CI must cover every push file exactly once');
  return Object.fromEntries(groups.map((files, index) => [String(index + 1), files]));
}

export async function cliTestFiles({ journey = false } = {}) {
  const files = (await readdir('cli')).filter(name => name.endsWith('.test.mjs')).sort();
  for (const name of journeys) assert.ok(files.includes(name), `Missing CLI journey: ${name}`);
  return files.filter(name => journeys.has(name) === journey).map(name => `cli/${name}`);
}

export async function cliShardPlan() {
  return partitionCLIFiles(await cliTestFiles());
}

export async function verifyCLIShard(shard, { journey = false } = {}) {
  if (!journey) assert.match(shard ?? '', /^[1-5]$/, `CLI_SHARD must be one of the ${CLI_SHARDS} matrix shards`);
  const files = journey ? await cliTestFiles({ journey }) : (await cliShardPlan())[shard];
  assert.ok(files.length, 'No CLI test files found');
  const started = performance.now();
  const label = journey ? 'journeys' : `shard=${shard}/${CLI_SHARDS}`;
  console.log(`VERIFY_STAGE start verify:cli ${label}`);
  const child = spawn(process.execPath, [
    'onboarding/queued-entry.mjs', 'verify:cli', '--', process.execPath,
    '--test', '--test-concurrency=2', ...files,
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
