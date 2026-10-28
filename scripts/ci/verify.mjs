// CI partitions the same stages used by pnpm verify; product checks stay unchanged.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { verifyStages } from '../verify-stages.mjs';
import { verify } from '../verify.mjs';
import { CLI_SHARDS, cliShardPlan, verifyCLIShard } from './cli-shard.mjs';
import { MODULE_SHARDS, moduleShardPlan, verifyModuleShard } from './module-shard.mjs';
import { referenceShardPlan, verifyReferenceShard } from './reference-shard.mjs';

const stage = name => ({ stage: `verify:${name}` });
const partition = (name, shard) => ({ stage: `verify:${name}`, shard });
export const groups = {
  '1': [partition('modules', 1)],
  '2': [partition('modules', 2), stage('release')],
  '3': [partition('cli', 1), stage('foundation')],
  '4': [partition('cli', 2), stage('editor')],
  '5': [stage('reference'), stage('operator-auth'), stage('onboarding-browser')],
  '6': [partition('cli', 3), ...['composition', 'edition-authoring', 'authoring', 'delivery-producer', 'schema', 'operations'].map(stage)],
  '7': ['container', 'job-queue', 'owner-claim', 'boundary-checker', 'deployment', 'rer', 'publish-check'].map(stage),
  '8': [partition('cli', 4), ...['portability', 'review-harness', 'onboarding', 'launcher', 'mail-relay'].map(stage)],
};

export async function ciPlan({ journeys = false } = {}) {
  const tasks = Object.values(groups).flat();
  const stages = [...new Set(tasks.map(task => task.stage))];
  assert.deepEqual(stages.sort(), [...verifyStages].sort(), 'CI must cover every full-verify stage');
  for (const name of verifyStages) {
    const owners = tasks.filter(task => task.stage === name);
    const total = name === 'verify:modules' ? MODULE_SHARDS : name === 'verify:cli' ? CLI_SHARDS : 1;
    assert.equal(owners.length, total, `CI repeats or omits a verify stage: ${name}`);
    if (total > 1) assert.deepEqual(owners.map(task => task.shard).sort(), Array.from({ length: total }, (_, index) => index + 1), `CI repeats a verify partition: ${name}`);
    else assert.equal(owners[0].shard, undefined, `Unexpected partition: ${name}`);
  }
  await Promise.all([moduleShardPlan(), cliShardPlan(), referenceShardPlan()]);
  // Only the native editor consumer requires hosted disk reclamation. Both
  // module browser files live in partition A; partition B needs only workerd.
  const include = Object.keys(groups).map(group => ({ group, browser: group !== '2', native: group === '4' }));
  if (journeys) include.push({ group: 'journeys', browser: true, native: false });
  return { include };
}

async function typecheckModules() {
  const child = spawn('pnpm', ['typecheck:modules'], { stdio: 'inherit' });
  const onTerm = () => child.kill('SIGTERM'), onInt = () => child.kill('SIGINT');
  process.on('SIGTERM', onTerm); process.on('SIGINT', onInt);
  try {
    return await new Promise(resolve => {
      child.once('error', error => { console.error(error.message); resolve(1); });
      child.once('close', code => resolve(code ?? 1));
    });
  } finally {
    process.off('SIGTERM', onTerm); process.off('SIGINT', onInt);
  }
}

export async function verifyGroup(group) {
  await ciPlan();
  if (group === 'journeys') {
    const cli = await verifyCLIShard(undefined, { journey: true });
    const reference = await verifyReferenceShard('nightly');
    return cli || reference;
  }
  assert.ok(Object.hasOwn(groups, group), 'Choose a CI verify group from --matrix');
  console.log(`VERIFY_GROUP ${group} ${groups[group].map(({ stage, shard }) => `${stage}${shard ? ` partition=${shard}` : ''}`).join(' ')}`);
  const started = performance.now();
  let code = 0;
  for (const task of groups[group]) {
    const result = task.stage === 'verify:modules' ? await verifyModuleShard(String(task.shard))
      : task.stage === 'verify:cli' ? await verifyCLIShard(String(task.shard))
        : task.stage === 'verify:reference' ? await verifyReferenceShard('push')
          : await verify([task.stage]);
    code ||= result;
    if (result === 130 || result === 143) return result;
  }
  if (group === '2') {
    const result = await typecheckModules();
    code ||= result;
  }
  console.log(`VERIFY_GROUP end ${group} exit=${code} seconds=${((performance.now() - started) / 1000).toFixed(3)}`);
  return code;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv[2] === '--matrix') console.log(JSON.stringify(await ciPlan({ journeys: process.env.CI_INCLUDE_JOURNEYS === 'true' })));
  else process.exitCode = await verifyGroup(process.argv[2]);
}
