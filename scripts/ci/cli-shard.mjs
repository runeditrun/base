// Push shards and scheduled installer journeys together cover the CLI suite.
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { balanceFiles } from './balance-files.mjs';

const journeys = new Set(['reference-journey.test.mjs']);
const isolated = ['cli/dependency-setup.test.mjs', 'cli/package-mode.test.mjs'];
export const CLI_SHARDS = 4;
// Completed CLI files in Verify 40647697259. Package-mode was cancelled
// during its composed install; reserve a separate 200s batch for it.
const seconds = {
  'cli/additive-restore.test.mjs': 390,
  'cli/agent-verification.test.mjs': 57,
  'cli/ai-deploy.test.mjs': 4,
  'cli/ai-diagnostics.test.mjs': 33,
  'cli/ai-live.test.mjs': 61,
  'cli/archive-integrity.test.mjs': 101,
  'cli/authoring.test.mjs': 78,
  'cli/browser-runtime.test.mjs': 2,
  'cli/build-private.test.mjs': 4,
  'cli/business-connect.test.mjs': 53,
  'cli/business-scan.test.mjs': 7,
  'cli/cli.test.mjs': 38,
  'cli/command-failure.test.mjs': 2,
  'cli/companion.test.mjs': 3,
  'cli/contract.test.mjs': 39,
  'cli/declared-settings.test.mjs': 12,
  'cli/demo-isolation.test.mjs': 72,
  'cli/demo-plan.test.mjs': 30,
  'cli/demo-remove.test.mjs': 17,
  'cli/dependencies.test.mjs': 4,
  'cli/dependency-setup.test.mjs': 415,
  'cli/deploy-dry-run.test.mjs': 6,
  'cli/deploy-hooks.test.mjs': 67,
  'cli/deploy-local-secrets.test.mjs': 3,
  'cli/deploy-mail-binding.test.mjs': 8,
  'cli/deploy-migration-budget.test.mjs': 17,
  'cli/deploy-name.test.mjs': 24,
  'cli/deploy-origin.test.mjs': 2,
  'cli/deploy-owner-session.test.mjs': 4,
  'cli/deploy-owner.test.mjs': 65,
  'cli/deploy-pagination.test.mjs': 5,
  'cli/deploy-pnpm.test.mjs': 7,
  'cli/deploy-product.test.mjs': 10,
  'cli/deploy-redaction.test.mjs': 2,
  'cli/deploy-remove.test.mjs': 21,
  'cli/deploy-setup.test.mjs': 5,
  'cli/deploy.test.mjs': 1,
  'cli/deployment-record.test.mjs': 4,
  'cli/dev-data-portability.test.mjs': 110,
  'cli/dev-exclusion.test.mjs': 35,
  'cli/dev-migrations.test.mjs': 82,
  'cli/doctor-custody.test.mjs': 1,
  'cli/doctor-diagnostics.test.mjs': 4,
  'cli/export-import-recovery.test.mjs': 759,
  'cli/generated-portability.test.mjs': 211,
  'cli/hosted-output.test.mjs': 12,
  'cli/hosted-portability.test.mjs': 45,
  'cli/import-kit-package.test.mjs': 7,
  'cli/import-safety.test.mjs': 86,
  'cli/kept-settings.test.mjs': 1,
  'cli/legacy-recovery.test.mjs': 237,
  'cli/local-preflight.test.mjs': 53,
  'cli/managed-flows.test.mjs': 356,
  'cli/native-migration-preflight.test.mjs': 27,
  'cli/node-runtime.test.mjs': 6,
  'cli/output.test.mjs': 16,
  'cli/package-mode.test.mjs': 200,
  'cli/placeholder-mark.test.mjs': 21,
  'cli/platform-ledger-leave.test.mjs': 507,
  'cli/port.test.mjs': 6,
  'cli/portability-policy.test.mjs': 131,
  'cli/production-auth.test.mjs': 57,
  'cli/queue-supervisor.test.mjs': 1,
  'cli/queue-timeout.test.mjs': 16,
  'cli/queue-wait.test.mjs': 37,
  'cli/release-github.test.mjs': 116,
  'cli/release-workflow.test.mjs': 97,
  'cli/release.test.mjs': 8,
  'cli/scheduled.test.mjs': 3,
  'cli/schema-portability.test.mjs': 246,
  'cli/server-registry.test.mjs': 156,
  'cli/setup-name.test.mjs': 10,
  'cli/signin.test.mjs': 3,
  'cli/site-flows.test.mjs': 107,
  'cli/site-search.test.mjs': 12,
  'cli/transfer-prepare.test.mjs': 59,
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
    // Linux 3: deployment + container; Linux 4: portability;
    // Linux 6: release + rer; Linux 8: the remaining small stages.
    overhead: { '1': 40, '2': 527, '3': 594, '4': 129 },
  });
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
