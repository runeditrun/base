// Push shards and scheduled installer journeys together cover the CLI suite.
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { balanceFiles } from './balance-files.mjs';

const journeys = new Set(['reference-journey.test.mjs']);
const isolated = ['cli/dependency-setup.test.mjs', 'cli/package-mode.test.mjs'];
export const CLI_SHARDS = 4;
// CLI file weights from Verify 40647697259, recalibrated by each packed
// stage in Verify 40656065286; isolated batches retain their own budget.
const seconds = {
  'cli/additive-restore.test.mjs': 357,
  'cli/agent-verification.test.mjs': 66,
  'cli/ai-deploy.test.mjs': 4,
  'cli/ai-diagnostics.test.mjs': 31,
  'cli/ai-live.test.mjs': 57,
  'cli/archive-integrity.test.mjs': 93,
  'cli/authoring.test.mjs': 73,
  'cli/browser-runtime.test.mjs': 2,
  'cli/build-private.test.mjs': 5,
  'cli/business-connect.test.mjs': 50,
  'cli/business-scan.test.mjs': 7,
  'cli/cli.test.mjs': 36,
  'cli/command-failure.test.mjs': 2,
  'cli/companion.test.mjs': 3,
  'cli/contract.test.mjs': 36,
  'cli/declared-settings.test.mjs': 12,
  'cli/demo-isolation.test.mjs': 66,
  'cli/demo-plan.test.mjs': 31,
  'cli/demo-remove.test.mjs': 20,
  'cli/dependencies.test.mjs': 5,
  'cli/dependency-setup.test.mjs': 380,
  'cli/deploy-dry-run.test.mjs': 6,
  'cli/deploy-hooks.test.mjs': 77,
  'cli/deploy-local-secrets.test.mjs': 3,
  'cli/deploy-mail-binding.test.mjs': 7,
  'cli/deploy-migration-budget.test.mjs': 16,
  'cli/deploy-name.test.mjs': 22,
  'cli/deploy-origin.test.mjs': 2,
  'cli/deploy-owner-session.test.mjs': 4,
  'cli/deploy-owner.test.mjs': 67,
  'cli/deploy-pagination.test.mjs': 5,
  'cli/deploy-pnpm.test.mjs': 7,
  'cli/deploy-product.test.mjs': 9,
  'cli/deploy-redaction.test.mjs': 2,
  'cli/deploy-remove.test.mjs': 22,
  'cli/deploy-setup.test.mjs': 6,
  'cli/deploy.test.mjs': 1,
  'cli/deployment-record.test.mjs': 4,
  'cli/describe-effects.test.mjs': 6,
  'cli/dev-data-portability.test.mjs': 127,
  'cli/dev-exclusion.test.mjs': 36,
  'cli/dev-migrations.test.mjs': 85,
  'cli/doctor-custody.test.mjs': 1,
  'cli/doctor-diagnostics.test.mjs': 4,
  'cli/export-import-recovery.test.mjs': 709,
  'cli/generated-portability.test.mjs': 197,
  'cli/hosted-output.test.mjs': 14,
  'cli/hosted-portability.test.mjs': 52,
  'cli/import-kit-package.test.mjs': 6,
  'cli/import-safety.test.mjs': 89,
  'cli/kept-settings.test.mjs': 1,
  'cli/legacy-recovery.test.mjs': 274,
  'cli/local-preflight.test.mjs': 49,
  'cli/managed-flows.test.mjs': 326,
  'cli/native-migration-preflight.test.mjs': 25,
  'cli/node-runtime.test.mjs': 6,
  'cli/output.test.mjs': 17,
  'cli/package-mode.test.mjs': 207,
  'cli/placeholder-mark.test.mjs': 24,
  'cli/platform-ledger-leave.test.mjs': 474,
  'cli/port.test.mjs': 5,
  'cli/portability-policy.test.mjs': 136,
  'cli/production-auth.test.mjs': 59,
  'cli/queue-supervisor.test.mjs': 1,
  'cli/queue-timeout.test.mjs': 15,
  'cli/queue-wait.test.mjs': 43,
  'cli/release-github.test.mjs': 106,
  'cli/release-workflow.test.mjs': 91,
  'cli/release.test.mjs': 7,
  'cli/scheduled.test.mjs': 3,
  'cli/schema-portability.test.mjs': 284,
  'cli/server-proxy.test.mjs': 5,
  'cli/server-registry.test.mjs': 162,
  'cli/setup-name.test.mjs': 10,
  'cli/signin.test.mjs': 3,
  'cli/site-flows.test.mjs': 124,
  'cli/site-search.test.mjs': 14,
  'cli/transfer-prepare.test.mjs': 54,
  'cli/verify-ci.test.mjs': 1,
};

export async function cliTestFiles({ journey = false } = {}) {
  const files = (await readdir('cli')).filter(name => name.endsWith('.test.mjs')).sort();
  for (const name of journeys) assert.ok(files.includes(name), `Missing CLI journey: ${name}`);
  return files.filter(name => journeys.has(name) === journey).map(name => `cli/${name}`);
}

export async function cliShardPlan() {
  const files = await cliTestFiles();
  for (const file of isolated) assert.ok(files.includes(file), `Missing CLI suite: ${file}`);
  const groups = balanceFiles(files, {
    seconds, fallback: 5, isolated,
    // Keep the measured file packing while Linux 3 takes reference/auxiliary
    // work in its observed 12:47 job. The packing weights overestimated it.
    // Partition 1: Linux 3, added work fills measured spare capacity.
    // Partition 2: Linux 4, owner-claim.
    // Partition 3: Linux 6, authoring, rer.
    // Keep 90s of extra cold native setup margin on Linux 8.
    overhead: { '1': 0, '2': 20, '3': 385, '4': 1145 },
    fixed: { '4': ['cli/describe-effects.test.mjs'] },
  });
  // Linux 4 still had only 19s to the 22-minute gate in 40661725807.
  // Move these independent ~2-minute files into Linux 3's measured spare time.
  const offload = ['cli/site-flows.test.mjs', 'cli/portability-policy.test.mjs'];
  for (const file of offload) assert.ok(groups['2'].includes(file), 'Revisit the measured CLI offload when file packing changes');
  groups['2'] = groups['2'].filter(file => !offload.includes(file));
  groups['1'].push(...offload);
  groups['1'].sort((a, b) => (seconds[b] ?? 5) - (seconds[a] ?? 5) || a.localeCompare(b));
  assert.ok(Object.values(groups).every(files => files.length), 'Each CLI shard must have test files');
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
        'scripts/ci/run-files.mjs', batch.some(file => isolated.includes(file)) ? '1' : '2', ...batch,
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
