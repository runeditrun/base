// CI partitions the same stages used by pnpm verify; product checks stay unchanged.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { verifyStages } from '../verify-stages.mjs';
import { verify } from '../verify.mjs';
import { CLI_SHARDS, cliShardPlan, verifyCLIShard } from './cli-shard.mjs';
import { MODULE_SHARDS, moduleShardPlan, verifyModuleShard } from './module-shard.mjs';
import { REFERENCE_SHARDS, referencePushShardPlan, verifyReferenceShard } from './reference-shard.mjs';

const stage = name => ({ stage: `verify:${name}` });
const partition = (name, shard) => ({ stage: `verify:${name}`, shard });
export const groups = {
  '1': [partition('modules', 1)],
  '2': [partition('modules', 2), stage('release'), stage('publish-check'), stage('onboarding'), stage('review-harness'), stage('job-queue'), stage('operations'), stage('schema'), stage('mail-relay'), stage('deployment'), stage('launcher'), stage('onboarding-browser')],
  '3': [partition('cli', 1), partition('reference', 2), stage('boundary-checker'), stage('edition-authoring')],
  '4': [partition('cli', 2), stage('owner-claim')],
  '5': [partition('reference', 1)],
  '6': [partition('cli', 3), stage('authoring'), stage('rer')],
  '7': [partition('modules', 3)],
  '8': [partition('cli', 4), stage('editor'), stage('operator-auth'), stage('delivery-producer'), stage('foundation'), stage('portability'), stage('container'), stage('composition')],
};

export async function ciPlan({ journeys = false } = {}) {
  const tasks = Object.values(groups).flat();
  const stages = [...new Set(tasks.map(task => task.stage))];
  assert.deepEqual(stages.sort(), [...verifyStages].sort(), 'CI must cover every full-verify stage');
  for (const name of verifyStages) {
    const owners = tasks.filter(task => task.stage === name);
    const total = name === 'verify:modules' ? MODULE_SHARDS : name === 'verify:cli' ? CLI_SHARDS : name === 'verify:reference' ? REFERENCE_SHARDS : 1;
    assert.equal(owners.length, total, `CI repeats or omits a verify stage: ${name}`);
    if (total > 1) assert.deepEqual(owners.map(task => task.shard).sort(), Array.from({ length: total }, (_, index) => index + 1), `CI repeats a verify partition: ${name}`);
    else assert.equal(owners[0].shard, undefined, `Unexpected partition: ${name}`);
  }
  await Promise.all([moduleShardPlan(), cliShardPlan(), referencePushShardPlan()]);
  // Native disk setup follows the editor. A job containing only a module
  // partition without the two fixed browser files needs workerd alone.
  const include = Object.keys(groups).map(group => ({ group, browser: groups[group].some(task => task.stage !== 'verify:modules' || task.shard === 1), native: groups[group].some(task => task.stage === 'verify:editor') }));
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
        : task.stage === 'verify:reference' ? await verifyReferenceShard('push', { partition: String(task.shard) })
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
