// Use the same file glob and Node options as verify:modules, split across CI jobs.
import assert from 'node:assert/strict';
import { glob, readFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { balanceFiles } from './balance-files.mjs';
import { dirname, join } from 'node:path';

export const MODULE_SHARDS = 3;
const browserFiles = ['modules/demo/tests/label.test.ts', 'modules/demo/tests/navigation.test.ts'];
// Completed module files in main Verify 40641204597, recalibrated by the stage totals
// in Verify 40656065286. Start long files before the round-robin tail.
const seconds = {
  'modules/ai/tests/all.test.ts': 4,
  'modules/demo/tests/effects.test.ts': 1,
  'modules/demo/tests/label.test.ts': 6,
  'modules/demo/tests/navigation.test.ts': 5,
  'modules/editor/tests/lifecycle.test.ts': 3,
  'modules/editor/tests/owner-replacement.test.ts': 2,
  'modules/editor/tests/provenance.test.ts': 4,
  'modules/egress-service/tests/account-ownership.test.ts': 4,
  'modules/egress-service/tests/contracts.test.ts': 1,
  'modules/egress-service/tests/delivery.test.ts': 1,
  'modules/egress-service/tests/doh.test.ts': 2,
  'modules/egress-service/tests/hybrid.test.ts': 2,
  'modules/egress-service/tests/service.test.ts': 9,
  'modules/erasure/tests/erasure.test.ts': 17,
  'modules/erasure/tests/rate.test.ts': 6,
  'modules/erasure/tests/regressions.test.ts': 24,
  'modules/import-kit/tests/api-numeric-lexemes.test.ts': 3,
  'modules/import-kit/tests/canonical-buffer.test.ts': 2,
  'modules/import-kit/tests/canonical-large-string.test.ts': 4,
  'modules/import-kit/tests/canonical-operation-cache.test.ts': 4,
  'modules/import-kit/tests/codec-creation.test.ts': 13,
  'modules/import-kit/tests/commit-boundary.test.ts': 5,
  'modules/import-kit/tests/d1-baseline.test.ts': 7,
  'modules/import-kit/tests/d1-erasure-originals.test.ts': 76,
  'modules/import-kit/tests/d1-erasure-steps.test.ts': 300,
  'modules/import-kit/tests/d1-integrity-undo.test.ts': 251,
  'modules/import-kit/tests/d1-legacy-stream-origin.test.ts': 15,
  'modules/import-kit/tests/d1-mixed-script-transfer.test.ts': 41,
  'modules/import-kit/tests/d1-normalized-worker.test.ts': 2,
  'modules/import-kit/tests/d1-origin-depth.test.ts': 33,
  'modules/import-kit/tests/d1-original-name-custody.test.ts': 27,
  'modules/import-kit/tests/d1-preparation-races.test.ts': 19,
  'modules/import-kit/tests/d1-preparations.test.ts': 41,
  'modules/import-kit/tests/d1-preserved-provider.test.ts': 61,
  'modules/import-kit/tests/d1-preserved-scale.test.ts': 135,
  'modules/import-kit/tests/d1-provenance-transport.test.ts': 109,
  'modules/import-kit/tests/d1-published-return.test.ts': 53,
  'modules/import-kit/tests/d1-read-only.test.ts': 265,
  'modules/import-kit/tests/d1-stream-custody.test.ts': 15,
  'modules/import-kit/tests/d1-undo-report-staging.test.ts': 121,
  'modules/import-kit/tests/d1/bounds.test.ts': 2,
  'modules/import-kit/tests/d1/create-budget.test.ts': 5,
  'modules/import-kit/tests/d1/creation-remaining-budget.test.ts': 12,
  'modules/import-kit/tests/d1/custody-capacity.test.ts': 3,
  'modules/import-kit/tests/d1/custody-packing.test.ts': 27,
  'modules/import-kit/tests/d1/engine.test.ts': 45,
  'modules/import-kit/tests/d1/erasure-encoding.test.ts': 2,
  'modules/import-kit/tests/d1/erasure.test.ts': 237,
  'modules/import-kit/tests/d1/export-consistency.test.ts': 11,
  'modules/import-kit/tests/d1/flat-reversal.test.ts': 27,
  'modules/import-kit/tests/d1/guard-depth.test.ts': 6,
  'modules/import-kit/tests/d1/plan-chunks.test.ts': 5,
  'modules/import-kit/tests/d1/preflight.test.ts': 4,
  'modules/import-kit/tests/d1/preparation-steps.test.ts': 85,
  'modules/import-kit/tests/d1/request-limit.test.ts': 31,
  'modules/import-kit/tests/d1/return-budget.test.ts': 28,
  'modules/import-kit/tests/d1/reuse-owner.test.ts': 9,
  'modules/import-kit/tests/d1/reused-claim-validity.test.ts': 19,
  'modules/import-kit/tests/d1/reused-inventory.test.ts': 14,
  'modules/import-kit/tests/d1/scale.test.ts': 47,
  'modules/import-kit/tests/d1/set-guards.test.ts': 38,
  'modules/import-kit/tests/d1/stream-codec.test.ts': 13,
  'modules/import-kit/tests/d1/streams.test.ts': 100,
  'modules/import-kit/tests/d1/worker.test.ts': 1,
  'modules/import-kit/tests/dictionary-boundaries.test.ts': 4,
  'modules/import-kit/tests/dictionary-canonical.test.ts': 2,
  'modules/import-kit/tests/dictionary-json-strings.test.ts': 3,
  'modules/import-kit/tests/door-intake.test.ts': 23,
  'modules/import-kit/tests/door-large-source.test.ts': 207,
  'modules/import-kit/tests/door.test.ts': 871,
  'modules/import-kit/tests/fixture-layout.test.ts': 2,
  'modules/import-kit/tests/import-kit.test.ts': 2,
  'modules/import-kit/tests/mapped-validation.test.ts': 2,
  'modules/import-kit/tests/operation-integrity.test.ts': 3,
  'modules/import-kit/tests/original-custody.test.ts': 2,
  'modules/import-kit/tests/original-name-bytes.test.ts': 14,
  'modules/import-kit/tests/plan-cap-d1.test.ts': 26,
  'modules/import-kit/tests/plan-cap-sqlite.test.ts': 4,
  'modules/import-kit/tests/plan-mapping-size.test.ts': 7,
  'modules/import-kit/tests/plan-size-budget.test.ts': 4,
  'modules/import-kit/tests/plan-size-cache.test.ts': 2,
  'modules/import-kit/tests/plan-size-safe-aggregate.test.ts': 3,
  'modules/import-kit/tests/plan-size-values.test.ts': 2,
  'modules/import-kit/tests/plan-size.test.ts': 10,
  'modules/import-kit/tests/provenance-integrity.test.ts': 4,
  'modules/import-kit/tests/readers.test.ts': 20,
  'modules/import-kit/tests/reviewed-source-native.test.ts': 4,
  'modules/import-kit/tests/reviewed-source.test.ts': 4,
  'modules/import-kit/tests/staging.test.ts': 1085,
  'modules/import-kit/tests/status.test.ts': 2,
  'modules/import-kit/tests/stream-planner-parity.test.ts': 3,
  'modules/import-kit/tests/stream-retention.test.ts': 2,
  'modules/import-kit/tests/stream-review-integrity.test.ts': 4,
  'modules/import-kit/tests/zendesk.test.ts': 2,
  'modules/integrations/tests/integration.test.ts': 4,
  'modules/mail/tests/all.test.ts': 47,
  'modules/operator-auth/tests/conformance.test.ts': 4,
  'modules/operator-auth/tests/policy.test.ts': 2,
  'modules/sendgrid-email/tests/equivalence.test.ts': 3,
  'modules/sendgrid-email/tests/sender.test.ts': 2,
};


async function expandD1Wrapper(wrapper) {
  const source = await readFile(wrapper, 'utf8'), files = [];
  // This wrapper only collects independent suites. Refuse new executable code
  // instead of silently omitting behavior when CI runs its imports directly.
  const statement = /\s*import\s+(['"])(\.\/[\w./-]+\.test\.ts)\1\s*;/gy;
  let consumed = 0, match;
  while ((match = statement.exec(source))) {
    const file = join(dirname(wrapper), match[2]);
    assert.ok(file.startsWith(`${dirname(wrapper)}/d1/`), 'D1 wrapper imports must remain inside its d1 test directory');
    assert.ok((await stat(file)).isFile(), `D1 wrapper import is not a test file: ${file}`);
    files.push(file);
    consumed = statement.lastIndex;
  }
  assert.ok(files.length && !source.slice(consumed).trim(), 'D1 CI expansion requires a wrapper containing only static test imports');
  return files;
}

export async function moduleTestFiles() {
  const files = [];
  for await (const file of glob('modules/*/tests/*.test.ts')) files.push(file);
  const wrapper = 'modules/import-kit/tests/d1.test.ts';
  assert.ok(files.includes(wrapper), 'The D1 test wrapper must remain in the modules test inventory');
  const effective = files.filter(file => file !== wrapper).concat(await expandD1Wrapper(wrapper));
  assert.equal(effective.length, new Set(effective).size, 'Module CI must not repeat a test file');
  return effective.sort();
}

export async function verifyModuleShard(shard) {
  assert.match(shard ?? '', /^[1-3]$/, `MODULE_SHARD must be one of the ${MODULE_SHARDS} matrix shards`);
  const files = (await moduleShardPlan())[shard];
  const started = performance.now();
  console.log(`VERIFY_STAGE start verify:modules shard=${shard}/${MODULE_SHARDS}`);
  const child = spawn(process.execPath, [
    'onboarding/queued-entry.mjs', 'verify:modules', '--', process.execPath,
    // The original wrapper initializes the public D1 entry in engine.test.ts
    // before its internal utility suites. Keep that context in each worker.
    '--import', './modules/import-kit/src/d1/index.ts',
    '--max-old-space-size=4096', 'scripts/ci/run-files.mjs', '2', ...files,
  ], { stdio: 'inherit' });
  const onTerm = () => child.kill('SIGTERM'), onInt = () => child.kill('SIGINT');
  process.on('SIGTERM', onTerm); process.on('SIGINT', onInt);
  try {
    const code = await new Promise(resolve => {
      child.once('error', error => { console.error(error.message); resolve(1); });
      child.once('close', code => resolve(code ?? 1));
    });
    console.log(`VERIFY_STAGE end verify:modules shard=${shard}/${MODULE_SHARDS} exit=${code} seconds=${((performance.now() - started) / 1000).toFixed(3)}`);
    return code;
  } finally {
    process.off('SIGTERM', onTerm); process.off('SIGINT', onInt);
  }
}

export async function moduleShardPlan() {
  const files = await moduleTestFiles();
  assert.ok(files.length >= MODULE_SHARDS, 'Each module shard must have test files');
  for (const file of browserFiles) assert.ok(files.includes(file), `Missing module browser suite: ${file}`);
  const groups = balanceFiles(files, {
    seconds, fallback: 3,
    // Retain the verified file packing. Partition 1 keeps its former 109s
    // auxiliary budget as margin after that work moves to spare Linux 2.
    // Partition 1: Linux 1, module files only; 109s packing margin.
    // Partition 2: Linux 2, typecheck:modules, release, publish-check, onboarding, review-harness, job-queue, operations, schema, mail-relay.
    // Partition 3: Linux 7, .
    overhead: { '1': 109, '2': 909, '3': 0 },
    fixed: { '1': browserFiles },
  });
  assert.ok(Object.values(groups).every(files => files.length), 'Each module shard must have test files');
  assert.deepEqual(Object.values(groups).flat().sort(), files, 'Module CI must cover every push file exactly once');
  return groups;
}
