// After `install.sh ... <command>`, a later bare `rer` needs ~/.local/bin on PATH.
// Through the script's public door against a local registry serving the real
// package: the closing PATH step appears when the caller's PATH lacks the
// launcher's folder, only then, and the command's exit code is untouched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
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
 const step = /^Required next step: /gm, line = 'export PATH="$HOME/.local/bin:$PATH"';

 // PATH lacks ~/.local/bin: the same install leaves a bare rer unfound, and says so exactly once.
 const missing = await run('sh', [installer, '--', 'cli', 'status'], lacking);
 assert.equal(missing.code, 0, missing.stderr);
 assert.equal(count(missing.stdout, step), 1, missing.stdout);
 assert.equal(count(missing.stdout, /export PATH=/g), 1, 'one line to run, not several');
 assert.ok(missing.stdout.includes(line), missing.stdout);
 assert.ok(missing.stdout.includes(`${launcher} is not on your PATH`) && missing.stdout.includes(`${launcher}/rer cli path`), 'names the real home path');
 assert.ok(missing.stdout.trimEnd().endsWith('This installer changes no shell file.'), 'the step closes the output');
 assert.doesNotMatch(missing.stdout, /Optional/, 'no second, conflicting instruction');
 const fresh = await run('sh', ['-c', 'command -v rer'], lacking);
 assert.notEqual(fresh.code, 0, 'a fresh shell still lacks rer, so the step is what makes it work');
 assert.equal((await run('sh', ['-c', `${line}\nrer --version`], lacking)).stdout.trim(), manifest.version, 'the printed line makes bare rer work');
 const path = await run('sh', ['-c', `"${launcher}/rer" cli path`], lacking);
 assert.equal(path.code, 0, path.stderr);
 assert.ok(path.stdout.includes(line.replace('$HOME', '~')) || path.stdout.includes('.zshrc'), 'cli path shows the line to run');
 assert.doesNotMatch(path.stdout, /Optional/, 'cli path does not call the step optional either');

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
