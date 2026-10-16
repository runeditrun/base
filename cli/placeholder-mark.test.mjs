import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { exportReference } from '../scripts/export-reference.mjs';
import { fixture } from '../modules/release/test-fixture.mjs';

const base = resolve(import.meta.dirname, '..'), cli = join(base, 'bin/rer.mjs');
const placeholder = join(base, 'foundation/template/public/brand/mark.svg');
const message = "Base's placeholder mark is still in public/brand/mark.svg; replace with the seed's own mark.";
const events = result => result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const warnings = result => events(result).filter(event => event.event === 'warning' && event.code === 'placeholder_mark');

test("Base's placeholder mark warns on check and run site builds, and a release refuses it unless explicitly allowed", { timeout: 10 * 60_000 }, async t => {
 const directory = await mkdtemp(join(tmpdir(), 'rer-placeholder-mark-')), root = join(directory, 'seed');
 t.after(() => rm(directory, { recursive: true, force: true }));
 await mkdir(join(directory, 'home'));
 await exportReference(base, root);
 await symlink(join(base, 'default-seed/node_modules'), join(root, 'node_modules'), 'dir');
 const env = { PATH: process.env.PATH, HOME: join(directory, 'home'), TZ: 'UTC', CI: 'true', RER_NO_UPDATE_CHECK: '1' };
 const run = args => spawnSync(process.execPath, [cli, ...args], { cwd: root, env, encoding: 'utf8', timeout: 5 * 60_000, maxBuffer: 16 * 1024 * 1024 });
 const operationsPath = join(root, 'OPERATIONS.json'), operations = JSON.parse(await readFile(operationsPath, 'utf8'));
 const project = id => writeFile(operationsPath, JSON.stringify({ ...operations, project: id }, null, 2) + '\n');
 await project('studio/fixture');
 await cp(placeholder, join(root, 'public/brand/mark.svg'));

 // A live seed's checks and run site redeploys keep working while it carries the mark.
 for (const args of [['check', '--profile', 'first-party', '--json'], ['build', '--site', '--json', '--no-queue']]) {
  const result = run(args);
  assert.equal(result.status, 0, `${args[0]}: ${result.stdout}${result.stderr}`);
  assert.deepEqual(warnings(result).map(({ files, message }) => ({ files, message })), [{ files: ['public/brand/mark.svg'], message }], args[0]);
 }
 const human = run(['check', '--profile', 'first-party']);
 assert.equal(human.status, 0); assert.deepEqual(human.stderr.split('\n').filter(line => line.includes('placeholder')), [`Warning: ${message}`]);
 // Base's own default seed keeps Base's marks without a warning.
 await project(operations.project);
 assert.deepEqual(warnings(run(['check', '--profile', 'first-party', '--json'])), []);

 const f = fixture(t);
 await mkdir(join(f.repo, 'public/brand'), { recursive: true });
 await cp(placeholder, join(f.repo, 'public/brand/mark.svg'));
 f.commit();
 const release = (...flags) => spawnSync(process.execPath, [cli, 'release', '--repo', f.repo, '--project', 'octocat/Hello-World', '--repository', 'https://github.com/octocat/Hello-World', '--output', join(f.temporary, `release${flags.length}`), '--dry-run', '--local-verify', ...flags], { encoding: 'utf8', timeout: 5 * 60_000 });
 const refused = release();
 assert.equal(refused.status, 2);
 assert.equal(refused.stderr.trim(), `${message} Release refused; pass --allow-placeholder-mark to release with it.`);
 const allowed = release('--allow-placeholder-mark');
 assert.equal(allowed.status, 0, allowed.stdout + allowed.stderr);
 const receipt = JSON.parse(allowed.stdout);
 assert.equal(receipt.status, 'DRY_RUN');
 assert.deepEqual(receipt.placeholderMark, { allowed: true, files: ['public/brand/mark.svg'] });
 assert.deepEqual(JSON.parse(await readFile(join(f.temporary, 'release1/release-receipt.json'), 'utf8')).placeholderMark, receipt.placeholderMark);
});
