import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verificationPlan } from '../../default-seed/scripts/verify-app.mjs';

export const REFERENCE_SHARDS = 2;
const moved = ['auth-emitted', 'journey-demo'];

export async function referenceShardPlan() {
  const plan = await verificationPlan();
  const push = plan.push.map(({ name }) => name);
  const groups = {
    push,
    nightly: plan.nightly.map(({ name }) => name),
  };
  assert.ok(groups.push.length, 'Reference verification needs push shards');
  assert.equal(new Set(groups.push).size, push.length, 'Reference CI must cover every push shard exactly once');
  return groups;
}

export async function referencePushShardPlan() {
  const { push } = await referenceShardPlan();
  for (const name of moved) assert.ok(push.includes(name), `Missing moved reference entry: ${name}`);
  const groups = { '1': push.filter(name => !moved.includes(name)), '2': push.filter(name => moved.includes(name)) };
  assert.ok(Object.values(groups).every(names => names.length), 'Each reference partition needs entries');
  assert.deepEqual(Object.values(groups).flat().sort(), [...push].sort(), 'Reference CI must cover every selected push entry exactly once');
  return groups;
}

export async function verifyReferenceShard(shard, { partition } = {}) {
  assert.ok(['push', 'nightly'].includes(shard), 'REFERENCE_SHARD must be push or nightly');
  let names = (await referenceShardPlan())[shard];
  if (partition !== undefined) {
    assert.equal(shard, 'push', 'Only push reference entries are partitioned');
    const groups = await referencePushShardPlan();
    assert.ok(Object.hasOwn(groups, partition), 'Choose a reference push partition');
    names = groups[partition];
  }
  const cwd = fileURLToPath(new URL('../../default-seed/', import.meta.url));
  const queue = fileURLToPath(new URL('../../onboarding/queued-entry.mjs', import.meta.url));
  const label = partition ? `${shard} partition=${partition}/${REFERENCE_SHARDS}` : shard;
  const started = performance.now();
  let child, signal, code = 0;
  const cancel = value => { signal ??= value; child?.kill(value); };
  const onTerm = () => cancel('SIGTERM'), onInt = () => cancel('SIGINT');
  process.on('SIGTERM', onTerm); process.on('SIGINT', onInt);
  console.log(`VERIFY_STAGE start verify:reference shard=${label}`);
  try {
    for (const name of names) {
      if (signal) break;
      console.log(`VERIFY_REFERENCE ${name}`);
      // The seed runner selects its declared commands and keeps hosted checks
      // on runtime; root queue admission and cancellation still own each child.
      child = spawn(process.execPath, [
        queue, 'verify:reference', '--', process.execPath, 'scripts/verify-ci.mjs', name,
      ], { cwd, stdio: 'inherit' });
      code = await new Promise(resolve => {
        child.once('error', error => { console.error(error.message); resolve(1); });
        child.once('close', code => resolve(code ?? 1));
      });
      child = undefined;
      if (code !== 0) break;
    }
    code = signal === 'SIGINT' ? 130 : signal ? 143 : code;
    console.log(`VERIFY_STAGE end verify:reference shard=${label} exit=${code} seconds=${((performance.now() - started) / 1000).toFixed(3)}`);
    return code;
  } finally {
    process.off('SIGTERM', onTerm); process.off('SIGINT', onInt);
  }
}
