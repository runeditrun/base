import test from 'node:test';
import assert from 'node:assert/strict';
import { CLI_SHARDS, cliShardPlan, cliTestFiles, partitionCLIFiles } from '../scripts/ci/cli-shard.mjs';

test('CLI shards cover the discovered suite once and keep scheduled journeys separate', async () => {
  const files = await cliTestFiles(), journeys = await cliTestFiles({ journey: true });
  const plan = await cliShardPlan();
  assert.equal(Object.keys(plan).length, CLI_SHARDS);
  assert.ok(Object.values(plan).every(files => files.length));
  assert.deepEqual(Object.values(plan).flat().sort(), files);
  assert.ok(files.includes('cli/dependency-setup.test.mjs'));
  assert.ok(files.includes('cli/package-mode.test.mjs'));
  assert.deepEqual(journeys, ['cli/reference-journey.test.mjs']);
  assert.ok(journeys.every(file => !Object.values(plan).flat().includes(file)));
});

test('a new CLI file is included without rotating the long suites between shards', async () => {
  const files = await cliTestFiles();
  const plan = partitionCLIFiles(files);
  const added = 'cli/aaa-new-suite.test.mjs';
  const expanded = partitionCLIFiles([...files, added]);
  assert.deepEqual(partitionCLIFiles([...files].reverse()), plan, 'discovery order does not affect assignment');
  assert.deepEqual(Object.values(expanded).flat().sort(), [...files, added].sort());
  const long = ['export-import-recovery', 'platform-ledger-leave', 'managed-flows', 'additive-restore', 'dependency-setup', 'generated-portability'];
  const shardOf = (plan, file) => Object.keys(plan).find(shard => plan[shard].includes(file));
  for (const name of long) {
    const file = `cli/${name}.test.mjs`;
    assert.equal(shardOf(expanded, file), shardOf(plan, file), `${file} keeps its shard`);
  }
  assert.notEqual(shardOf(plan, 'cli/export-import-recovery.test.mjs'), shardOf(plan, 'cli/platform-ledger-leave.test.mjs'), 'the two longest suites run on different jobs');
  assert.throws(() => partitionCLIFiles([...files, files[0]]), /must not repeat/);
});
