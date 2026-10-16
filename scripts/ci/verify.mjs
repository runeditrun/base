// CI partitions the same stages used by pnpm verify; product checks stay unchanged.
import assert from 'node:assert/strict';
import { verifyStages } from '../verify-stages.mjs';
import { verify } from '../verify.mjs';
import { CLI_SHARDS, cliShardPlan, verifyCLIShard } from './cli-shard.mjs';
import { MODULE_SHARDS, moduleTestFiles, verifyModuleShard } from './module-shard.mjs';
import { referenceShardPlan, verifyReferenceShard } from './reference-shard.mjs';

const dedicated = ['modules', 'cli', 'reference', 'portability', 'release', 'editor'];
const groups = Object.fromEntries(dedicated.map(name => [name, [`verify:${name}`]]));
groups.foundation = ['verify:foundation', 'verify:publish-check'];
groups['review-harness'] = ['verify:review-harness'];
groups['onboarding-browser'] = ['verify:operator-auth', 'verify:onboarding-browser'];
const assigned = new Set(Object.values(groups).flat());
// New full-verify stages are automatically included in the remaining shard.
groups.launcher = verifyStages.filter(stage => !assigned.has(stage));
// Slow installer/README journeys run on nightly and release tags. The local
// full verify still runs both tiers, with no test or assertion changes.
groups.journeys = [];
const stages = Object.values(groups).flat();
assert.equal(stages.length, new Set(stages).size, 'CI repeats a verify stage');
assert.deepEqual([...stages].sort(), [...verifyStages].sort(), 'CI must cover every full-verify stage');

const group = process.argv[2];
if (group === '--matrix') {
  assert.ok((await moduleTestFiles()).length >= MODULE_SHARDS, 'Each module shard must have test files');
  await cliShardPlan();
  await referenceShardPlan();
  console.log(JSON.stringify({ include: Object.keys(groups)
    .filter(group => group !== 'journeys' || process.env.CI_INCLUDE_JOURNEYS === 'true')
    .flatMap(group => {
      const total = group === 'modules' ? MODULE_SHARDS : group === 'cli' ? CLI_SHARDS : group === 'reference' ? 2 : 0;
      return total ? Array.from({ length: total }, (_, index) => ({ group, shard: index + 1, total })) : [{ group }];
    }) }));
} else {
  assert.ok(Object.hasOwn(groups, group), 'Choose a CI verify group from --matrix');
  console.log(`VERIFY_GROUP ${group} ${groups[group].join(' ')}`);
  if (group === 'journeys') {
    const cli = await verifyCLIShard(undefined, { journey: true });
    const reference = await verifyReferenceShard('nightly');
    process.exitCode = cli || reference;
  } else {
    process.exitCode = group === 'cli'
      ? await verifyCLIShard(process.env.CLI_SHARD)
      : group === 'modules'
        ? await verifyModuleShard(process.env.MODULE_SHARD)
        : group === 'reference'
          ? await verifyReferenceShard(process.env.REFERENCE_SHARD)
          : await verify(groups[group]);
  }
}
