import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, copyFile, readdir, realpath, symlink } from 'node:fs/promises';
import { dirname, join, basename, resolve, relative } from 'node:path';
import { temporary, consumer, fixtureScript, root } from './helpers.mjs';

const execute = promisify(execFile);
const moduleRoot = resolve(import.meta.dirname, '..');
async function config(directory, cwd, defect = false) {
  const path = join(directory, 'review.config.mjs');
  const source = `export const start = ${JSON.stringify({ cwd, command: process.execPath, args: [fixtureScript, '--port', '{PORT}'], readyTimeoutMs: 30_000 })};
export const signIn = { email: 'reviewer@example.test', async request(page) { await page.goto('/signin'); await page.getByLabel('Email').fill('reviewer@example.test'); await page.getByRole('button', {name:'Email a sign-in link'}).click(); await page.getByRole('status').waitFor(); } };
export const fixtures = async origin => { if ((await fetch(origin+'/__fixtures/setup',{method:'POST'})).status !== 200) throw new Error('fixtures failed'); };
export const routes = ${JSON.stringify([{ name: 'sign in', path: '/signin' }, { name: 'app', path: '/app', signedIn: true }, { name: 'app again', path: '/app', signedIn: true }, ...(defect ? [{ name: 'broken', path: '/defects/page-error' }] : [])])};`;
  await writeFile(path, source);
  return path;
}
async function cli(path, configPath, evidence) {
  let output, status;
  try { output = await execute(process.execPath, [path, '--config', configPath, '--evidence', evidence], { cwd: root, timeout: 90_000 }); status = 0; }
  catch (error) { output = error; status = error.code; }
  assert.equal(output.stderr, '');
  assert.equal(output.stdout.trim().split('\n').length, 1, 'exactly one summary line');
  assert.ok(output.stdout.includes(join(evidence, 'review.json')));
  assert.equal(output.stdout.includes('token='), false);
  const report = JSON.parse(await readFile(join(evidence, 'review.json'), 'utf8'));
  // The two app routes share a real session, one sign-in per width.
  assert.deepEqual(report.captures.filter(entry => entry.name.startsWith('app')).map(entry => entry.documentStatus), [200, 200, 200, 200]);
  await assert.rejects(fetch(report.origin + '/health'), 'CLI stops its runtime');
  return { status, report };
}
test('CLI reviews every route at both widths and exits zero only for clean gates', async t => {
  const directory = await temporary(t, 'review-cli-');
  const configPath = await config(directory, consumer);
  const clean = await cli(join(moduleRoot, 'cli.mjs'), configPath, join(directory, 'clean'));
  assert.equal(clean.status, 0); assert.equal(clean.report.passed, true);
  assert.deepEqual(clean.report.totals, { captures: 6, passed: 6, failed: 0 });
  await config(directory, consumer, true);
  const broken = await cli(join(moduleRoot, 'cli.mjs'), configPath, join(directory, 'broken'));
  assert.notEqual(broken.status, 0); assert.equal(broken.report.passed, false);
  assert.deepEqual(broken.report.totals, { captures: 8, passed: 6, failed: 2 });
});
test('README adoption copies exactly the listed source into a relocated vendor folder and runs its CLI', async t => {
  const directory = await temporary(t, 'review-adoption-');
  const target = join(directory, 'vendor/base/modules/review-harness');
  const readme = await readFile(join(moduleRoot, 'README.md'), 'utf8');
  const fence = readme.match(/<!-- adoption-files -->\s*```text\n([\s\S]*?)\n```\s*<!-- \/adoption-files -->/);
  assert.ok(fence, 'the README has a machine-readable Adopting list');
  const listed = fence[1].split('\n');
  assert.equal(new Set(listed).size, listed.length);
  const actual = (await readdir(moduleRoot)).filter(file => file.endsWith('.mjs') || file.endsWith('.d.mts')).map(file => 'modules/review-harness/' + file);
  assert.deepEqual([...listed].sort(), actual.sort(), 'no needed source or declaration is omitted');
  await mkdir(target, { recursive: true });
  for (const file of listed) {
    assert.ok(file.startsWith('modules/review-harness/') && !file.includes('..'));
    await copyFile(join(root, file), join(target, basename(file)));
    assert.deepEqual(await readFile(join(target, basename(file))), await readFile(join(root, file)), 'byte-exact copy');
    const source = await readFile(join(target, basename(file)), 'utf8');
    for (const [, specifier] of source.matchAll(/(?:from\s+|import\s*\()\s*['"]([^'"]+)['"]/g)) {
      if (!specifier.startsWith('.')) { assert.ok(specifier.startsWith('node:') || specifier === '@playwright/test'); continue; }
      const imported = resolve(dirname(join(target, basename(file))), specifier);
      assert.equal(relative(target, imported).startsWith('..'), false, 'no import escapes the copied folder');
      assert.ok(listed.some(file => basename(file) === basename(imported)), 'each relative import is listed');
    }
  }
  await writeFile(join(directory, 'package.json'), JSON.stringify({ type: 'module', devDependencies: { '@playwright/test': '1.63.0', '@axe-core/playwright': '4.13.0' } }));
  for (const name of ['@playwright/test', '@axe-core/playwright']) {
    const path = join(directory, 'node_modules', name);
    await mkdir(dirname(path), { recursive: true });
    await symlink(await realpath(join(consumer, 'node_modules', name)), path);
  }
  const configPath = await config(directory, directory);
  const result = await cli(join(target, 'cli.mjs'), configPath, join(directory, 'evidence'));
  assert.equal(result.status, 0); assert.equal(result.report.passed, true);
});
