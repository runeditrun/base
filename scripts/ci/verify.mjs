// CI partitions the same stages used by pnpm verify; product checks stay unchanged.
import assert from 'node:assert/strict';
import { verifyStages } from '../verify-stages.mjs';
import { verify } from '../verify.mjs';
import { verifyCLIShard } from './cli-shard.mjs';

const dedicated = ['modules', 'cli', 'reference', 'portability', 'release', 'editor'];
const groups = Object.fromEntries(dedicated.map(name => [name, [`verify:${name}`]]));
groups.foundation = ['verify:foundation', 'verify:publish-check'];
groups['review-harness'] = ['verify:review-harness'];
groups['onboarding-browser'] = ['verify:operator-auth', 'verify:onboarding-browser'];
const assigned = new Set(Object.values(groups).flat());
// New full-verify stages are automatically included in the remaining shard.
groups.launcher = verifyStages.filter(stage => !assigned.has(stage));
const stages = Object.values(groups).flat();
assert.equal(stages.length, new Set(stages).size, 'CI repeats a verify stage');
assert.deepEqual([...stages].sort(), [...verifyStages].sort(), 'CI must cover every full-verify stage');

const group = process.argv[2];
if (group === '--matrix') {
  console.log(JSON.stringify({ include: Object.keys(groups).flatMap(group =>
    group === 'cli' ? [1, 2, 3].map(shard => ({ group, shard })) : [{ group }]) }));
} else {
  assert.ok(Object.hasOwn(groups, group), 'Choose a CI verify group from --matrix');
  console.log(`VERIFY_GROUP ${group} ${groups[group].join(' ')}`);
  process.exitCode = group === 'cli'
    ? await verifyCLIShard(process.env.CLI_SHARD)
    : await verify(groups[group]);
}
