// CI runs the same stages as pnpm verify, in two jobs: the node and python tests, and the reference seed.
import assert from 'node:assert/strict';
import { verifyStages } from '../verify-stages.mjs';
import { verify } from '../verify.mjs';
import { verifyReference } from './reference-shard.mjs';

const groups = { tests: ['verify:tests', 'verify:publish-check'], reference: ['verify:reference'] };
assert.deepEqual(Object.values(groups).flat().sort(), [...verifyStages].sort(), 'CI must cover every full-verify stage once');

const group = process.argv[2];
if (group === '--matrix') {
  console.log(JSON.stringify({ include: Object.keys(groups).map(group => ({ group })) }));
} else {
  assert.ok(Object.hasOwn(groups, group), 'Choose a CI verify group from --matrix');
  console.log(`VERIFY_GROUP ${group} ${groups[group].join(' ')}`);
  process.exitCode = group === 'reference' ? await verifyReference() : await verify(groups[group]);
}
