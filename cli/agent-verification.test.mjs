import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { exportReference } from '../scripts/export-reference.mjs';
import { isolatedQueue } from './fixtures/queue.mjs';

test('exported seed agent check accepts clean source and refuses type, lock and custody drift', { timeout: 600000 }, async t => {
 const directory = await mkdtemp(join(tmpdir(), 'rer-agent-check-'));
 t.after(() => rm(directory, { recursive: true, force: true }));
 const root = join(directory, 'seed with spaces');
 await exportReference(resolve(import.meta.dirname, '..'), root);
 const env = await isolatedQueue(t, { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false', PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1', npm_config_child_concurrency: '1', npm_config_network_concurrency: '2' });
 const run = (program, args, extra = {}) => {
  const result = spawnSync(program, args, { cwd: root, env: { ...env, ...extra }, encoding: 'utf8', timeout: 240000, maxBuffer: 4 * 1024 * 1024 });
  assert.ifError(result.error);
  return { ...result, output: result.stdout + result.stderr };
 };
 const pkgPath = join(root, 'package.json'), originalPackage = await readFile(pkgPath, 'utf8');
 assert.ok(JSON.parse(originalPackage).scripts['verify:agent'], 'the exported package declares the public agent command');
 const installed = run('pnpm', ['install', '--frozen-lockfile']);
 assert.equal(installed.status, 0, installed.output);
 const contract = run(process.execPath, ['scripts/rer.mjs', 'check', '--profile', 'first-party', '--json']);
 assert.equal(contract.status, 0, contract.output);
 const started = performance.now();
 const clean = run('pnpm', ['run', 'verify:agent'], { npm_config_offline: 'true', RER_NODE_AUTO: '0' });
 assert.equal(clean.status, 0, clean.output);
 t.diagnostic(`Clean exported seed verify:agent: ${((performance.now() - started) / 1000).toFixed(2)}s`);

 const probe = join(root, 'src/agent-check-probe.ts');
 await writeFile(probe, 'export const agentCheckProbe: number = "type error";\n');
 const invalid = run('pnpm', ['run', 'verify:agent'], { npm_config_offline: 'true', RER_NODE_AUTO: '0' });
 assert.notEqual(invalid.status, 0, invalid.output);
 assert.match(invalid.output, /agent-check-probe\.ts.*TS2322/);
 await rm(probe);

 const pkg = JSON.parse(originalPackage);
 pkg.dependencies.react = '0.0.0';
 await writeFile(pkgPath, JSON.stringify(pkg));
 const staleLock = run('pnpm', ['run', 'source:check']);
 assert.notEqual(staleLock.status, 0, staleLock.output);
 assert.match(staleLock.output, /ERR_PNPM_OUTDATED_LOCKFILE/);
 await writeFile(pkgPath, originalPackage);

 const copied = join(root, 'scripts/base-cli/cli/contract.mjs');
 await writeFile(copied, '\n// Unrecorded change to a Base copy.\n', { flag: 'a' });
 const drift = run('pnpm', ['run', 'verify:base-source']);
 assert.notEqual(drift.status, 0, drift.output);
 assert.match(drift.output, /stale or missing portable CLI source cli\/contract\.mjs/);
});
