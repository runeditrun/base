import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { exportReference } from '../scripts/export-reference.mjs';
import { productionSender } from './fixtures/production-sender.mjs';

const execute = promisify(execFile);
const base = resolve(import.meta.dirname, '..');

// The real exported app and pnpm, with the fresh-HOME env -i allowlist. No
// build or provider call is needed to distinguish tool failure from bad input.
test('deploy accepts the real pinned pnpm in a minimal environment and reports the actual refusal', { timeout: 60000 }, async t => {
 const directory = await mkdtemp(join(tmpdir(), 'rer-deploy-pnpm-'));
 t.after(() => rm(directory, { recursive: true, force: true }));
 const root = join(directory, 'seed'), home = join(directory, 'home');
 await exportReference(base, root);
 const declaration = JSON.parse(await readFile(join(root, 'deploy.json'), 'utf8'));
 declaration.vars.MAIL_FROM = productionSender;
 await writeFile(join(root, 'deploy.json'), JSON.stringify(declaration));
 for (const path of ['npm/bin', 'bin', 'tmp', 'xdg/config', 'xdg/cache', 'xdg/data', 'xdg/state']) await mkdir(join(home, path), { recursive: true });
 const { stdout } = await execute('/bin/sh', ['-c', 'command -v pnpm']);
 await symlink(stdout.trim(), join(home, 'npm/bin/pnpm'));
 await symlink(process.execPath, join(home, 'bin/node'));
 const env = {
  HOME: home, PATH: `${home}/npm/bin:${home}/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
  npm_config_prefix: join(home, 'npm'), XDG_CONFIG_HOME: join(home, 'xdg/config'),
  XDG_CACHE_HOME: join(home, 'xdg/cache'), XDG_DATA_HOME: join(home, 'xdg/data'), XDG_STATE_HOME: join(home, 'xdg/state'),
  GIT_CONFIG_GLOBAL: join(home, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', TMPDIR: join(home, 'tmp'),
  LANG: 'en_US.UTF-8', TERM: 'dumb', WRANGLER_SEND_METRICS: 'false',
  CLOUDFLARE_API_TOKEN: 'test-only-deploy-token', CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
  MAIL_API_KEY: 'test-only-mail-key',
 };
 // Git sees an actual dirty committed checkout and refuses before building or
 // contacting a provider, after the tool check has accepted the real pnpm.
 const git = (...args) => execute('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', ...args], { cwd: root });
 await git('init', '-q'); await git('add', '.gitignore'); await git('commit', '-qm', 'fixture');
 await writeFile(join(root, '.gitignore'), '\n# Uncommitted source\n', { flag: 'a' });
 const run = async flags => {
  try { return { code: 0, ...await execute('/usr/bin/env', ['-i', ...Object.entries(env).map(([key, value]) => `${key}=${value}`), process.execPath, join(root, 'scripts/rer.mjs'), 'deploy', '--json', ...flags], { cwd: root, timeout: 45000 }) }; }
  catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
 };
 const valid = await run(['--environment', 'production']);
 assert.equal(valid.code, 4, valid.stdout + valid.stderr);
 const refusal = JSON.parse(valid.stdout.trim().split('\n').find(line => line.includes('"event":"error"')));
 assert.equal(refusal.code, 'safety_refusal');
 assert.match(refusal.message, /not committed/);
 assert.doesNotMatch(valid.stdout + valid.stderr, /pnpm.*failed/);
 const logs = join(root, '.seed/installer');
 for (const flags of [[], ['--remove', '--yes']]) {
  const invalid = await run(['--environment', 'pr-free4-happytohelp-20261015080002', ...flags]);
  assert.equal(invalid.code, 2, invalid.stdout + invalid.stderr);
  const error = JSON.parse(invalid.stdout.trim().split('\n').find(line => line.includes('"event":"error"')));
  assert.equal(error.code, 'invalid_invocation');
  assert.match(error.message, /environment/i);
  assert.doesNotMatch(invalid.stdout + invalid.stderr, /pnpm.*failed/);
  const captured = (await Promise.all((await readdir(logs, { recursive: true })).filter(path => path.endsWith('install.log')).map(path => readFile(join(logs, path), 'utf8')))).join('\n');
  assert.ok(captured.includes(error.message), 'the capture log retains the actual refusal');
 }
});
