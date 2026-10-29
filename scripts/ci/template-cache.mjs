// Run the exported workflow's actual shell blocks as the hosted runner user.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {parse} from '../../edition-authoring/vendor/yaml/index.mjs';
import {exportReference} from '../export-reference.mjs';

const temporary = process.env.RUNNER_TEMP;
assert.ok(temporary, 'RUNNER_TEMP is required');
const area = path.join(temporary, 'delivered-template-cache'), seed = path.join(area, 'seed');
const cacheRoot = path.join(area, 'runner-temp');
const mode = process.argv[2];
function workflow() {
  return parse(fs.readFileSync(path.join(seed, '.github/workflows/verify.yml'), 'utf8'));
}
const environmentFile = path.join(area, 'environment');
function environment() {
  const values = Object.fromEntries(fs.readFileSync(environmentFile, 'utf8').trim().split('\n').filter(Boolean).map(line => {
    const split = line.indexOf('='); return [line.slice(0, split), line.slice(split + 1)];
  }));
  return {...process.env, ...workflow().jobs.shards.env, ...values, RUNNER_TEMP: cacheRoot, GITHUB_ENV: environmentFile};
}
function shell(script) {
  const child = spawnSync('bash', ['-euo', 'pipefail', '-c', script], {cwd: seed, env: environment(), stdio: 'inherit'});
  assert.equal(child.status, 0, 'Delivered workflow shell block failed');
}
function runStep(name) {
  const steps = workflow().jobs.shards.steps.filter(step => step.name === name);
  assert.equal(steps.length, 1, `Delivered workflow step: ${name}`);
  shell(steps[0].run);
}
function homeOwners() {
  const root = path.join(process.env.HOME, '.cache'), owners = {};
  if (!fs.existsSync(root)) return owners;
  for (const name of ['', ...fs.readdirSync(root)]) {
    const stat = fs.lstatSync(path.join(root, name)); owners[name] = stat.uid;
  }
  return owners;
}
if (mode === 'prepare') {
  assert.notEqual(process.getuid(), 0, 'The template must run as the hosted runner user');
  fs.mkdirSync(area);
  fs.mkdirSync(cacheRoot);
  await exportReference(path.resolve(import.meta.dirname, '../..'), seed);
  fs.writeFileSync(environmentFile, '');
  fs.writeFileSync(path.join(area, 'home-owners.json'), JSON.stringify(homeOwners()));
  runStep('Set runner-owned browser cache');
  // Use the actual template setup commands, including the store selection.
  runStep('Set runner-owned pnpm store');
  runStep('Prepare runner-owned browser and apt caches');
  const cache = workflow().jobs.shards.steps.find(step => step.name === 'Cache frozen dependencies and Chromium');
  const paths = cache.with.path.replaceAll('${{ runner.temp }}', cacheRoot);
  assert.ok(paths.split('\n').filter(Boolean).every(name => name.startsWith(cacheRoot + '/')));
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `paths<<CACHE_PATHS\n${paths}\nCACHE_PATHS\n`);
} else if (mode === 'cold' || mode === 'warm') {
  for (const command of ['pnpm install --frozen-lockfile', 'pnpm run deps']) {
    assert.ok(workflow().jobs.shards.steps.some(step => step.run === command));
    shell(command);
  }
  runStep('Install and probe Chromium before system dependencies');
  if (mode === 'cold') {
    // Hosted Ubuntu often has the libraries already. Exercise the delivered
    // sudo boundary too, even when its first real Chromium probe succeeds.
    const step = workflow().jobs.shards.steps.find(step => step.name === 'Install and probe Chromium before system dependencies');
    const command = step.run.split('\n').find(line => line.trim().startsWith('sudo env '));
    assert.ok(command);
    shell(command);
    runStep('Install and probe Chromium before system dependencies');
    shell('pnpm store path');
  }
  const before = JSON.parse(fs.readFileSync(path.join(area, 'home-owners.json')));
  for (const [name, uid] of Object.entries(homeOwners())) assert.ok(uid !== 0 || before[name] === 0, `New root-owned HOME cache: ${name}`);
  for (const name of ['pnpm-store', 'ms-playwright', 'rer-apt/archives']) {
    const stat = fs.statSync(path.join(cacheRoot, name));
    assert.equal(stat.uid, process.getuid(), `${name} remains runner-owned`);
    console.log(`${mode}: ${name} uid=${stat.uid} gid=${stat.gid} mode=${(stat.mode & 0o777).toString(8)}`);
  }
  console.log(`Delivered template ${mode}: frozen install and Chromium launch passed`);
} else if (mode === 'remove') {
  for (const name of ['pnpm-store', 'ms-playwright', 'rer-apt']) {
    // apt keeps its uncached partial directory private to _apt.
    if (name === 'rer-apt') {
      const removed = spawnSync('sudo', ['rm', '-rf', '--', path.join(cacheRoot, name, 'archives/partial')], {stdio: 'inherit'});
      assert.equal(removed.status, 0);
    }
    fs.rmSync(path.join(cacheRoot, name), {recursive: true});
  }
  fs.rmSync(path.join(seed, 'node_modules'), {recursive: true});
} else if (mode === 'cleanup') {
  const removed = spawnSync('sudo', ['rm', '-rf', '--', path.join(cacheRoot, 'rer-apt/archives/partial')], {stdio: 'inherit'});
  assert.equal(removed.status, 0);
  fs.rmSync(area, {recursive: true, force: true});
}
else throw Error('Choose prepare, cold, remove, warm or cleanup');
