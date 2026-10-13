import { readFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { cleanEnvironment, execute, assertExecution, Incomplete } from './commands.mjs';
import { Receipt } from './receipt.mjs';
import { ciMetadata } from './metadata.mjs';
import { PUBLIC, SOURCE_GATE } from './constants.mjs';
import { command } from './docker.mjs';
import { buildRuntimes, inventory } from './runtimes.mjs';
import { acquire } from './sources.mjs';
import { publicBuild } from './public-build.mjs';
import { generic } from './generic.mjs';
import { artifactAdversary } from './artifact-adversary.mjs';
import { browserSmoke, browserBoundary } from './browser.mjs';
import { preserveImages } from './custody.mjs';
import { cleanup } from './cleanup.mjs';
const args = process.argv.slice(2), outputIndex = args.indexOf('--output');
assert(outputIndex >= 0 && args[outputIndex + 1], '--output required');
assert(args.every((a, i) => ['--output', '--cleanup'].includes(a) || i === outputIndex + 1), 'unknown-runner-argument');
const output = resolve(args[outputIndex + 1]), checkout = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const temporary = process.env.RUNNER_TEMP || resolve(output, '..'); mkdirSync(temporary, { recursive: true });
const root = mkdtempSync(join(temporary, 't016-ci-')), env = cleanEnvironment(root); mkdirSync(env.DOCKER_CONFIG);
const receipt = new Receipt(output, { platform: { os: process.platform, architecture: process.arch, node: process.version }, pendingLinux: process.platform !== 'linux' });
const ctx = { root, env, output, checkout, tools: resolve(fileURLToPath(new URL('.', import.meta.url))), receipt, images: {}, sources: {}, artifacts: {} };
let linuxReady = false;
try {
  const revision = assertExecution(await execute(['git', 'rev-parse', 'HEAD'], { cwd: checkout, env }));
  ctx.sourceCommit = revision.stdout.toString().trim(); receipt.value.sourceCommit = ctx.sourceCommit; receipt.value.sourceGate.finalSourceHEAD = ctx.sourceCommit;
  if (process.platform !== 'linux') throw new Incomplete('pendingLinux: hosted Linux Docker execution required; no Mac Docker probe was attempted');
  ctx.github = ciMetadata(process.env, JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH)), ctx.sourceCommit); receipt.value.github = ctx.github;
  assert.equal(process.arch, 'x64'); assert.equal(process.version, 'v26.8.1');
  env.T016_CONTAINER_LABEL = 't016-ci-' + ctx.github.runId + '-' + ctx.github.runAttempt;
  env.GITHUB_ACTIONS = 'true'; env.GITHUB_RUN_ID = ctx.github.runId; env.CONTROL_SHA = ctx.sourceCommit;
  env.GITHUB_OUTPUT = join(root, 'isolation-output'); writeFileSync(env.GITHUB_OUTPUT, '', { mode: 0o600 });
  // Inspect keys, never values. Checkout is already persist-credentials:false;
  // unexpected local Git authority is an assertion failure before source runs.
  const config = await execute(['git', 'config', '--local', '--name-only', '--get-regexp', '(extraheader|credential|sshcommand)'], { cwd: checkout, env });
  assert.equal(config.exitCode, 1); assert.equal(config.stdout.toString(), '');
  await command(ctx, ['git', 'merge-base', '--is-ancestor', SOURCE_GATE.commit, ctx.sourceCommit]);
  await command(ctx, ['docker', 'version'], {}, ['docker-inspect']).catch(e => { throw new Incomplete('docker-prerequisite: ' + e.message); }); linuxReady = true;
  if (args.includes('--cleanup')) {
    if (existsSync(join(output, 'receipt.json'))) {
      receipt.value = JSON.parse(readFileSync(join(output, 'receipt.json')));
      receipt.value.commands = receipt.value.commands.filter(r => r.id !== 'cleanup');
      receipt.sequence = 100000; // distinct cleanup command filenames
    }
  } else {
    const built = await receipt.proof('runtime-images', () => buildRuntimes(ctx));
    // Pure artifact rejection and immutable public acquisition remain independent
    // even when a runtime package download or daemon build fails.
    await receipt.proof('artifact-adversary', () => artifactAdversary(ctx));
    for (const pin of PUBLIC) await receipt.proof('h2h-' + pin.id + '-source', () => acquire(ctx, pin));
    if (built) {
      await receipt.proof('installed-closures', () => inventory(ctx));
      await receipt.proof('namespace-adversary', async () => {
        await command(ctx, [process.execPath, 'live-proofs/tests/isolation-linux.mjs']);
        await command(ctx, [process.execPath, 'live-proofs/tests/standalone-isolation-linux.mjs']);
      });
      for (const [id, mode] of [['generic-success', 'success'], ['install-failure', 'install-failure'], ['build-failure', 'build-failure']]) await receipt.proof(id, () => generic(ctx, mode));
      for (const pin of PUBLIC) if (ctx.sources[pin.id]) await receipt.proof('h2h-' + pin.id + '-build', () => publicBuild(ctx, pin));
      if (Object.keys(ctx.artifacts).length === 2) await receipt.proof('chromium-headless', () => browserSmoke(ctx));
      await receipt.proof('browser-boundary', () => browserBoundary(ctx));
      await receipt.proof('image-custody', () => preserveImages(ctx));
    }
  }
} catch (e) {
  await receipt.proof('prerequisites', () => { throw e; });
} finally {
  if (linuxReady) await receipt.proof('cleanup', () => cleanup(ctx));
  else receipt.file('cleanup/not-started.json', { containersStarted: false, reason: 'platform-or-CI-prerequisite-unavailable' }, ['cleanup']);
  rmSync(root, { recursive: true, force: true });
  const result = receipt.finish(); console.log(JSON.stringify({ status: result.status, receipt: join(output, 'receipt.json'), hostedAcceptance: 'pending' }));
  process.exitCode = result.status === 'pass' ? 0 : 1;
}
