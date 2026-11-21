// After `install.sh ... <command>`, a later bare `rer` needs ~/.local/bin on PATH.
// Through the script's public door against a local registry serving the real
// package: the closing PATH step appears when the caller's PATH lacks the
// launcher's folder, only then, and the command's exit code is untouched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { buildPackage } from '../../scripts/rer-package.mjs';
import { integrity, localRegistry } from '../../scripts/rer-package/registry.mjs';
import { readPackage } from '../update/archive.mjs';

const base = resolve(import.meta.dirname, '../..');
const run = (program, args, env, cwd) => new Promise((resolveRun, reject) => {
 const child = spawn(program, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
 let stdout = '', stderr = '';
 child.stdout.on('data', data => { stdout += data; });
 child.stderr.on('data', data => { stderr += data; });
 child.once('error', reject);
 child.once('close', code => resolveRun({ code, stdout, stderr }));
});
const count = (text, pattern) => text.match(pattern)?.length ?? 0;

test('packed rer cli install with an XDG data home preserves the HOME launcher', async t => {
 const directory = await mkdtemp(join(tmpdir(), 'rer-xdg-install-'));
 t.after(() => rm(directory, { recursive: true, force: true }));
 const archive = await buildPackage(base, directory);
 const unpacked = await run('tar', ['-xzf', archive], { PATH: '/usr/bin:/bin' }, directory);
 assert.equal(unpacked.code, 0, unpacked.stderr);

 const env = { HOME: join(directory, 'home'), PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, RER_NO_UPDATE_CHECK: '1' };
 const install = env => run(process.execPath, [join(directory, 'package/global/rer.mjs'), 'cli', 'install'], env, directory);
 const standard = await install(env);
 assert.equal(standard.code, 0, standard.stderr);
 const homeLauncher = join(env.HOME, '.local/bin/rer'), original = await readFile(homeLauncher);

 const isolated = join(directory, 'isolated'), xdgEnv = { ...env, XDG_DATA_HOME: join(isolated, 'share') };
 const installed = await install(xdgEnv);
 assert.equal(installed.code, 0, installed.stderr);
 assert.deepEqual(await readFile(homeLauncher), original);
 const launcher = join(isolated, 'bin/rer');
 const status = await run(launcher, ['cli', 'status', '--json'], xdgEnv, directory);
 assert.equal(status.code, 0, status.stderr);
 const current = JSON.parse(status.stdout);
 assert.equal(current.launcher, launcher);
 assert.equal(current.root, await realpath(join(xdgEnv.XDG_DATA_HOME, 'rer')));
});

test('install.sh with a supplied command ends with one PATH step when ~/.local/bin is not on PATH, and stays silent when it is', { timeout: 5 * 60_000 }, async t => {
 const directory = await mkdtemp(join(tmpdir(), 'rer-installer-path-')), registry = await localRegistry();
 t.after(async () => { await registry.close(); await rm(directory, { recursive: true, force: true }); });
 const built = await readFile(await buildPackage(base, join(directory, 'built')));
 const entries = readPackage(built, { integrity: integrity(built) });
 const manifest = JSON.parse(entries.find(entry => entry.path === 'package.json').data);
 const installer = join(directory, 'install.sh');
 await writeFile(installer, entries.find(entry => entry.path === 'install.sh').data);
 registry.publish(manifest.version, built);
 const bin = join(directory, 'bin');
 await mkdir(bin);
 await symlink(process.execPath, join(bin, 'node'));

 const home = join(directory, 'home'), launcher = join(home, '.local/bin');
 const lacking = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, SHELL: '/bin/zsh', TMPDIR: directory, npm_config_registry: registry.url };
 const having = { ...lacking, PATH: `${launcher}:${lacking.PATH}` };
 const step = /^Required next step: /gm;

 // PATH lacks ~/.local/bin: the same install leaves a bare rer unfound, and says so exactly once.
 const missing = await run('sh', [installer, '--', 'cli', 'status'], lacking);
 assert.equal(missing.code, 0, missing.stderr);
 assert.equal(count(missing.stdout, step), 1, missing.stdout);
 const path = await run('sh', ['-c', '~/.local/bin/rer cli path'], lacking);
 assert.equal(path.code, 0, path.stderr);
 assert.equal(path.stdout.trim().split('\n').length, 1, 'cli path returns one command');
 assert.equal(path.stderr, '');
 assert.ok(missing.stdout.includes(path.stdout.trim()), 'installer prints the command cli path supplies');
 await assert.rejects(access(join(home, '.zshrc')), 'printing advice does not edit the profile');
 const fresh = await run('sh', ['-c', 'command -v rer'], lacking);
 assert.notEqual(fresh.code, 0, 'printing advice leaves the caller PATH alone');

 const redirected = join(home, 'other-zsh');
 await mkdir(redirected);
 const untouched = ['.zprofile', '.bash_profile', 'other-zsh/.zshrc'];
 for (const file of untouched) await writeFile(join(home, file), '# Keep this file intact\n');
 for (const [shell, profile] of [['zsh', '.zshrc'], ['bash', '.bashrc']]) {
  const shellEnv = { ...lacking, SHELL: `/bin/${shell}`, ZDOTDIR: redirected };
  await writeFile(join(home, profile), '# Existing settings without final newline');
  const before = await readFile(join(home, profile), 'utf8');
  const printed = await run(join(launcher, 'rer'), ['cli', 'path'], shellEnv);
  assert.equal(printed.code, 0, printed.stderr);
  assert.equal(printed.stdout.trim().split('\n').length, 1);
  assert.equal(printed.stderr, '');
  assert.equal(await readFile(join(home, profile), 'utf8'), before, 'cli path is read-only');
  const applied = await run('sh', ['-c', `${printed.stdout}rer --version`], shellEnv);
  assert.equal(applied.code, 0, applied.stderr);
  assert.equal(applied.stdout.trim(), manifest.version, 'the printed command activates this terminal');
  const once = await readFile(join(home, profile), 'utf8');
  assert.ok(once.startsWith(before), 'existing profile settings survive');
  const repeated = await run('sh', ['-c', printed.stdout], shellEnv);
  assert.equal(repeated.code, 0, repeated.stderr);
  assert.equal(await readFile(join(home, profile), 'utf8'), once, 'executing the line again does not duplicate settings');
  const newTerminal = await run('sh', ['-c', `. "$HOME/${profile}"; rer --version`], shellEnv);
  assert.equal(newTerminal.code, 0, newTerminal.stderr);
  assert.equal(newTerminal.stdout.trim(), manifest.version, 'loading the selected shell profile activates rer');
  const already = await run(join(launcher, 'rer'), ['cli', 'path'], { ...shellEnv, PATH: having.PATH });
  assert.equal(already.code, 0, already.stderr);
  assert.equal(already.stdout, printed.stdout, 'cli path still supplies the command when PATH is configured');
 }
 for (const file of untouched) assert.equal(await readFile(join(home, file), 'utf8'), '# Keep this file intact\n');
 const unknown = await run(join(launcher, 'rer'), ['cli', 'path'], { ...lacking, SHELL: '/bin/sh' });
 assert.equal(unknown.code, 0, unknown.stderr);
 const temporary = await run('sh', ['-c', `${unknown.stdout}rer --version`], lacking);
 assert.equal(temporary.code, 0, temporary.stderr);
 assert.equal(temporary.stdout.trim(), manifest.version);
 await assert.rejects(access(join(home, '.profile')), 'unknown shells receive current-session advice without another profile');
 const fish = await run(join(launcher, 'rer'), ['cli', 'path'], { ...lacking, SHELL: '/bin/fish' });
 assert.equal(fish.code, 0, fish.stderr);
 assert.equal(fish.stdout.trim().split('\n').length, 1);
 await assert.rejects(access(join(home, '.config/fish')), 'fish advice never edits configuration itself');

 // A downloaded tool uses the installer's private runtime outside a checkout.
 // The real Node stands in for the runtime download; no Node command is on PATH.
 const downloads = join(home, 'Downloads');
 await mkdir(downloads);
 await symlink(dirname(dirname(process.execPath)), join(home, '.local/share/rer/node'));
 const noNode = { HOME: home, PATH: launcher, RER_NO_UPDATE_CHECK: '1' };
 const tool = join(downloads, 'oncall-export.mjs');
 await writeFile(tool, `console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), runtime: process.execPath }));
if (process.argv.includes('--fail')) process.exit(7);
`);
 for (const command of ['node --version', 'node oncall-export.mjs pagerduty']) {
  assert.equal((await run('/bin/sh', ['-c', command], noNode, downloads)).code, 127, 'bare Node is unavailable');
 }
 const arguments_ = ['pagerduty', 'two words', '$HOME', '--', '--flag'];
 const exported = await run(join(launcher, 'rer'), ['run', '--script', './oncall-export.mjs', ...arguments_], noNode, downloads);
 assert.equal(exported.code, 0, exported.stderr);
 assert.deepEqual(JSON.parse(exported.stdout), { args: arguments_, cwd: await realpath(downloads), runtime: await realpath(process.execPath) });
 const fromElsewhere = await run(join(launcher, 'rer'), ['run', '--cwd', downloads, '--script', './oncall-export.mjs', '--fail'], noNode, directory);
 assert.equal(fromElsewhere.code, 7, 'the tool keeps its own failure status');
 assert.equal(JSON.parse(fromElsewhere.stdout).cwd, await realpath(downloads), '--cwd selects the file and working folder');
 assert.equal((await run(join(launcher, 'rer'), ['run', '--script'], noNode, downloads)).code, 2, 'a file is required');
 assert.equal((await run(join(launcher, 'rer'), ['run', '--script', './missing.mjs'], noNode, downloads)).code, 1, 'a missing tool fails visibly');
 await rm(join(home, '.local/share/rer/node'));

 // PATH already has it: nothing to add.
 const present = await run('sh', [installer, '--', 'cli', 'status'], having);
 assert.equal(present.code, 0, present.stderr);
 assert.doesNotMatch(present.stdout + present.stderr, /Required next step|export PATH=/);

 // The command's exit code passes through whether or not the step prints, and the step still prints.
 const failedMissing = await run('sh', [installer, '--', 'cli', 'nonsense'], lacking);
 const failedHaving = await run('sh', [installer, '--', 'cli', 'nonsense'], having);
 assert.equal(failedMissing.code, 2, failedMissing.stderr);
 assert.equal(failedHaving.code, 2, failedHaving.stderr);
 assert.equal(count(failedMissing.stdout, step), 1);
 assert.equal(count(failedHaving.stdout, step), 0);

 // Business connect keeps its output free of shell advice even without ~/.local/bin on PATH.
 const business = await run('sh', [installer, 'business', 'connect', '--help'], lacking);
 assert.equal(business.code, 0, business.stderr);
 assert.doesNotMatch(business.stdout + business.stderr, /Required next step|\bPATH\b/);
});
