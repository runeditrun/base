import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lchownSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixture } from './test-fixture.mjs';
import { isolatedQueue } from '../../cli/fixtures/queue.mjs';

function unprivileged(directory) {
  if (lstatSync(directory).isDirectory()) {
    for (const entry of readdirSync(directory)) unprivileged(join(directory, entry));
  }
  lchownSync(directory, 65534, 65534);
}

async function cleanupRelease(t, locked) {
  const f = fixture(t);
  f.env = await isolatedQueue(t);
  const probe = join(f.temporary, 'cleanup-directory');
  f.env.RELEASE_CLEANUP_PROBE = probe;
  const check = join(f.repo, 'check.test.mjs');
  writeFileSync(check, readFileSync(check, 'utf8') + `
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
const residue = join(dirname(process.cwd()), 'cleanup-residue');
mkdirSync(residue);
writeFileSync(join(dirname(process.cwd()), '.DS_Store'), 'synthetic Finder metadata');
writeFileSync(join(residue, '.DS_Store'), 'synthetic Finder metadata');
writeFileSync(process.env.RELEASE_CLEANUP_PROBE, dirname(process.cwd()));
${locked ? 'chmodSync(residue, 0o555);' : ''}
`);
  const sha = f.commit();
  let temporary;
  t.after(() => {
    if (!temporary || !existsSync(temporary)) return;
    const residue = join(temporary, 'cleanup-residue');
    if (existsSync(residue)) chmodSync(residue, 0o755);
    rmSync(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const identity = {};
  if (process.getuid?.() === 0) {
    // Root bypasses directory permissions; run the real release as an ordinary
    // user so the cleanup error remains a real filesystem failure in CI.
    const home = join(f.temporary, 'home');
    mkdirSync(home);
    Object.assign(f.env, { HOME: home, XDG_CACHE_HOME: join(home, 'cache'),
      XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'),
      npm_config_store_dir: join(home, 'store') });
    unprivileged(f.temporary);
    unprivileged(f.env.RER_JOBS_DIR);
    Object.assign(identity, { uid: 65534, gid: 65534 });
  }
  const output = f.options.output;
  const result = spawnSync(process.execPath, [join(import.meta.dirname, '../../bin/rer.mjs'), 'release',
    '--repo', f.repo, '--project', f.options.project, '--repository', f.options.repository,
    '--output', output, '--local-verify', '--tag', '--ref', sha],
  { cwd: f.temporary, env: f.env, encoding: 'utf8', timeout: 120000, ...identity });
  temporary = existsSync(probe) ? readFileSync(probe, 'utf8') : undefined;
  return { result, receipt: result.stdout.trim() ? JSON.parse(result.stdout) : null, output, temporary };
}

test('release removes extra Finder metadata during temporary cleanup and still exits RELEASED', async t => {
  const { result, receipt, output, temporary } = await cleanupRelease(t, false);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(receipt.status, 'RELEASED');
  assert.equal(JSON.parse(readFileSync(join(output, 'release-receipt.json'))).status, 'RELEASED');
  assert.equal(existsSync(temporary), false);
});

test('a real temporary cleanup error preserves the completed release and reports a warning', async t => {
  const { result, receipt, output, temporary } = await cleanupRelease(t, true);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(receipt.status, 'RELEASED');
  const saved = JSON.parse(readFileSync(join(output, 'release-receipt.json')));
  assert.equal(saved.status, 'RELEASED');
  assert.ok(existsSync(temporary), 'the permission failure left temporary residue');
  assert.ok(receipt.warnings.some(warning => warning.code === 'temporary-cleanup-failed'));
  assert.deepEqual(saved.warnings, receipt.warnings);
  assert.match(result.stderr, /warning.*temporary.*cleanup/i);
  assert.ok(existsSync(join(output, receipt.publicExport.path)));
});
