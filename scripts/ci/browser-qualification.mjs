// Four independent ubuntu-24.04 jobs select one source and one setup strategy.
// Each job measures cold then warm setup using the same job-owned caches.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { setupBrowser } from './browser-probe.mjs';

const sources = {
  pegboard: { repository: 'just-every/run-pegboard', commit: 'e359e2645fb427e2b02a96ff814dd8116084b3a0', playwright: '1.63.0' },
  nook: { repository: 'just-every/run-nook', commit: '7fc9516570502e9066b7f3a16d08ad63610d608e', playwright: '1.64.1' },
};
const [seed, strategy, ...extra] = process.argv.slice(2);
assert.ok(sources[seed] && ['baseline', 'candidate'].includes(strategy) && !extra.length,
  'Usage: node scripts/ci/browser-qualification.mjs <pegboard|nook> <baseline|candidate>');
assert.equal(process.platform, 'linux', 'Qualification requires a fresh ubuntu-24.04 runner');
assert.match(await readFile('/etc/os-release', 'utf8'), /VERSION_ID="24\.04"/);
assert.ok(process.env.RUNNER_TEMP, 'RUNNER_TEMP is required');
const temporary = resolve(process.env.RUNNER_TEMP);
const evidencePath = resolve(process.env.BROWSER_QUALIFICATION_EVIDENCE ?? join(temporary, `browser-qualification-${seed}-${strategy}.json`));
const started = performance.now();
const source = sources[seed];
const evidence = {
  seed, strategy, source, startedAt: new Date().toISOString(),
  runner: { os: process.platform, architecture: process.arch, node: process.version, image: process.env.ImageVersion },
  cache: { restored: false, warm: 'Same browser, apt and pnpm paths populated by this job’s cold setup' },
  runs: [],
};
let work;

function run(program, args, { cwd = work, output } = {}) {
  const result = spawnSync(program, args, { cwd, env: process.env, stdio: ['ignore', output ?? 'inherit', 'inherit'] });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${program} failed (exit=${result.status}, signal=${result.signal})`);
}

function capture(program, args) {
  const result = spawnSync(program, args, { cwd: work, env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${program} failed (exit=${result.status})`);
  return result.stdout.trim();
}

async function readOptional(path) {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function sourceContext(snapshot) {
  const verification = await readOptional(join(snapshot, 'verification.json'));
  const files = ['package.json', 'pnpm-lock.yaml', 'verification.json'];
  const workflows = {};
  for (const name of (await readdir(join(snapshot, '.github/workflows'))).filter(name => /\.ya?ml$/.test(name)).sort()) {
    const path = `.github/workflows/${name}`;
    files.push(path);
    workflows[path] = await readFile(join(snapshot, path), 'utf8');
  }
  const digests = {};
  for (const path of files) {
    const text = await readOptional(join(snapshot, path));
    digests[path] = text === null ? null : createHash('sha256').update(text).digest('hex');
  }
  const plan = verification === null ? null : JSON.parse(verification);
  return {
    verification: plan,
    planCounts: plan === null ? null : { push: plan.push.length, nightly: plan.nightly.length },
    workflows, digests,
  };
}

try {
  work = await mkdtemp(join(temporary, `browser-qualification-${seed}-${strategy}-`));
  const snapshot = join(work, 'snapshot');
  const archive = join(work, 'source.tar.gz');
  const paths = {
    browsers: join(work, 'cache/ms-playwright'), apt: join(work, 'cache/apt/archives'),
    pnpm: join(work, 'cache/pnpm-store'),
  };
  evidence.cache.paths = paths;
  // Never change HOME or use a persistent browser profile. Both strategies
  // start with empty, unique caches and share only their own cold→warm state.
  process.env.PLAYWRIGHT_BROWSERS_PATH = paths.browsers;
  process.env.PLAYWRIGHT_SKIP_BROWSER_GC = '1';
  process.env.WRANGLER_SEND_METRICS = 'false';
  process.env.CI = 'true';
  await mkdir(snapshot);
  for (const path of Object.values(paths)) await mkdir(path, { recursive: true });
  const acquisitionStarted = performance.now();
  const metadata = JSON.parse(capture('gh', ['api', `repos/${source.repository}`, '--jq', '{full_name,default_branch,private}']));
  assert.equal(metadata.full_name, source.repository);
  assert.equal(metadata.private, false, 'Qualification uses public, read-only snapshots');
  evidence.repositoryMetadata = metadata;
  const descriptor = openSync(archive, 'wx');
  try { run('gh', ['api', `repos/${source.repository}/tarball/${source.commit}`], { output: descriptor }); }
  finally { closeSync(descriptor); }
  run('tar', ['-xzf', archive, '--strip-components=1', '-C', snapshot]);
  evidence.acquisitionSeconds = (performance.now() - acquisitionStarted) / 1000;
  const packageJson = JSON.parse(await readFile(join(snapshot, 'package.json'), 'utf8'));
  assert.equal(process.version, `v${packageJson.engines.node}`, 'Use the snapshot’s real Node version');
  const pnpm = capture('pnpm', ['--version']);
  assert.equal(packageJson.packageManager, `pnpm@${pnpm}`, 'Use the snapshot’s real pnpm version');
  evidence.package = { name: packageJson.name, engines: packageJson.engines, packageManager: packageJson.packageManager };
  evidence.context = await sourceContext(snapshot);
  const dependencyStarted = performance.now();
  try { run('pnpm', ['install', '--frozen-lockfile', '--store-dir', paths.pnpm], { cwd: snapshot }); }
  finally { evidence.dependencySeconds = (performance.now() - dependencyStarted) / 1000; }
  const require = createRequire(join(snapshot, 'package.json'));
  assert.equal(require('@playwright/test/package.json').version, source.playwright);
  for (const temperature of ['cold', 'warm']) {
    const result = { temperature, cacheBefore: {} };
    evidence.runs.push(result);
    for (const [name, path] of Object.entries(paths)) result.cacheBefore[name] = await readdir(path);
    await setupBrowser({ packageRoot: snapshot, baseline: strategy === 'baseline', aptArchives: paths.apt, result });
  }
  assert.deepEqual((await sourceContext(snapshot)).digests, evidence.context.digests, 'Snapshot source, lockfile, workflow and plan must remain unchanged');
  evidence.passed = true;
} catch (error) {
  evidence.passed = false;
  evidence.error = error.stack ?? String(error);
  console.error(evidence.error);
  process.exitCode = 1;
} finally {
  evidence.totalSeconds = (performance.now() - started) / 1000;
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`BROWSER_QUALIFICATION ${JSON.stringify({ seed, strategy, passed: evidence.passed, dependencySeconds: evidence.dependencySeconds, totalSeconds: evidence.totalSeconds, runs: evidence.runs.map(({ temperature, seconds, aptUsed, passed }) => ({ temperature, seconds, aptUsed, passed })), evidence: evidencePath })}`);
  if (work) await rm(work, { recursive: true, force: true });
}
