import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, copyFile, symlink, realpath } from 'node:fs/promises';
import { join, basename, dirname } from 'node:path';
import { consumer, temporary } from './helpers.mjs';

const execute = promisify(execFile);
const moduleRoot = join(import.meta.dirname, '..');
async function invoke(cli, args = []) {
  try { return { code: 0, ...await execute(process.execPath, [cli, ...args], { timeout: 60_000 }) }; }
  catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
}
test('CLI entry executes through file and directory symlinks', async t => {
  const directory = await temporary(t);
  const file = join(directory, 'cli.mjs'), folder = join(directory, 'module');
  await symlink(join(moduleRoot, 'cli.mjs'), file);
  await symlink(moduleRoot, folder, 'dir');
  for (const entry of [file, join(folder, 'cli.mjs')]) {
    const result = await invoke(entry);
    assert.equal(result.code, 1);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /^Review failed: invalid configuration or arguments\n$/);
  }
});
test('relocated temporary seed runs the copied CLI through a directory symlink', async t => {
  const directory = await temporary(t), seed = join(directory, 'seed'), alias = join(directory, 'seed-link');
  const target = join(seed, 'vendor/base/modules/review-harness');
  await mkdir(target, { recursive: true });
  const readme = await readFile(join(moduleRoot, 'README.md'), 'utf8');
  const listed = readme.match(/<!-- adoption-files -->\s*```text\n([\s\S]*?)\n```/)[1].split('\n');
  for (const file of listed) await copyFile(join(moduleRoot, basename(file)), join(target, basename(file)));
  await writeFile(join(seed, 'package.json'), '{"type":"module"}');
  for (const name of ['@playwright/test', '@axe-core/playwright']) {
    const path = join(seed, 'node_modules', name);
    await mkdir(dirname(path), { recursive: true });
    await symlink(await realpath(join(consumer, 'node_modules', name)), path);
  }
  await symlink(seed, alias, 'dir');
  const config = join(alias, 'review.config.mjs'), evidence = join(alias, 'evidence');
  // A relocated seed owns its server too; no fixture or import escapes Base's copy.
  await writeFile(join(seed, 'server.mjs'), `import { createServer } from 'node:http';
const server=createServer((_req,res)=>{res.setHeader('content-type','text/html');res.end('<!doctype html><html lang="en"><head><title>Relocated review</title></head><body><main><h1>Relocated review</h1><a href="/">Home</a></main></body></html>');});server.listen(Number(process.argv[2]),'127.0.0.1',()=>console.log('RER_READY http://127.0.0.1:'+server.address().port));`);
  await writeFile(config, `export default ${JSON.stringify({ start: { cwd: '.', command: process.execPath, args: ['server.mjs', '{PORT}'], readyTimeoutMs: 10_000 }, widths: [390], routes: [{ name: 'relocated', path: '/' }] })};`);
  const result = await invoke(join(alias, 'vendor/base/modules/review-harness/cli.mjs'), ['--config', config, '--evidence', evidence]);
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /^Review passed: 1\/1 captures; report:/);
  const report = JSON.parse(await readFile(join(evidence, 'review.json'), 'utf8'));
  assert.equal(report.passed, true);
  await assert.rejects(fetch(report.origin + '/health'));
});
